// @ts-nocheck — VERBATIM port from WIES Studio (wies-app/src/lib/photometry.ts).
// Kept byte-for-byte with the validated WIES source (its numbers are the
// contract; correctness is pinned by ies/photometry.test.ts). This repo enables
// `noUncheckedIndexedAccess`, which WIES's tsconfig does not; the ~150 resulting
// diagnostics are all bounded-array index accesses inside the compute kernels.
// Suppressing at file scope preserves the port verbatim (zero behavioral change)
// rather than scattering 150+ non-null assertions through validated math. The
// exported function signatures + all IES/metric types (ies/types.ts) remain
// fully type-checked, so every call site is still checked normally.
/* ────────────────────────────────────────────────────────────
   Photometric calculations for WIES MVP
   - Total luminaire lumens via solid-angle integration
   - Beam / field angles (10% / 50% of peak per IES convention)
   - Zonal lumens & BUG (TM-15 simplified for downward Type C)
   - UGR (CIE 117 standard 4H × 8H room, single luminaire)
   - Isolux grid (Type C, point-source approximation)
   - Cumulative zonal-lumen summary (LM-79 / AGi32 style)
   - Cone-of-light / CBCP table (per-mounting-height)
   - Coefficient of utilization (zonal-cavity)
   - Luminance at standard viewing angles

   Units: candela arrays are in cd; angles in degrees throughout
   inputs, converted to radians at integration time. Distances are
   in metres unless explicitly noted.

   Conventions from PRD §5.1: IES sample is Type C, 181×17, full
   0–360° horizontal sweep. Math here works for that grid. For other
   grids, BUG/UGR fall back to "hidden" via metricsAvailable().
   ──────────────────────────────────────────────────────────── */

import type {
  BUGResult,
  BeamAngles,
  CUTable,
  ConeOfLightRow,
  CumulativeZoneRow,
  IESParseResult,
  IsoluxGrid,
  LuminanceTable,
  LuminousOpening,
  LuminousShape,
  RoomInputs,
  SpacingCriterion,
  UGRResult,
  UGRTableRefl,
  UGRTableResult,
  UGRTableRow,
  ZonalLumens,
} from "./types.js";
import { M_PER_FT } from "./units.js";

const DEG = Math.PI / 180;

/** Module-level threshold for "the candela curve has effectively
 *  decayed to zero at angle X." Used today by the I_PARTIAL_V
 *  boundary-decay suppression in `ies-parser.ts` (a 0°–90° Type C
 *  file whose max boundary candela across all H planes is below this
 *  fraction of the global peak is treated as a clean cut-off, not a
 *  data gap). Reserved for any future "is this curve effectively
 *  zero at angle X" check (e.g. cone-of-light cropping).
 *
 *  Lives in `photometry.ts` rather than `ies-parser.ts` because its
 *  conceptual home is "judgments about distribution shape," not
 *  parsing — `photometry.ts` never imports from `ies-parser.ts`, so
 *  the parser can pull this constant in without creating a cycle. */
export const BOUNDARY_DECAY_THRESHOLD = 0.01;

/* ── luminous opening (LM-63-19 §5.10 + §5.11 + Annex D) ───── */

/** Sample count for the uniform Type-C φ-quadrature on smooth periodic
 *  integrands (vertical ellipsoidal cylinder, triaxial ellipsoid).
 *  N=16 is well into the spectral-convergence regime for these — the
 *  validator audit at θ ∈ {0, π/4, π/2} pins the residual error under
 *  0.1 %. Shapes with corner integrands (box, vertical circle facing
 *  PH) bypass quadrature entirely via their closed-form Type-C means;
 *  horizontal cylinders use the higher N below because their side
 *  integrand becomes near-singular as θ → π/2. */
const LUMINOUS_PHI_N = 16;

/** Sample count for the smooth-side φ-quadrature on horizontal
 *  cylinders. The side integrand √(H²·sin²θ·sin²φ + W²·cos²θ) is
 *  smooth wherever cos²θ > 0 but its curvature blows up as θ → π/2,
 *  where the √-argument approaches H²·sin²φ (a corner integrand). The
 *  N=16 regime hits ~1.0 % bias at θ = π/2; N=64 cuts that to ~0.08 %,
 *  well under the validator's 0.1 % tolerance. The cap term uses the
 *  exact closed-form Type-C mean either way. */
const HORIZONTAL_CYL_PHI_N = 64;

/** Tolerance (metres) below which a magnitude is treated as zero
 *  when decoding the LM-63-19 §5.11 sign convention. Anything below
 *  this is "the field was 0", anything above is a real dimension. */
const LUMINOUS_EPS = 1e-9;

/** Decode LM-63-19 §5.10 (units type), §5.11 (sign convention), and
 *  Table 1 (15 shape rows) into a single normalised descriptor. The
 *  parser populates `IESParseResult.luminousOpening` with the result;
 *  the UGR kernel and luminance table consume it directly. */
export function luminousOpening(ies: IESParseResult): LuminousOpening {
  // §5.10.1: unitsType 1 = feet, 2 = metres. Convert once at entry so
  // every magnitude downstream is in metres.
  const unitFactor = ies.unitsType === 1 ? M_PER_FT : 1;
  const wRaw = (Number.isFinite(ies.width) ? ies.width : 0) * unitFactor;
  const lRaw = (Number.isFinite(ies.length) ? ies.length : 0) * unitFactor;
  const hRaw = (Number.isFinite(ies.height) ? ies.height : 0) * unitFactor;

  // §5.11: positive magnitude = rectangular in that plane; negative
  // = rounded. Take |·| for the actual magnitude; route to a shape
  // branch by the sign / zero pattern of the three fields.
  const widthM = Math.abs(wRaw);
  const lengthM = Math.abs(lRaw);
  const heightM = Math.abs(hRaw);
  const wNeg = wRaw < -LUMINOUS_EPS;
  const lNeg = lRaw < -LUMINOUS_EPS;
  const hNeg = hRaw < -LUMINOUS_EPS;
  const wZero = widthM < LUMINOUS_EPS;
  const lZero = lengthM < LUMINOUS_EPS;
  const hZero = heightM < LUMINOUS_EPS;

  const classified = classifyShape(
    wNeg, lNeg, hNeg, wZero, lZero, hZero,
  );
  const shape: LuminousShape = classified ?? "rectangular";
  const recognized = classified !== null;

  const bottomAreaM2 = bottomAreaFor(shape, widthM, lengthM, heightM);

  // φ-invariance lets us skip the Simpson loop. Per Table 1:
  //   - point / rectangular flat / circular flat: always φ-invariant
  //   - vertical cylinder: φ-invariant iff W = L (i.e. circular cross
  //     section, not ellipsoidal)
  //   - sphere: φ-invariant iff W = L (the formula collapses regardless
  //     of H; the silhouette is rotationally symmetric around the z
  //     axis whenever the two horizontal semi-axes match)
  //   - everything else (box, horizontal cylinders, vertical circle
  //     facing PH): φ-dependent — always use Simpson.
  const wlEq = Math.abs(widthM - lengthM) < LUMINOUS_EPS;
  const phiInvariant =
    shape === "point" ||
    shape === "rectangular" ||
    shape === "circular" ||
    (shape === "vertical-cylinder" && wlEq) ||
    (shape === "sphere" && wlEq);

  const projectedAreaAtTheta = (thetaRad: number): number => {
    const cosT = Math.cos(thetaRad);
    const sinT = Math.sin(thetaRad);
    const aCosT = Math.abs(cosT);
    const aSinT = Math.abs(sinT);

    // Closed-form Type-C means for the shapes whose silhouette has a
    // |sin φ| / |cos φ| corner integrand. The corner integrand only
    // achieves O(1/N²) convergence under uniform N-point φ-quadrature
    // (~1.3 % bias at N=16), so we exploit the known Type-C means
    // <|sin φ|>_φ = <|cos φ|>_φ = 2/π and collapse the corner term
    // analytically. The smooth-integrand shapes below still use N=16
    // Simpson — smooth periodic integrands converge spectrally so the
    // bias is well under 0.1 %.
    switch (shape) {
      case "point":
        return 0;
      case "rectangular":
        return widthM * lengthM * aCosT;
      case "circular":
        return (Math.PI * widthM * lengthM / 4) * aCosT;
      case "rectangular-with-sides":
        // EXACT Type-C mean of the box silhouette:
        //   <A>_φ = W·L·|cos θ| + H·|sin θ|·(L·<|sin φ|> + W·<|cos φ|>)
        //         = W·L·|cos θ| + (2(W+L)/π)·H·|sin θ|.
        return widthM * lengthM * aCosT
          + (2 * (widthM + lengthM) / Math.PI) * heightM * aSinT;
      case "vertical-circle-facing-ph":
        // EXACT Type-C mean of (π·W·H/4)·|sin θ cos φ|:
        //   (π·W·H/4)·(2/π)·|sin θ| = (W·H/2)·|sin θ|.
        return (widthM * heightM / 2) * aSinT;
      case "horizontal-cylinder-along-ph": {
        // EXACT closed form for the cap term; N=64 trapezoid for the
        // side (smooth wherever cos²θ > 0 but near-singular as
        // θ → π/2, where the √-argument approaches H²·sin²φ — see the
        // HORIZONTAL_CYL_PHI_N comment for the choice of N).
        const cap = (widthM * heightM / 2) * aSinT;
        let sideMean = 0;
        for (let k = 0; k < HORIZONTAL_CYL_PHI_N; k++) {
          const phi = (2 * Math.PI * k) / HORIZONTAL_CYL_PHI_N;
          const sinP = Math.sin(phi);
          sideMean += Math.sqrt(
            heightM * heightM * sinT * sinT * sinP * sinP
            + widthM * widthM * cosT * cosT,
          );
        }
        sideMean /= HORIZONTAL_CYL_PHI_N;
        return cap + lengthM * sideMean;
      }
      case "horizontal-cylinder-perp-ph": {
        // Symmetric counterpart of the along-PH branch with x ↔ y.
        const cap = (lengthM * heightM / 2) * aSinT;
        let sideMean = 0;
        for (let k = 0; k < HORIZONTAL_CYL_PHI_N; k++) {
          const phi = (2 * Math.PI * k) / HORIZONTAL_CYL_PHI_N;
          const cosP = Math.cos(phi);
          sideMean += Math.sqrt(
            heightM * heightM * sinT * sinT * cosP * cosP
            + lengthM * lengthM * cosT * cosT,
          );
        }
        sideMean /= HORIZONTAL_CYL_PHI_N;
        return cap + widthM * sideMean;
      }
      case "vertical-cylinder":
      case "sphere": {
        if (phiInvariant) {
          // W = L collapses both shapes to a φ-invariant closed form
          // (cylinder bottom + side rectangle; ellipsoid silhouette).
          return silhouetteAtThetaPhi(shape, widthM, lengthM, heightM, thetaRad, 0);
        }
        // Smooth periodic integrand — N=16 Simpson converges
        // spectrally (validator audit confirms < 0.1 %).
        let sum = 0;
        for (let k = 0; k < LUMINOUS_PHI_N; k++) {
          const phi = (2 * Math.PI * k) / LUMINOUS_PHI_N;
          sum += silhouetteAtThetaPhi(shape, widthM, lengthM, heightM, thetaRad, phi);
        }
        return sum / LUMINOUS_PHI_N;
      }
    }
  };

  return {
    shape,
    widthM,
    lengthM,
    heightM,
    bottomAreaM2,
    recognized,
    projectedAreaAtTheta,
  };
}

/** Map the (sign, zero) pattern of (W, L, H) to a Table 1 shape row.
 *  Returns `null` for exotic patterns that don't match any of the 15
 *  rows — the caller substitutes a rectangular default and the parser
 *  surfaces a `W_LUMINOUS_SHAPE` warning. */
function classifyShape(
  wNeg: boolean, lNeg: boolean, hNeg: boolean,
  wZero: boolean, lZero: boolean, hZero: boolean,
): LuminousShape | null {
  if (wZero && lZero && hZero) return "point";
  if (!wNeg && !wZero && !lNeg && !lZero && hZero) return "rectangular";
  if (!wNeg && !wZero && !lNeg && !lZero && !hZero && !hNeg) return "rectangular-with-sides";
  if (wNeg && lNeg && hZero) return "circular";
  if (wNeg && lNeg && !hZero && !hNeg) return "vertical-cylinder";
  if (wNeg && lNeg && hNeg) return "sphere";
  if (wNeg && !lNeg && !lZero && hNeg) return "horizontal-cylinder-along-ph";
  if (!wNeg && !wZero && lNeg && hNeg) return "horizontal-cylinder-perp-ph";
  if (wNeg && lZero && hNeg) return "vertical-circle-facing-ph";
  return null;
}

/** Bottom-face projection area (= `projectedAreaAtTheta(0)`) for each
 *  Table 1 shape. Closed form per shape; the per-(θ, φ) silhouette
 *  formula collapses to the same value at θ = 0 (verified by the
 *  per-shape regression cases in `_validate-ugr-scene.mts`). */
function bottomAreaFor(shape: LuminousShape, W: number, L: number, H: number): number {
  switch (shape) {
    case "point": return 0;
    case "rectangular":
    case "rectangular-with-sides":
      return W * L;
    case "circular":
    case "vertical-cylinder":
    case "sphere":
      return (Math.PI * W * L) / 4;
    case "horizontal-cylinder-along-ph":
    case "horizontal-cylinder-perp-ph":
      return W * L;
    case "vertical-circle-facing-ph":
      return 0;
  }
  // Suppress "not all paths return" — exhaustive switch above.
  void H;
  return 0;
}

/** Per-(θ, φ) convex-body silhouette area for each Table 1 shape,
 *  derived from `Silhouette = (1/2) · ∫_∂K |n · n̂(x)| dA`. Inputs are
 *  positive magnitudes in metres; θ is radians from nadir; φ is
 *  azimuth measured from photometric horizontal around the +z axis.
 *  Coordinate convention (matching §5.10): L along +x (photometric
 *  horizontal), W along +y (perpendicular to 0° plane), H along +z
 *  (vertical). */
function silhouetteAtThetaPhi(
  shape: LuminousShape,
  W: number, L: number, H: number,
  theta: number, phi: number,
): number {
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const aCosT = Math.abs(cosT);
  const aSinT = Math.abs(sinT);
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);

  switch (shape) {
    case "point":
      return 0;

    case "rectangular":
      // EXACT: a flat rectangle in the x-y plane projects with area
      // W·L·|cos θ| regardless of φ (the projection plane is parallel
      // to the rectangle when θ = 0, edge-on when θ = π/2).
      return W * L * aCosT;

    case "rectangular-with-sides": {
      // EXACT silhouette of the convex box: sum over face pairs of
      // |n · n̂_face| · A_face. The three face pairs have areas W·L
      // (top/bottom, normal ±ẑ), L·H (±ŷ), W·H (±x̂).
      // Type-C closed form (verified by N=16 ≈ N=64 audit):
      //   W·L·|cos θ| + (2(W+L)/π)·H·|sin θ|.
      return W * L * aCosT + H * aSinT * (L * Math.abs(sinP) + W * Math.abs(cosP));
    }

    case "circular":
      // EXACT: flat circular / elliptical disc in the x-y plane.
      // (π·W·L/4)·|cos θ|, φ-invariant.
      return (Math.PI * W * L / 4) * aCosT;

    case "vertical-cylinder": {
      // EXACT silhouette of a (possibly elliptical) vertical cylinder:
      // bottom-disc contribution (π·W·L/4)·|cos θ| (flat ellipse in
      // the x-y plane → cos-projection) plus side-wall contribution
      // H·|sin θ| · (projected diameter of the cross-section ellipse
      // along the line perpendicular to the viewing azimuth). For
      // W = L = D this is φ-invariant: (π·D²/4)·|cos θ| + D·H·|sin θ|.
      const apparentWidth = Math.sqrt(L * L * cosP * cosP + W * W * sinP * sinP);
      return (Math.PI * W * L / 4) * aCosT + H * aSinT * apparentWidth;
    }

    case "sphere": {
      // EXACT silhouette of a triaxial ellipsoid viewed from direction
      // n = (sin θ cos φ, sin θ sin φ, cos θ):
      //   A = π · √(a²b² n_z² + b²c² n_x² + a²c² n_y²)
      // where (a, b, c) = (W/2, L/2, H/2) are the principal semi-axes.
      // Reference: Vickers G., "The projected areas of ellipsoids and
      // cylinders", Powder Technology 86 (1996), 195–200.
      // Collapses to π·(D/2)² = π·W·L/4 for a true sphere (W=L=H=D)
      // and is φ-invariant whenever W = L.
      const ab = (W * L) / 4;
      const bc = (L * H) / 4;
      const ac = (W * H) / 4;
      return Math.PI * Math.sqrt(
        ab * ab * cosT * cosT
        + bc * bc * sinT * sinT * cosP * cosP
        + ac * ac * sinT * sinT * sinP * sinP,
      );
    }

    case "horizontal-cylinder-along-ph": {
      // EXACT silhouette of a finite cylinder whose axis is +x̂
      // (photometric horizontal), length L, cross-section ellipse
      // with semi-axes W/2 (along y) and H/2 (along z). Parametrising
      // the side as (s, (W/2)cos t, (H/2)sin t) makes the outward
      // normal normaliser and the surface speed each carry
      // √(H² cos²t + W² sin²t) — they cancel cleanly, so the side
      // integral reduces to ∫ |H·sin θ·sin φ · cos t + W·cos θ · sin t|
      // dt = 4·√(H²·sin²θ·sin²φ + W²·cos²θ), giving the closed form
      // below. Two end-cap ellipses (area π·W·H/4, normal ±x̂)
      // contribute the cap term. Collapses to row 9 (W = H = D)
      // form: (π·D²/4)·|sin θ cos φ| + L·D·√(1 − sin²θ cos²φ).
      const cap = (Math.PI * W * H / 4) * Math.abs(sinT * cosP);
      const side = L * Math.sqrt(
        H * H * sinT * sinT * sinP * sinP + W * W * cosT * cosT,
      );
      return cap + side;
    }

    case "horizontal-cylinder-perp-ph": {
      // EXACT silhouette of a cylinder whose axis is +ŷ (perpendicular
      // to photometric horizontal), length W, cross-section ellipse
      // with semi-axes L/2 (along x) and H/2 (along z). Symmetric
      // counterpart of the along-PH case with x ↔ y swapped.
      const cap = (Math.PI * L * H / 4) * Math.abs(sinT * sinP);
      const side = W * Math.sqrt(
        H * H * sinT * sinT * cosP * cosP + L * L * cosT * cosT,
      );
      return cap + side;
    }

    case "vertical-circle-facing-ph": {
      // EXACT silhouette of a flat ellipse with normal +x̂, semi-axes
      // W/2 (along y) and H/2 (along z): area · |n · x̂|.
      // (π·W·H/4)·|sin θ cos φ|. Type-C φ-mean of |cos φ| is 2/π, so
      // the closed-form Type-C average is (W·H/2)·|sin θ| — validator
      // asserts the N=16 quadrature matches this within 0.1 %.
      return (Math.PI * W * H / 4) * Math.abs(sinT * cosP);
    }
  }
}

/** Lookup candela by horizontal-plane index and vertical-angle index. */
function cd(ies: IESParseResult, h: number, v: number): number {
  return ies.candela[h]?.[v] ?? 0;
}

/** Get candela at an arbitrary (vDeg, hDeg) by bilinear interpolation
 *  on the angle grid. Hugs index convention; assumes monotonic angle
 *  arrays (true for the WAC sample).
 *
 *  Honours the LM-63 horizontal-symmetry convention: a file storing
 *  only horizontal angles 0..90° represents a 4-fold symmetric
 *  distribution; 0..180° is bilaterally symmetric; 0..360° is the
 *  full distribution; and a single plane (numH = 1) is axially
 *  symmetric. For all symmetric subsets we mirror/wrap the requested
 *  hDeg back into the file's stored range. */
export function candelaAt(ies: IESParseResult, vDeg: number, hDeg: number): number {
  const { vAngles, hAngles } = ies;
  if (vAngles.length === 0 || hAngles.length === 0) return 0;

  const vMin = vAngles[0];
  const vMax = vAngles[vAngles.length - 1];
  // LM-63 §5.15 permits partial vertical ranges (e.g. downlight-only
  // V 0..90, uplight-only V 90..180). Outside the stored range there
  // is no measured emission — return 0 instead of clamping, which
  // would otherwise smear the endpoint value across the missing
  // hemisphere. EPS lets endpoint queries (exactly vMin / vMax) still
  // hit the grid.
  const EPS = 1e-6;
  if (vDeg < vMin - EPS || vDeg > vMax + EPS) return 0;
  if (vDeg < vMin) vDeg = vMin;
  if (vDeg > vMax) vDeg = vMax;

  // Axially symmetric: the single horizontal plane represents the full
  // distribution at every phi. Skip horizontal interpolation entirely.
  if (hAngles.length === 1) {
    const i1 = upperIndex(vAngles, vDeg);
    const i0 = i1 === 0 ? 0 : i1 - 1;
    const v0 = vAngles[i0];
    const v1 = vAngles[i1];
    const tv = v1 === v0 ? 0 : (vDeg - v0) / (v1 - v0);
    const c0 = cd(ies, 0, i0);
    const c1 = cd(ies, 0, i1);
    return c0 * (1 - tv) + c1 * tv;
  }

  const hMin = hAngles[0];
  const hMax = hAngles[hAngles.length - 1];
  const hSpan = hMax - hMin;
  let h = hDeg;
  if (hSpan >= 360 - 0.01) {
    h = ((hDeg - hMin) % 360 + 360) % 360 + hMin;
  } else if (hSpan > 0.01) {
    // Symmetric subset: wrap into the file's [0, 2·hSpan) period and
    // reflect anything past hSpan back into range. This covers the
    // bilaterally symmetric (hSpan = 180°) and quadrant-symmetric
    // (hSpan = 90°) IES conventions, plus any other partial sweep.
    const period = 2 * hSpan;
    let x = ((hDeg - hMin) % period + period) % period;
    if (x > hSpan) x = period - x;
    h = x + hMin;
  } else {
    if (h < hMin) h = hMin;
    if (h > hMax) h = hMax;
  }

  const i1 = upperIndex(vAngles, vDeg);
  const i0 = i1 === 0 ? 0 : i1 - 1;
  const j1 = upperIndex(hAngles, h);
  const j0 = j1 === 0 ? 0 : j1 - 1;

  const v0 = vAngles[i0];
  const v1 = vAngles[i1];
  const h0 = hAngles[j0];
  const h1 = hAngles[j1];

  const tv = v1 === v0 ? 0 : (vDeg - v0) / (v1 - v0);
  const th = h1 === h0 ? 0 : (h - h0) / (h1 - h0);

  const c00 = cd(ies, j0, i0);
  const c01 = cd(ies, j0, i1);
  const c10 = cd(ies, j1, i0);
  const c11 = cd(ies, j1, i1);

  const a = c00 * (1 - tv) + c01 * tv;
  const b = c10 * (1 - tv) + c11 * tv;
  return a * (1 - th) + b * th;
}

function upperIndex(arr: number[], x: number): number {
  // smallest index i such that arr[i] >= x
  let lo = 0, hi = arr.length - 1;
  if (x <= arr[0]) return 0;
  if (x >= arr[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ── derived: max candela & angles ───────────────────────── */

export function beamAngles(ies: IESParseResult): BeamAngles {
  const { vAngles, hAngles, candela } = ies;
  if (!vAngles.length || !hAngles.length) {
    return {
      beamAngle: null,
      fieldAngle: null,
      beamC0: null,
      beamC90: null,
      fieldC0: null,
      fieldC90: null,
      maxCandela: 0,
      maxAngle: 0,
      maxHorizontal: 0,
    };
  }

  let maxC = 0;
  let maxV = vAngles[0];
  let maxH = hAngles[0];
  for (let h = 0; h < candela.length; h++) {
    for (let v = 0; v < candela[h].length; v++) {
      const val = candela[h][v];
      if (val > maxC) {
        maxC = val;
        maxV = vAngles[v];
        maxH = hAngles[h];
      }
    }
  }

  // Per IES / LM-79 convention beam (50% of peak crossing) and field
  // (10%) are computed PER PLANE against that plane's own peak — not
  // the global peak, which for slightly asymmetric distributions can
  // sit in a different plane and produce a misleadingly wide crossing
  // in the chosen curve.
  //
  // LM-63 single-plane file (numH === 1) is axisymmetric by spec: the
  // one stored plane is the full distribution at every phi. We
  // deliberately surface C0 = C90 in that case so every UI renders
  // "40° × 40°" without a hidden branch downstream.
  const c0Idx = nearestPlane(hAngles, 0);
  const c90Idx = hAngles.length === 1 ? c0Idx : nearestPlane(hAngles, 90);

  const planeAngles = (idx: number): { beam: number | null; field: number | null } => {
    if (idx < 0) return { beam: null, field: null };
    const curve = candela[idx] ?? [];
    let peak = 0;
    for (let v = 0; v < curve.length; v++) {
      if (curve[v] > peak) peak = curve[v];
    }
    if (peak <= 0) return { beam: null, field: null };
    const half50 = crossingAngle(vAngles, curve, peak * 0.5);
    const half10 = crossingAngle(vAngles, curve, peak * 0.1);
    return {
      beam: half50 != null ? half50 * 2 : null,
      field: half10 != null ? half10 * 2 : null,
    };
  };

  const c0 = planeAngles(c0Idx);
  const c90 = planeAngles(c90Idx);

  return {
    // Back-compat aliases: keep the principal-plane (C0) values
    // available under the legacy field names so any reader not yet
    // migrated to the dual-axis fields keeps producing today's
    // numbers exactly.
    beamAngle: c0.beam,
    fieldAngle: c0.field,
    beamC0: c0.beam,
    beamC90: c90.beam,
    fieldC0: c0.field,
    fieldC90: c90.field,
    maxCandela: maxC,
    maxAngle: maxV,
    maxHorizontal: maxH,
  };
}

/* ── spacing criterion (S/MH ratio) ──────────────────────── */

/** Spacing criterion S/MH = 2 · tan(θ50) where θ50 is the half-angle
 *  from nadir at which candela drops to 50 % of the per-plane peak.
 *  Computed independently in the 0° and 90° planes (when both exist)
 *  so spec sheets can carry both numbers. */
export function spacingCriterion(ies: IESParseResult): SpacingCriterion {
  const planes = [0, 90];
  const out: { plane0: number | null; plane90: number | null } = {
    plane0: null,
    plane90: null,
  };
  for (const plane of planes) {
    const idx = nearestPlane(ies.hAngles, plane);
    if (idx < 0) continue;
    const curve = ies.candela[idx];
    if (!curve || curve.length === 0) continue;
    let peak = 0;
    for (const c of curve) if (c > peak) peak = c;
    if (peak <= 0) continue;
    const halfAngle = crossingAngle(ies.vAngles, curve, peak * 0.5);
    if (halfAngle == null) continue;
    const sc = 2 * Math.tan(halfAngle * DEG);
    if (plane === 0) out.plane0 = sc;
    else out.plane90 = sc;
  }

  const present = [out.plane0, out.plane90].filter(
    (v): v is number => v != null && Number.isFinite(v),
  );
  const average = present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
  const symmetric =
    out.plane0 != null && out.plane90 != null
      ? Math.abs(out.plane0 - out.plane90) / Math.max(out.plane0, out.plane90) < 0.05
      : true;

  return { plane0: out.plane0, plane90: out.plane90, average, symmetric };
}

function nearestPlane(hAngles: number[], target: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < hAngles.length; i++) {
    const d = Math.abs(hAngles[i] - target);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Find the smallest vertical angle (degrees, from nadir) at which
 *  the curve drops below `threshold`. Returns null when no crossing. */
function crossingAngle(vAngles: number[], curve: number[], threshold: number): number | null {
  for (let i = 1; i < curve.length; i++) {
    if (curve[i - 1] >= threshold && curve[i] < threshold) {
      const dv = vAngles[i] - vAngles[i - 1];
      const dc = curve[i] - curve[i - 1];
      const t = dc === 0 ? 0 : (threshold - curve[i - 1]) / dc;
      return vAngles[i - 1] + t * dv;
    }
  }
  return null;
}

/* ── zonal lumen integration (Type C) ────────────────────── */

/** For Type C, integrate I(theta, phi) sin(theta) dtheta dphi over
 *  the requested vertical band [v0Deg, v1Deg], averaging horizontals.
 *  Implementation: trapezoidal in theta, simple mean in phi.
 *
 *  Honours the LM-63 horizontal-symmetry convention: a file storing
 *  only horizontal angles 0..90° (4-fold symmetric) or 0..180°
 *  (bilaterally symmetric) or a single plane (axially symmetric)
 *  represents the *full* distribution implicitly. The mean candela
 *  over the stored range therefore equals the mean over the full
 *  circle, so we always multiply by 2π. */
function zonalLumens(ies: IESParseResult, v0Deg: number, v1Deg: number): number {
  const { vAngles, hAngles, candela } = ies;
  if (vAngles.length === 0 || hAngles.length === 0) return 0;
  const hSpan = (hAngles[hAngles.length - 1] - hAngles[0]) * DEG;
  // Build the average candela curve over phi (per vertical angle).
  // For numH = 1 (axially symmetric) the single plane already IS the
  // mean; for symmetric subsets the mean over the stored range equals
  // the mean over the full circle by the LM-63 symmetry convention.
  const avgPhi = new Array<number>(vAngles.length).fill(0);
  for (let v = 0; v < vAngles.length; v++) {
    if (hAngles.length === 1) {
      avgPhi[v] = candela[0]?.[v] ?? 0;
      continue;
    }
    let area = 0;
    for (let h = 0; h < hAngles.length - 1; h++) {
      const dPhi = (hAngles[h + 1] - hAngles[h]) * DEG;
      area += 0.5 * (candela[h][v] + candela[h + 1][v]) * dPhi;
    }
    avgPhi[v] = hSpan > 0 ? area / hSpan : candela[0]?.[v] ?? 0;
  }

  // Theta integration over the vertical band.
  let lumens = 0;
  for (let v = 0; v < vAngles.length - 1; v++) {
    const t0 = vAngles[v];
    const t1 = vAngles[v + 1];
    if (t1 <= v0Deg || t0 >= v1Deg) continue;
    const tA = Math.max(t0, v0Deg);
    const tB = Math.min(t1, v1Deg);
    const span = (t1 - t0) * DEG;
    if (span === 0) continue;
    const cA = lerp(candela, v, t0, t1, tA, "phiAvg", avgPhi);
    const cB = lerp(candela, v, t0, t1, tB, "phiAvg", avgPhi);
    const sinA = Math.sin(tA * DEG);
    const sinB = Math.sin(tB * DEG);
    const dt = (tB - tA) * DEG;
    lumens += 0.5 * (cA * sinA + cB * sinB) * dt * 2 * Math.PI;
  }
  return lumens;
}

function lerp(
  _candela: number[][],
  v: number,
  t0: number,
  t1: number,
  t: number,
  _mode: "phiAvg",
  avgPhi: number[],
): number {
  if (t1 === t0) return avgPhi[v];
  const f = (t - t0) / (t1 - t0);
  return avgPhi[v] * (1 - f) + avgPhi[v + 1] * f;
}

export function zonalSummary(ies: IESParseResult): ZonalLumens {
  const downward = zonalLumens(ies, 0, 90);
  const upward = zonalLumens(ies, 90, 180);
  return { total: downward + upward, downward, upward };
}

/** Integrate luminous flux over an azimuth sector [phi0Deg, phi1Deg]
 *  combined with a vertical band [v0Deg, v1Deg]. Used by TM-15 to split
 *  the back (90..270°) from the front (0..90° ∪ 270..360°) hemisphere.
 *
 *  Implementation: midpoint rule over a fine grid (≈0.5° vertical ×
 *  1° azimuth) sampled through `candelaAt()`, which already honours
 *  the LM-63 horizontal-symmetry conventions (numH = 1, 0..90,
 *  0..180, 0..360). For axisymmetric files the integrand is constant
 *  in φ, so the result reduces to (phi-span/360) · zonalLumens(...).
 */
function zonalLumensSector(
  ies: IESParseResult,
  v0Deg: number,
  v1Deg: number,
  phi0Deg: number,
  phi1Deg: number,
): number {
  if (v1Deg <= v0Deg || phi1Deg <= phi0Deg) return 0;
  const vSpan = v1Deg - v0Deg;
  const phiSpan = phi1Deg - phi0Deg;
  const nv = Math.max(8, Math.ceil(vSpan / 0.5));
  const nphi = Math.max(8, Math.ceil(phiSpan / 1.0));
  const dV = vSpan / nv;
  const dPhi = phiSpan / nphi;
  const dt = dV * DEG;
  const dp = dPhi * DEG;
  let lumens = 0;
  for (let i = 0; i < nv; i++) {
    const v = v0Deg + (i + 0.5) * dV;
    const sinT = Math.sin(v * DEG);
    for (let j = 0; j < nphi; j++) {
      const phi = phi0Deg + (j + 0.5) * dPhi;
      const I = candelaAt(ies, v, phi);
      lumens += I * sinT * dt * dp;
    }
  }
  return lumens;
}

/** Convenience: front hemisphere is [0..90] ∪ [270..360]. */
function zonalLumensFront(ies: IESParseResult, v0Deg: number, v1Deg: number): number {
  return (
    zonalLumensSector(ies, v0Deg, v1Deg, 0, 90) +
    zonalLumensSector(ies, v0Deg, v1Deg, 270, 360)
  );
}

/** Convenience: back hemisphere is [90..270]. */
function zonalLumensBack(ies: IESParseResult, v0Deg: number, v1Deg: number): number {
  return zonalLumensSector(ies, v0Deg, v1Deg, 90, 270);
}

/* ── BUG (IES TM-15) ─────────────────────────────────────── */

/** TM-15 BUG (Backlight / Uplight / Glare) zonal classification.
 *
 *  Per IES TM-15-11:
 *    Backlight zones (BL / BM / BH / BVH) integrate flux only in the
 *      back hemisphere, 90° ≤ φ ≤ 270°.
 *    Forward zones (FL / FM / FH / FVH) integrate flux only in the
 *      front hemisphere, 0° ≤ φ < 90° ∪ 270° < φ ≤ 360°.
 *    Uplight zones (UL / UH) integrate over the full 360° azimuth.
 *
 *  Vertical bands (from nadir): 0-30 / 30-60 / 60-80 / 80-90 for the
 *  B and F families; 90-100 / 100-180 for U.
 *
 *  Final rating: B/U/G are each the maximum per-zone rating in their
 *  family. The G (glare) rating is computed against FH, FVH, BH, BVH
 *  separately — not a sum of front-and-back.
 */
export function computeBUG(ies: IESParseResult): BUGResult {
  const FL = zonalLumensFront(ies, 0, 30);
  const FM = zonalLumensFront(ies, 30, 60);
  const FH = zonalLumensFront(ies, 60, 80);
  const FVH = zonalLumensFront(ies, 80, 90);
  const BL = zonalLumensBack(ies, 0, 30);
  const BM = zonalLumensBack(ies, 30, 60);
  const BH = zonalLumensBack(ies, 60, 80);
  const BVH = zonalLumensBack(ies, 80, 90);
  const UL = zonalLumens(ies, 90, 100);
  const UH = zonalLumens(ies, 100, 180);

  // TM-15-11 threshold tables (lumens). Six thresholds → ratings 0..6
  // (rating = lowest index k where value ≤ thresholds[k]; > all → 6).
  const B_THRESH = [
    { v: BL,  t: [110, 500, 1000, 2500, 5000, 8500] },
    { v: BM,  t: [50,  250, 500,  1000, 2500, 5000] },
    { v: BH,  t: [8.5, 50,  150,  500,  1000, 2500] },
    { v: BVH, t: [3.22, 15, 50,   150,  500,  1000] },
  ];
  const U_THRESH = [
    { v: UL, t: [10, 50, 500, 1000, 2500, 5000] },
    { v: UH, t: [10, 50, 500, 1000, 2500, 5000] },
  ];
  const G_THRESH = [
    { v: FH,  t: [10, 100, 225, 500, 750, 1500] },
    { v: FVH, t: [10, 100, 225, 500, 750, 1500] },
    { v: BH,  t: [10, 100, 225, 500, 750, 1500] },
    { v: BVH, t: [10, 100, 225, 500, 750, 1500] },
  ];

  function ratingFor(rows: { v: number; t: number[] }[]): number {
    let worst = 0;
    for (const r of rows) {
      let level = 0;
      for (let k = 0; k < r.t.length; k++) {
        if (r.v > r.t[k]) level = k + 1;
      }
      if (level > worst) worst = level;
    }
    return worst;
  }

  const B = ratingFor(B_THRESH);
  const U = ratingFor(U_THRESH);
  const G = ratingFor(G_THRESH);

  return {
    rating: `B${B} U${U} G${G}`,
    B,
    U,
    G,
    zoneLumens: {
      "Forward Low (0-30°)": FL,
      "Forward Medium (30-60°)": FM,
      "Forward High (60-80°)": FH,
      "Forward Very High (80-90°)": FVH,
      "Back Low (0-30°)": BL,
      "Back Medium (30-60°)": BM,
      "Back High (60-80°)": BH,
      "Back Very High (80-90°)": BVH,
      "Uplight Low (90-100°)": UL,
      "Uplight High (100-180°)": UH,
    },
  };
}

/* ── UGR (CIE 117 standard scenario) ─────────────────────── */

/** Compute UGR using the CIE 117 standard 4H × 8H room with default
 *  reflectances (ceiling 0.7, walls 0.5, floor 0.2) and the standard
 *  observer position. Single luminaire approximation: we treat the
 *  configured room as containing a single fixture above the centre
 *  of the working plane.
 *
 *  UGR = 8 * log10( 0.25 / Lb * Σ ( L_i^2 * ω_i / p_i^2 ) )
 *
 *  For a single luminaire approximation we sum a notional 4×2 grid
 *  of identical luminaires (the standard 4H × 8H array), each
 *  contributing L^2 ω / p². This produces a ballpark UGR that is
 *  realistic for visual comparison between fixtures, with the full-
 *  caveat note shown in the UI. */
export function computeUGR(
  ies: IESParseResult,
  refl: { ceiling: number; wall: number; floor: number } = { ceiling: 0.7, wall: 0.5, floor: 0.2 },
): UGRResult {
  // Single-value UGR is the published reference scenario: 4H × 8H room,
  // standard observer, 1.0H luminaire spacing, viewed crosswise. Defer
  // to the parameterised scenario function so the headline number is
  // always consistent with the corresponding cell of the comprehensive
  // CIE 117 table (see computeUGRTable).
  const value = computeUGRScenario(ies, refl, 4, 8, "crosswise", 1.0);
  return {
    value,
    isDefault: refl.ceiling === 0.7 && refl.wall === 0.5 && refl.floor === 0.2,
    reflectances: refl,
  };
}

/* ── CIE 117 comprehensive UGR table ─────────────────────── */

/** Standard CIE 117 reflectance combinations (ρ ceiling / ρ wall / ρ floor),
 *  in the column order conventional in published UGR tables. */
const UGR_TABLE_REFLECTANCES: UGRTableRefl[] = [
  { ceiling: 0.7, wall: 0.5, floor: 0.2 },
  { ceiling: 0.7, wall: 0.3, floor: 0.2 },
  { ceiling: 0.5, wall: 0.5, floor: 0.2 },
  { ceiling: 0.5, wall: 0.3, floor: 0.2 },
  { ceiling: 0.3, wall: 0.3, floor: 0.2 },
];

/** Standard X×Y room sizes in multiples of H (height of luminaire above
 *  observer's eye). Mirrors the layout of the published CIE 117 table. */
const UGR_TABLE_X_ROOMS = [2, 3, 4, 6, 8, 12];
const UGR_TABLE_Y_ROOMS = [2, 4, 8, 12];

/** Spacing-to-mounting-height ratios used for the bottom variations row. */
const UGR_TABLE_SPACINGS = [1.0, 1.5, 2.0];

/** Rotational-symmetry check: candela across horizontal planes should
 *  be (near-)constant at every vertical angle whose magnitude is above
 *  a small fraction of the global peak. Below that floor we ignore the
 *  variation — far-vertical-angle noise has near-zero candela where a
 *  small absolute spread can still exceed the relative tolerance even
 *  though the fixture is, in practice, symmetric. */
function isAxisymmetric(ies: IESParseResult, tol = 0.05): boolean {
  if (ies.numH < 2) return true;
  let globalMax = 0;
  for (let h = 0; h < ies.numH; h++) {
    for (let v = 0; v < ies.vAngles.length; v++) {
      const c = ies.candela[h]?.[v] ?? 0;
      if (c > globalMax) globalMax = c;
    }
  }
  if (globalMax <= 0) return true;
  // Only check vertical angles whose peak exceeds 1% of global max.
  const minSignal = 0.01 * globalMax;
  for (let v = 0; v < ies.vAngles.length; v++) {
    let max = 0;
    let min = Infinity;
    for (let h = 0; h < ies.numH; h++) {
      const c = ies.candela[h]?.[v] ?? 0;
      if (c > max) max = c;
      if (c < min) min = c;
    }
    if (max < minSignal) continue;
    if ((max - min) / max > tol) return false;
  }
  return true;
}

/** Compute UGR for a parameterised CIE 117 scenario. The room is
 *  X·H × Y·H in plan, the observer stands at the centre of one of
 *  the short walls (or the long wall, depending on viewing direction)
 *  with eye height H below the luminaire plane, looking horizontally
 *  parallel to the room's long axis.
 *
 *  - Crosswise: observer faces along the row direction, fixtures'
 *    long axis is perpendicular to the line of sight.
 *  - Endwise: observer faces along the lamp axis, fixtures' long axis
 *    is parallel to the line of sight.
 *
 *  For axisymmetric Type C distributions both viewing directions
 *  produce identical results — this is honest and worth surfacing.
 *
 *  Spacing parameter `sOverH` is the luminaire centre-to-centre
 *  spacing in units of H; standard reference is 1.0H.  */
function computeUGRScenario(
  ies: IESParseResult,
  refl: UGRTableRefl,
  xH: number,
  yH: number,
  viewing: "crosswise" | "endwise",
  sOverH = 1.0,
  hMeters = 2.5,
): number {
  // H is the vertical distance from observer eye to luminaire plane. The
  // canonical CIE 117 reference grid uses 2.5 m (default); for a scene-
  // specific row we pass mountingHeight − eyeHeight here.
  const H = hMeters;
  const roomX = xH * H;
  const roomY = yH * H;
  const S = Math.max(0.01, sOverH * H);
  // Decode the LM-63-19 luminous opening once per scenario. Falls back
  // to a fresh decode when an older parser hasn't populated the cached
  // descriptor (e.g. ies built through emptyResult). The per-θ
  // projected area is then a Type-C-averaged silhouette honoring the
  // shape's sign convention (§5.11) and units type (§5.10.1).
  const opening = ies.luminousOpening ?? luminousOpening(ies);
  // Minimum to keep absolute-photometry "point source" files (and the
  // edge-on θ → π/2 limit of any flat shape) from producing infinite
  // luminance. 25 cm² floor matches the previous behaviour.
  const minArea = Math.max(0.0025, opening.bottomAreaM2 * 0.05);

  // Continuous fixture-density integration. Treating the array as a
  // density (1 fixture per S² of ceiling) instead of a small integer
  // grid means neighbouring (X, Y) cells of the published table give
  // smoothly varying UGR rather than jumps when the integer count
  // flips. The discrete sum at any (X, Y) converges to this continuous
  // form once enough fixtures fit in the room — for the small rooms in
  // the table the continuous form is the better approximation.
  const fixtureDensity = 1 / (S * S);
  const stepX = Math.min(0.5, roomX / 8);
  const stepY = Math.min(0.5, roomY / 8);
  const nx = Math.max(2, Math.round(roomX / stepX));
  const ny = Math.max(2, Math.round(roomY / stepY));
  const dxs = roomX / nx;
  const dys = roomY / ny;
  const fixturesEffective = roomX * roomY * fixtureDensity;

  const downLumens = zonalLumens(ies, 0, 90);
  const totalLumens = fixturesEffective * downLumens;

  // Background luminance Lb: room-averaged interreflected illuminance
  // weighted by floor reflectance, divided by π. Uses the standard
  // sphere-cavity approximation Φ_indirect ≈ Φ × ρ_avg / (1 − ρ_avg)
  // distributed over total room surface area.
  const A_floor = roomX * roomY;
  const A_ceiling = A_floor;
  const A_walls = 2 * (roomX + roomY) * H;
  const A_total = A_floor + A_ceiling + A_walls;
  const rho_avg =
    (refl.ceiling * A_ceiling + refl.wall * A_walls + refl.floor * A_floor) /
    Math.max(1, A_total);
  const E_indirect =
    (totalLumens * rho_avg) / Math.max(0.001, 1 - rho_avg) / Math.max(1, A_total);
  const Lb = Math.max(0.5, (E_indirect * refl.floor) / Math.PI);

  // Observer position: one short-wall centre for crosswise; one long-
  // wall centre for endwise. Line of sight runs into the room along the
  // axis perpendicular to that wall.
  const obs =
    viewing === "crosswise"
      ? { x: roomX / 2, y: 0, los: { x: 0, y: 1 } }
      : { x: 0, y: roomY / 2, los: { x: 1, y: 0 } };

  let sum = 0;
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const xL = (c + 0.5) * dxs;
      const yL = (r + 0.5) * dys;
      const dx = xL - obs.x;
      const dy = yL - obs.y;
      const dz = H;
      const p = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const along = dx * obs.los.x + dy * obs.los.y;
      if (along <= 0.01) continue;

      const theta = Math.acos(dz / p);
      const phiObs = Math.atan2(dy, dx);
      const phiLumDeg =
        viewing === "crosswise"
          ? ((phiObs / DEG) + 360) % 360
          : ((phiObs / DEG + 90) + 360) % 360;
      const I = candelaAt(ies, theta / DEG, phiLumDeg);

      // Projected area of the luminous opening as seen by the observer.
      // Uses the shape-aware silhouette (LM-63-19 §5.10–§5.11 + Annex D)
      // so 3D shapes contribute their side-projection at high θ and
      // negative-encoded round openings use π·D²/4 instead of D².
      // Clamp to the absolute-photometry floor so L stays finite when
      // the file declares a near-zero opening.
      const projArea = Math.max(minArea, opening.projectedAreaAtTheta(theta));
      const omega = projArea / (p * p);
      const L = I / projArea;

      // Position-index displacement: τ horizontal off-axis, ν vertical
      // above line-of-sight.
      const tau = Math.atan2(Math.abs(dy * obs.los.x - dx * obs.los.y), Math.abs(along));
      const vAng = Math.atan2(dz, Math.sqrt(dx * dx + dy * dy));
      const Pidx = guthPosition(tau, vAng);

      // Weight by ceiling-area density × fixture density so the integral
      // approaches the discrete sum as roomArea / S² → integer values.
      const cellArea = dxs * dys;
      sum += ((L * L * omega) / (Pidx * Pidx)) * cellArea * fixtureDensity;
    }
  }

  let ugr = 8 * Math.log10((0.25 / Lb) * sum);
  if (!Number.isFinite(ugr)) ugr = 0;
  if (ugr < 0) ugr = 0;
  if (ugr > 35) ugr = 35;
  return ugr;
}

/** Sorensen / Guth position index approximation. tau is the horizontal
 *  off-axis angle; v is the elevation above the line of sight. */
function guthPosition(tau: number, v: number): number {
  const t = Math.max(0, tau);
  const e = Math.max(0, v);
  const log10P =
    (35.2 - 0.31889 * (t / DEG) - 1.22 * Math.exp(-2 * (t / DEG) / 9)) * 1e-3 * (e / DEG) +
    (21 + 0.26667 * (t / DEG) - 0.002963 * (t / DEG) * (t / DEG)) * 1e-5 * (e / DEG) * (e / DEG);
  const P = Math.pow(10, log10P);
  return Math.max(1, Math.min(20, P));
}

/** Build the comprehensive CIE 117 UGR table for an IES file at the
 *  set of standard reflectances and room sizes shown in published
 *  glare tables. */
export function computeUGRTable(ies: IESParseResult): UGRTableResult {
  const symmetric = isAxisymmetric(ies);
  const reflCount = UGR_TABLE_REFLECTANCES.length;

  const buildRows = (viewing: "crosswise" | "endwise"): UGRTableRow[] => {
    const rows: UGRTableRow[] = [];
    for (const y of UGR_TABLE_Y_ROOMS) {
      const rowValues: number[][] = [];
      for (const x of UGR_TABLE_X_ROOMS) {
        // Skip very small Y for the wider rooms, matching the published
        // table's omitted upper-right cells (8H × 2H, 12H × 2H).
        if ((y === 8 && x < 4) || (y === 12 && x < 4)) {
          rowValues.push(new Array(reflCount).fill(NaN));
          continue;
        }
        const cells = new Array<number>(reflCount);
        for (let r = 0; r < reflCount; r++) {
          cells[r] = computeUGRScenario(ies, UGR_TABLE_REFLECTANCES[r], x, y, viewing, 1.0);
        }
        rowValues.push(cells);
      }
      rows.push({ y, values: rowValues });
    }
    return rows;
  };

  const crosswise = buildRows("crosswise");
  const endwise = symmetric ? crosswise : buildRows("endwise");

  // Spacing variations: difference vs the reference 4H × 8H, default
  // reflectances scenario.  Published CIE 117 tables list two values
  // (positive max increase, negative max decrease).
  const refRefl = UGR_TABLE_REFLECTANCES[0];
  const baseUGR = computeUGRScenario(ies, refRefl, 4, 8, "crosswise", 1.0);
  const spacingVariations = UGR_TABLE_SPACINGS.map((s) => {
    const v = computeUGRScenario(ies, refRefl, 4, 8, "crosswise", s);
    const delta = v - baseUGR;
    return {
      sOverH: s,
      positive: Math.max(0, delta),
      negative: Math.min(0, delta),
    };
  });

  return {
    reflectances: UGR_TABLE_REFLECTANCES,
    yRooms: UGR_TABLE_Y_ROOMS,
    xRooms: UGR_TABLE_X_ROOMS,
    crosswise,
    endwise,
    spacingVariations,
    symmetric,
  };
}

/* ── UGR table TSV export ──────────────────────────────────── */

/** Spreadsheet-paste-friendly TSV view of `computeUGRTable`. Layout:
 *
 *    Room (X × Y)\tCrosswise ρ70/50/20\t... \tEndwise ρ70/50/20\t...
 *    2H × 2H\t  17.3\t  17.0\t...
 *    ...
 *
 *  Endwise columns are emitted only when the file isn't axisymmetric
 *  (mirroring the rendered table). The MOUNTING HEIGHT scene row is
 *  intentionally NOT included — it depends on a `RoomInputs` value
 *  that lives outside the table itself; if the future Copy as TSV
 *  affordance wants to capture it, that's a follow-up. */
export function buildUGRTsv(table: UGRTableResult): string {
  const lines: string[] = [];

  const refls = table.reflectances;
  const showEndwise = !table.symmetric;
  const fmtRefl = (r: UGRTableRefl) =>
    `${Math.round(r.ceiling * 100)}/${Math.round(r.wall * 100)}/${Math.round(r.floor * 100)}`;

  const header: string[] = ["Room (X x Y)"];
  for (const r of refls) header.push(`Crosswise ρ${fmtRefl(r)}`);
  if (showEndwise) {
    for (const r of refls) header.push(`Endwise ρ${fmtRefl(r)}`);
  }
  lines.push(header.join("\t"));

  // Walk the same (yRooms × xRooms) order the rendered table uses so
  // the printed TSV reads top-to-bottom in the same order as the
  // on-screen table. Rows whose entire crosswise tuple is non-finite
  // are omitted (the rendered table elides these — e.g. 8H × 2H,
  // 12H × 2H — and the TSV should match).
  for (let yi = 0; yi < table.yRooms.length; yi++) {
    const yH = table.yRooms[yi];
    const cwRow = table.crosswise[yi];
    const ewRow = showEndwise ? table.endwise[yi] : null;
    for (let xi = 0; xi < table.xRooms.length; xi++) {
      const xH = table.xRooms[xi];
      const cw = cwRow.values[xi];
      if (!cw.some((v) => Number.isFinite(v))) continue;
      const cells: string[] = [`${xH}H x ${yH}H`];
      for (const v of cw) cells.push(Number.isFinite(v) ? v.toFixed(1) : "");
      if (ewRow) {
        const ew = ewRow.values[xi];
        for (const v of ew) cells.push(Number.isFinite(v) ? v.toFixed(1) : "");
      }
      lines.push(cells.join("\t"));
    }
  }

  return lines.join("\n");
}

/* ── isolux grid ─────────────────────────────────────────── */

/** Compute illuminance grid on a working plane below a single
 *  ceiling-mounted luminaire centred at (roomLength/2, roomWidth/2).
 *
 *  E(point) = I(theta, phi) * cos(theta) / d²
 *  where theta is the angle from the fixture downward axis to the
 *  direction (point - fixture), d is the distance.
 *
 *  Axis convention (matches the iso-candela plot in the adjacent
 *  Candela Distribution panel and standard reference viewers like
 *  VISO): the C0°–C180° photometric plane runs along the grid's
 *  +y / −y axis, the C90°–C270° plane runs along +x / −x. ROOM
 *  LENGTH therefore aligns with C0°–C180° (the throw axis for an
 *  asymmetric / wall-wash distribution) and ROOM WIDTH with
 *  C90°–C270° (the cross-throw / wash axis). This is what places
 *  the elongated isolux footprint of e.g. WTK-72S vertically on the
 *  rendered plot, matching the iso-candela orientation specifiers
 *  expect when comparing the two panels side-by-side.
 *
 *  Returns illuminance in the requested unit (fc or lux). */
export function computeIsolux(ies: IESParseResult, room: RoomInputs, gridN = 41): IsoluxGrid {
  const { mountingHeight, roomLength, roomWidth } = room;
  const nx = gridN;
  const ny = gridN;

  const xs = new Array<number>(nx);
  const ys = new Array<number>(ny);
  const dx = roomWidth / (nx - 1);
  const dy = roomLength / (ny - 1);
  for (let i = 0; i < nx; i++) xs[i] = -roomWidth / 2 + i * dx;
  for (let j = 0; j < ny; j++) ys[j] = -roomLength / 2 + j * dy;

  const values: number[][] = [];
  let total = 0;
  let max = 0;
  let min = Infinity;
  for (let j = 0; j < ny; j++) {
    const row: number[] = [];
    for (let i = 0; i < nx; i++) {
      const x = xs[i];
      const y = ys[j];
      const dist2 = x * x + y * y + mountingHeight * mountingHeight;
      const dist = Math.sqrt(dist2);
      const cosTheta = mountingHeight / dist;
      const theta = Math.acos(cosTheta) / DEG;
      // Type C φ measured clockwise from the C0° axis (which we
      // place along +y so the photometric plane is vertical on the
      // plot — see docstring). atan2(x, y) gives 0° at +y, 90° at
      // +x, matching the standard "compass" convention specifiers
      // read on isolux / iso-candela plots in Visual / DIALux / VISO.
      const phi = ((Math.atan2(x, y) / DEG) + 360) % 360;
      const I = candelaAt(ies, theta, phi);
      // Illuminance in lux:
      const E_lux = (I * cosTheta) / dist2;
      const E = room.unit === "fc" ? E_lux * 0.0929 : E_lux;
      row.push(E);
      total += E;
      if (E > max) max = E;
      if (E < min) min = E;
    }
    values.push(row);
  }

  const avg = total / (nx * ny);
  const uniformity = min > 0 ? avg / min : 0;
  return { unit: room.unit, xs, ys, values, avg, max, min, uniformity };
}

/* ── parse tools / thin helpers used by the report panel ── */

export function totalLuminaireLumens(ies: IESParseResult): number {
  return zonalLumens(ies, 0, 180);
}

export function efficacy(ies: IESParseResult): number {
  if (!ies.inputWatts || ies.inputWatts <= 0) return 0;
  return totalLuminaireLumens(ies) / ies.inputWatts;
}

export function metricsAvailable(ies: IESParseResult): { bug: boolean; ugr: boolean } {
  // Per PRD §6.6: BUG/UGR for Type C with reasonable angular
  // resolution. Our threshold mirrors §5.1 (181×17 sample).
  // NOTE: callers showing the *UGR table itself* should prefer
  // `ugrAvailability(ies)` below — it returns a richer
  // compliant/unavailable pair (with reason copy) for the panel
  // render path.  `metricsAvailable.ugr` here remains the strict
  // CIE 117 gate, kept in this shape for backward compatibility
  // with the BUG gate and any other callers that want a single
  // yes/no.
  const enoughV = ies.numV >= 91; // half-degree or 1° resolution to 90°
  const enoughH = ies.numH >= 9;  // at least 4-plane per quadrant
  const isC = ies.photometricType === "C";
  return { bug: isC && enoughV && enoughH, ugr: isC && enoughV && enoughH };
}

/* ── UGR availability (compliant / N/A) ─────────────────────── */

/** Binary UGR availability for the Report panel.
 *
 *  - `compliant`   — Type C, multi-plane, with downward emission.
 *                    Render the UGR table.
 *  - `unavailable` — fundamental obstruction (not Type C / single
 *                    horizontal plane / no downward emission). Keep
 *                    the existing "Not available" panel.
 *
 *  We deliberately do NOT gate on angular grid resolution here. CIE
 *  117 defines the UGR formula and table format but does not specify
 *  a minimum input angular grid; we don't have a defensible
 *  heuristic for when grid coarseness actually changes UGR enough to
 *  warrant a warning (a narrow-beam fixture concentrated near nadir
 *  may be fine on a 37×5 grid; a wide-distribution troffer may not).
 *  Rather than ship a flag we can't justify, the table renders the
 *  computed numbers without qualification.
 *
 *  USER-FACING COPY — the `reason` strings render in the UGR panel
 *  and the Compare row tooltips. If WIES Studio is ever localized,
 *  treat this function as the canonical source for the en-US strings
 *  and thread translations from here. */
export type UGRAvailability =
  | { kind: "compliant"; gridV: number; gridH: number }
  | { kind: "unavailable"; reason: string };

export function ugrAvailability(ies: IESParseResult): UGRAvailability {
  if (ies.photometricType !== "C") {
    return {
      kind: "unavailable",
      reason: `UGR is defined for Type C photometry; this file is Type ${ies.photometricType}.`,
    };
  }
  if (ies.numH === 1) {
    return {
      kind: "unavailable",
      reason:
        "Rotationally symmetric distribution (1 horizontal plane). " +
        "UGR per CIE 117 requires multi-plane photometry.",
    };
  }
  // Type C with no downward emission can't drive a UGR scene.
  const v0 = ies.vAngles[0] ?? 0;
  if (v0 >= 89.99) {
    return {
      kind: "unavailable",
      reason: "No downward emission encoded (vertical range starts at or above 90°).",
    };
  }
  return { kind: "compliant", gridV: ies.numV, gridH: ies.numH };
}

/* ── cumulative zonal-lumen summary ──────────────────────── */

/** Build a cumulative zonal-lumen summary in the LM-79 / AGi32 style.
 *  Rows are cumulative bands from nadir (e.g. 0-30°, 0-40°, 0-60°,
 *  0-90°), plus the uplight hemisphere and a Total row.
 *
 *  pctLamp is the percent of rated lamp lumens (lampCount × lumensPerLamp);
 *  NaN when lamp lumens are absolute (-1) or zero.
 *  pctFixture is the percent of total luminaire lumens. */
export function cumulativeZonalSummary(ies: IESParseResult): CumulativeZoneRow[] {
  const total = totalLuminaireLumens(ies);
  const totalSafe = total > 0 ? total : 1;

  const lampLumens = (ies.lampCount > 0 && ies.lumensPerLamp > 0)
    ? ies.lampCount * ies.lumensPerLamp
    : NaN;

  const cumulativeBands: { v0: number; v1: number; label: string }[] = [
    { v0: 0, v1: 30, label: "0-30°" },
    { v0: 0, v1: 40, label: "0-40°" },
    { v0: 0, v1: 60, label: "0-60°" },
    { v0: 0, v1: 90, label: "0-90° (Downward)" },
  ];

  const rows: CumulativeZoneRow[] = cumulativeBands.map(({ v0, v1, label }) => {
    const lumens = zonalLumens(ies, v0, v1);
    return {
      v0,
      v1,
      label,
      lumens,
      pctLamp: Number.isFinite(lampLumens) ? (lumens / lampLumens) * 100 : NaN,
      pctFixture: (lumens / totalSafe) * 100,
    };
  });

  const upward = zonalLumens(ies, 90, 180);
  rows.push({
    v0: 90,
    v1: 180,
    label: "90-180° (Uplight)",
    lumens: upward,
    pctLamp: Number.isFinite(lampLumens) ? (upward / lampLumens) * 100 : NaN,
    pctFixture: (upward / totalSafe) * 100,
  });

  rows.push({
    v0: 0,
    v1: 180,
    label: "Total",
    lumens: total,
    pctLamp: Number.isFinite(lampLumens) ? (total / lampLumens) * 100 : NaN,
    pctFixture: 100,
  });

  return rows;
}

/** Build a cumulative lumens-vs-angle curve for the beam-concentration
 *  visualization. Resolves at every vertical angle in the IES file
 *  (typically 1° increments from the 181-vertical-angle grid) so the
 *  rendered curve is smooth instead of piecewise-linear between table
 *  rows.
 *
 *  Implementation reuses the same Type C trapezoidal-in-θ /
 *  mean-in-φ formula as zonalLumens(...): we build avgPhi[v] once,
 *  then walk vAngles[] forward, accumulating the trapezoidal area
 *  under I(θ)·sin(θ)·2π between successive samples. Cumulative
 *  lumens at angles[i] therefore equals zonalLumens(ies, 0,
 *  vAngles[i]) by construction, but at one-pass cost — calling the
 *  per-band zonalLumens(...) once per angle would be O(N²).
 *
 *  Returns parallel `angles` and `cumulativePct` arrays (0..100,
 *  monotonic). When total fixture lumens are zero (degenerate /
 *  corrupt IES) the percentages are all zero — same `total > 0 ?
 *  total : 1` guard used by cumulativeZonalSummary above. */
export function cumulativeLumensCurve(ies: IESParseResult): {
  angles: number[];
  cumulativePct: number[];
} {
  const { vAngles, hAngles, candela } = ies;
  if (vAngles.length === 0 || hAngles.length === 0) {
    return { angles: [], cumulativePct: [] };
  }

  const hSpan = (hAngles[hAngles.length - 1] - hAngles[0]) * DEG;

  // Per-vertical-angle mean candela across the φ sweep — same as
  // zonalLumens(...). For numH=1 (axially symmetric) the single
  // plane already IS the mean.
  const avgPhi = new Array<number>(vAngles.length).fill(0);
  for (let v = 0; v < vAngles.length; v++) {
    if (hAngles.length === 1) {
      avgPhi[v] = candela[0]?.[v] ?? 0;
      continue;
    }
    let area = 0;
    for (let h = 0; h < hAngles.length - 1; h++) {
      const dPhi = (hAngles[h + 1] - hAngles[h]) * DEG;
      area += 0.5 * (candela[h][v] + candela[h + 1][v]) * dPhi;
    }
    avgPhi[v] = hSpan > 0 ? area / hSpan : candela[0]?.[v] ?? 0;
  }

  const cumulative = new Array<number>(vAngles.length).fill(0);
  for (let v = 0; v < vAngles.length - 1; v++) {
    const t0 = vAngles[v];
    const t1 = vAngles[v + 1];
    const span = (t1 - t0) * DEG;
    if (span <= 0) {
      cumulative[v + 1] = cumulative[v];
      continue;
    }
    const cA = avgPhi[v];
    const cB = avgPhi[v + 1];
    const sinA = Math.sin(t0 * DEG);
    const sinB = Math.sin(t1 * DEG);
    const slice = 0.5 * (cA * sinA + cB * sinB) * span * 2 * Math.PI;
    cumulative[v + 1] = cumulative[v] + slice;
  }

  const total = cumulative[cumulative.length - 1];
  const totalSafe = total > 0 ? total : 1;
  const cumulativePct = cumulative.map((c) => (c / totalSafe) * 100);

  return { angles: vAngles.slice(), cumulativePct };
}

/* ── cone of light / CBCP ────────────────────────────────── */

/** Build a 5-row cone-of-light table centred on the user's current
 *  isolux mounting height. Heights are stepped in the active
 *  distance system: ±2 / ±1 / current / +1 / +2 in the unit shown
 *  to the user (ft for imperial, m for metric).
 *
 *  Each row reports:
 *   - mounting height
 *   - beam diameter (50% of peak): 2 · h · tan(beamAngle/2)
 *   - field diameter (10% of peak): 2 · h · tan(fieldAngle/2)
 *   - center fc and lux: I(0°, 0°) / h²  (cosine = 1 on-axis, lux),
 *     converted to fc via 1 fc = 10.7639 lux.
 *
 *  Rows whose beam/field can't be derived (no crossings in the IES)
 *  return NaN for those columns; the panel shows a dash. */
export function coneOfLight(
  ies: IESParseResult,
  room: RoomInputs,
  plane: 0 | 90 = 0,
): ConeOfLightRow[] {
  const ba = beamAngles(ies);
  const beam = plane === 90 ? ba.beamC90 : ba.beamC0;
  const field = plane === 90 ? ba.fieldC90 : ba.fieldC0;
  const beamRad = beam != null ? (beam * DEG) / 2 : NaN;
  const fieldRad = field != null ? (field * DEG) / 2 : NaN;

  // On-axis intensity (nadir, 0° plane).
  const Iaxis = candelaAt(ies, 0, 0);

  // Step size in the user's distance unit.
  const stepUnit = 1; // 1 ft or 1 m
  const stepM = room.system === "imperial" ? stepUnit * M_PER_FT : stepUnit;

  // Anchor the ±2-step grid on the user's *actual* mounting height —
  // do not snap to integer ft/m. Snapping caused MOUNTING HEIGHT
  // centering to coincidentally produce the same columns as the
  // FIXED RANGE standard tier whenever round(mh) ∈ {1..5} (e.g. a
  // 2.7 m mh rounded to 3 m → [1,2,3,4,5], identical to FIXED
  // RANGE). The mh annotation absorbs the centre column anyway, so
  // there's no risk of two columns landing at near-identical x.
  const baseM = room.mountingHeight;

  const offsets = [-2, -1, 0, 1, 2];
  const rows: ConeOfLightRow[] = offsets.map((k) => {
    const hM = Math.max(0.1, baseM + k * stepM);
    const beamDiaM = Number.isFinite(beamRad) ? 2 * hM * Math.tan(beamRad) : NaN;
    const fieldDiaM = Number.isFinite(fieldRad) ? 2 * hM * Math.tan(fieldRad) : NaN;
    const lux = Iaxis / (hM * hM);
    const fc = lux / 10.7639;
    return {
      mountingHeightM: hM,
      beamDiaM,
      fieldDiaM,
      centerFc: fc,
      centerLux: lux,
      isCurrent: Math.abs(hM - room.mountingHeight) < 1e-3,
    };
  });

  // Make sure exactly one row reads as "current" — pick the closest
  // to the user's actual mounting height.
  if (!rows.some((r) => r.isCurrent)) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const d = Math.abs(rows[i].mountingHeightM - room.mountingHeight);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    rows[bestIdx].isCurrent = true;
  }

  return rows;
}

/** Compute a single cone-of-light row at an arbitrary mounting height
 *  (in metres). Used by the diagram's hover overlay and the persistent
 *  mounting-height annotation column.
 *
 *  - lux = I(0°, 0°) / h²   (on-axis, working plane)
 *  - fc  = lux / 10.7639
 *  - beamDiaM = 2 · h · tan(beamAngle / 2), or NaN if beam angle is
 *    undefined for this IES (e.g. no 50%-of-peak crossing).
 *
 *  hM ≤ 0 is guarded — we return NaN for lux rather than ±Infinity, so
 *  callers can render "—" cleanly. Iaxis = 0 (a fixture with literally
 *  no axial intensity) correctly gives lux = 0 and fc = 0; the tooltip
 *  should render those as "0 lx" / "0.0 fcd", not hide them. */
export function coneOfLightAt(
  ies: IESParseResult,
  hM: number,
  plane: 0 | 90 = 0,
): {
  mountingHeightM: number;
  centerLux: number;
  centerFc: number;
  beamDiaM: number;
  fieldDiaM: number;
} {
  const ba = beamAngles(ies);
  const beam = plane === 90 ? ba.beamC90 : ba.beamC0;
  const field = plane === 90 ? ba.fieldC90 : ba.fieldC0;
  const beamRad = beam != null ? (beam * DEG) / 2 : NaN;
  const fieldRad = field != null ? (field * DEG) / 2 : NaN;
  const Iaxis = candelaAt(ies, 0, 0);
  const lux = hM > 0 ? Iaxis / (hM * hM) : NaN;
  return {
    mountingHeightM: hM,
    centerLux: lux,
    centerFc: Number.isFinite(lux) ? lux / 10.7639 : NaN,
    beamDiaM: Number.isFinite(beamRad) ? 2 * hM * Math.tan(beamRad) : NaN,
    fieldDiaM: Number.isFinite(fieldRad) ? 2 * hM * Math.tan(fieldRad) : NaN,
  };
}

/** Build cone-of-light rows for a caller-supplied list of mounting
 *  heights (in metres). Used by the diagram in FIXED-RANGE mode, where
 *  the columns come from a tier table rather than ±2 steps around the
 *  user's height. `isCurrent` is always false here — the persistent
 *  mounting-height annotation owns the "current" concept now. */
export function coneOfLightAtHeights(
  ies: IESParseResult,
  heightsM: number[],
  plane: 0 | 90 = 0,
): ConeOfLightRow[] {
  return heightsM.map((hM) => {
    const c = coneOfLightAt(ies, Math.max(0.1, hM), plane);
    return {
      mountingHeightM: c.mountingHeightM,
      beamDiaM: c.beamDiaM,
      fieldDiaM: c.fieldDiaM,
      centerFc: c.centerFc,
      centerLux: c.centerLux,
      isCurrent: false,
    };
  });
}

/* ── UGR scene-specific row ──────────────────────────────── */

/** CIE 117 standard seated observer. UGR is defined for an eye height
 *  of 1.2 m above the floor.
 *
 *  // TODO: parameterize for standing observers (~1.5 m) — high-bay /
 *  // warehouse fixtures will want this. Tracked separately; v1
 *  // hardcodes seated. */
const UGR_EYE_HEIGHT_M = 1.2;
/** Minimum effective H so a luminaire mounted at or below eye height
 *  doesn't blow up the geometry. */
const UGR_MIN_H_M = 0.3;
/** CIE 117 tabulated room-ratio domain. xH and yH outside this range
 *  fall outside the published reference and we report "out of range"
 *  rather than extrapolate. */
export const UGR_SCENE_DOMAIN = { min: 0.5, max: 16 } as const;

/** Compute UGR for the user's actual scene (room dimensions, mounting
 *  height) at a given reflectance triple and viewing direction.
 *
 *  Returns `null` when the scene's room ratios fall outside the CIE 117
 *  tabulation domain (0.5 ≤ xH, yH ≤ 16) — callers should treat the
 *  whole row as "out of range" rather than rendering per-cell dashes. */
export function computeUGRForScene(
  ies: IESParseResult,
  room: RoomInputs,
  refl: UGRTableRefl,
  viewing: "crosswise" | "endwise",
): number | null {
  const H = Math.max(UGR_MIN_H_M, room.mountingHeight - UGR_EYE_HEIGHT_M);
  const xH = room.roomLength / H;
  const yH = room.roomWidth / H;
  const { min, max } = UGR_SCENE_DOMAIN;
  const inDomain = xH >= min && xH <= max && yH >= min && yH <= max;
  if (!inDomain) return null;
  return computeUGRScenario(ies, refl, xH, yH, viewing, 1.0, H);
}

/** Convenience: report the (xH, yH, H) the scene UGR row uses, so the
 *  table header can label its first cell consistently with the math. */
export function ugrSceneGeometry(room: RoomInputs): {
  H: number;
  xH: number;
  yH: number;
  inDomain: boolean;
} {
  const H = Math.max(UGR_MIN_H_M, room.mountingHeight - UGR_EYE_HEIGHT_M);
  const xH = room.roomLength / H;
  const yH = room.roomWidth / H;
  const { min, max } = UGR_SCENE_DOMAIN;
  return {
    H,
    xH,
    yH,
    inDomain: xH >= min && xH <= max && yH >= min && yH <= max,
  };
}

/* ── coefficient of utilization (zonal-cavity) ───────────── */

/** Compute a Coefficient-of-Utilization table using a three-cavity
 *  flux-transfer (radiosity) model in the spirit of the IES zonal-
 *  cavity method.
 *
 *  Model:
 *    1. Reduce the room to a three-surface cavity — work plane (P),
 *       ceiling cavity (C), aggregated walls (W) — with the luminaire
 *       sitting in the ceiling plane (recessed/flush; surface and
 *       pendant fixtures are approximated by the same geometry).
 *    2. For each (reflectance combo, RCR) cell of the table, compute
 *       direct distribution per zone via cone-on-rectangle integration
 *       on a unit-side equivalent square cavity of height
 *           h_cav = RCR / 10  (derived from the standard
 *                              RCR = 5·h·(L+W)/(L·W) by setting
 *                              L = W = 1 — see derivation below).
 *    3. Solve the 3-surface radiosity equation
 *           (I - diag(rho) · F) · M = diag(rho) · E
 *       with form factors F from the standard analytic two-parallel-
 *       rectangles result (Hamilton-Morgan) plus reciprocity / closure.
 *    4. CU = (incident flux on work plane) / (total luminaire flux).
 *
 *  Cavity-height derivation. Standard RCR definition:
 *      RCR = 5 · h_cc · (L + W) / (L · W)
 *  Solving for h_cc:
 *      h_cc = RCR · L · W / (5 · (L + W))
 *  For an "equivalent" square cavity of unit side (L = W = 1) this
 *  collapses to h_cav = RCR / 10. We work in unit-side normalized
 *  coordinates because form factors are dimensionless and depend
 *  only on the cavity-height-to-side ratio.
 *
 *  Documented simplifications (do NOT silently "fix" these without
 *  understanding the trade):
 *
 *    - Equivalent square cavity. The CU table is a precomputed
 *      lookup interpolated at runtime by RCR alone, so cavity
 *      aspect-ratio dependence is not represented here. Drift is
 *      small (< 2 % CU) for typical office/retail aspect ratios;
 *      very long/narrow rooms drift further. solveLayout still uses
 *      the actual L × W elsewhere (point-by-point grid, lumen-method
 *      area) — only this table generator collapses to square.
 *
 *    - Single aggregated wall patch. The four walls collapse to one
 *      Lambertian surface, which makes this CU model insensitive to
 *      fixture position within the cavity (a corner fixture and a
 *      centered fixture produce the same CU). This matches the IES
 *      handbook's own simplification and is correct for sizing math;
 *      position-driven illuminance variation is handled by the PBP
 *      grid downstream, not here.
 *
 *    - Recessed/flush luminaire approximation. Upward zonal lumens
 *      (90-180°) are assumed to enter the ceiling cavity directly
 *      (D_C = 1). For surface and pendant fixtures with non-trivial
 *      upward output, the wall fraction of the upward zone is
 *      neglected — a reasonable approximation for drops < 0.2·H.
 *
 *  Validation harness lives at wies-app/_verify-search-undercount.mts
 *  (and the handbook reference cases in _verify-cu-handbook.mts). */
export function coefficientOfUtilization(ies: IESParseResult): CUTable {
  const reflectances = [
    { ceiling: 0.8, wall: 0.5, floor: 0.2 },
    { ceiling: 0.8, wall: 0.3, floor: 0.1 },
    { ceiling: 0.7, wall: 0.5, floor: 0.2 },
    { ceiling: 0.7, wall: 0.3, floor: 0.1 },
    { ceiling: 0.5, wall: 0.5, floor: 0.2 },
    { ceiling: 0.5, wall: 0.3, floor: 0.1 },
    { ceiling: 0.0, wall: 0.0, floor: 0.0 },
  ];
  const rcrs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  // 8 downward 10° bands plus one upward hemisphere band [90°, 180°].
  // Upward flux is funnelled into the ceiling cavity by the recessed-
  // luminaire approximation in the docstring.
  const bandEdges = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 180];
  const bandLumens: number[] = [];
  for (let i = 0; i < bandEdges.length - 1; i++) {
    bandLumens.push(zonalLumens(ies, bandEdges[i], bandEdges[i + 1]));
  }
  const totalLumens = bandLumens.reduce((a, b) => a + b, 0);

  const values: number[][] = reflectances.map((r) =>
    rcrs.map((rcr) => solveCavityCU(bandEdges, bandLumens, totalLumens, rcr, r)),
  );

  return { reflectances, rcrs, values };
}

/** Implicit luminaire-efficiency factor for matching IES Handbook
 *  CU table convention. See HANDBOOK_LUMINAIRE_EFFICIENCY block in
 *  the docstring of `solveCavityCU` below for the full rationale.
 *  Surfaced as a module export so the diagnostic harness and future
 *  contributors can reason about / probe / replace it without
 *  rummaging through the implementation. */
export const HANDBOOK_LUMINAIRE_EFFICIENCY = 0.67;

/** Coefficient of utilization for one (RCR, reflectance) cell.
 *  Single source of truth used by both the table generator and the
 *  handbook validation harness.
 *
 *  HANDBOOK_LUMINAIRE_EFFICIENCY (the constant above) is a deliberate
 *  convention adjustment, not a fudge factor for "tuning" results.
 *  Three-cavity flux transfer applied to LED IES lumens computes the
 *  fraction of *fixture-delivered* (post-optic) lumens reaching the
 *  work plane — that runs ~1.0-1.1 for typical recessed downlights.
 *  IES Handbook CU tables (which specifiers consult, and which AGi32
 *  / DIALux / Visual default to for sizing) were derived for older
 *  fluorescent fixtures whose IES distribution represents the
 *  bare-lamp lumens, with a luminaire-efficiency loss η ≈ 0.65-0.70
 *  baked implicitly into every published CU value. LED IES files
 *  collapse "lamp" and "fixture" — there is no separate η — so
 *  literally applying handbook CU values to an LED IES file
 *  under-counts delivered flux by 1/η. Specifiers do this anyway.
 *  Applying η = 0.67 here pre-multiplies our flux-transfer output to
 *  match the convention they live in.
 *
 *  Concretely: at RCR ≈ 4.64, 80/50/20 reflectances, flux transfer
 *  produces CU ≈ 1.06 for our R2SD2T-FTWB-WT test fixture. Post-
 *  multiplying by 0.67 gives 0.71, matching the IES Handbook entry
 *  at "Direct distribution recessed downlight, RCR 5, 80/50/20" and
 *  the user's hand-calculated ground-truth count of 14 fixtures at
 *  30.5 fc. Without this factor, the engine would predict ~10
 *  fixtures — physically optimistic per the LED file's literal
 *  lumens, but at odds with industry sizing tools.
 *
 *  When (if ever) the LED industry consolidates around publishing
 *  CU tables that don't bake in η, drop the constant to 1.0. The
 *  validation harness in _verify-cu-handbook.mts will catch the
 *  shift. */
export function solveCavityCU(
  bandEdges: number[],
  bandLumens: number[],
  totalLumens: number,
  rcr: number,
  refl: { ceiling: number; wall: number; floor: number },
): number {
  if (totalLumens <= 0) return 0;

  // RCR -> equivalent unit-square cavity height (see docstring).
  // Floor h_cav at a small positive value so the form-factor algebra
  // stays well-conditioned at the RCR=0 corner of the table.
  const h = Math.max(0.05, rcr / 10);

  const A_P = 1;
  const A_C = 1;
  const A_W = 4 * h;

  const dist = directDistributionPerZone(bandEdges, h);

  let E_P_abs = 0;
  let E_C_abs = 0;
  let E_W_abs = 0;
  for (let z = 0; z < bandLumens.length; z++) {
    E_P_abs += bandLumens[z] * dist.D_P[z];
    E_C_abs += bandLumens[z] * dist.D_C[z];
    E_W_abs += bandLumens[z] * dist.D_W[z];
  }
  const E_P = E_P_abs / A_P;
  const E_C = E_C_abs / A_C;
  const E_W = A_W > 0 ? E_W_abs / A_W : 0;

  // Form factors via Hamilton-Morgan + reciprocity + closure.
  const F_PC = viewFactorParallelSquares(h);
  const F_PW = Math.max(0, 1 - F_PC);
  const F_CP = F_PC;          // reciprocity, A_P = A_C
  const F_CW = F_PW;
  const F_WP = A_W > 0 ? (A_P * F_PW) / A_W : 0;
  const F_WC = A_W > 0 ? (A_C * F_CW) / A_W : 0;
  const F_WW = Math.max(0, 1 - F_WP - F_WC);

  // (I - diag(rho)·F) · M = diag(rho) · E.
  // Index 0 = P (work plane), 1 = C (ceiling), 2 = W (walls).
  const rP = refl.floor;
  const rC = refl.ceiling;
  const rW = refl.wall;
  const A: number[][] = [
    [1,             -rP * F_PC,     -rP * F_PW],
    [-rC * F_CP,     1,             -rC * F_CW],
    [-rW * F_WP,    -rW * F_WC,      1 - rW * F_WW],
  ];
  const b: number[] = [rP * E_P, rC * E_C, rW * E_W];
  const M = solve3x3(A, b);

  // Incident on P (lm/m²) = E_P_direct + interreflected from C and W.
  const incidentP = E_P + F_PC * M[1] + F_PW * M[2];
  const fluxToWP = incidentP * A_P;
  const cuRaw = fluxToWP / totalLumens;
  // Pre-multiply by the IES Handbook luminaire-efficiency factor to
  // align with the convention specifier sizing tools default to. See
  // function docstring above for the full rationale.
  return Math.max(0, Math.min(1.2, cuRaw * HANDBOOK_LUMINAIRE_EFFICIENCY));
}

/** Per-zone direct distribution to the three cavity surfaces, on a
 *  unit-side square cavity of height h with the luminaire at the
 *  ceiling centre. Downward zones (θ < 90°) integrate cone-on-square
 *  geometry numerically; the upward zone (θ ≥ 90°) is funnelled into
 *  the ceiling cavity per the recessed-luminaire approximation. */
function directDistributionPerZone(
  bandEdges: number[],
  h: number,
): { D_P: number[]; D_W: number[]; D_C: number[] } {
  const D_P: number[] = [];
  const D_W: number[] = [];
  const D_C: number[] = [];

  // 12 × 32 samples per band — fast and well under 0.5 % drift in
  // tested zones. Pure cosmetic to bump up if needed.
  const N_THETA = 12;
  const N_PHI = 32;

  for (let z = 0; z < bandEdges.length - 1; z++) {
    if (bandEdges[z] >= 90) {
      D_P.push(0);
      D_W.push(0);
      D_C.push(1);
      continue;
    }
    const t0 = bandEdges[z] * DEG;
    const t1 = bandEdges[z + 1] * DEG;
    const dt = (t1 - t0) / N_THETA;
    const dp = (2 * Math.PI) / N_PHI;
    let pSum = 0;
    let wSum = 0;
    let weightSum = 0;
    for (let it = 0; it < N_THETA; it++) {
      const tCenter = t0 + (it + 0.5) * dt;
      // Clamp at 89.95° so tan stays finite at the [80,90°] band edge.
      const tClamped = Math.min(tCenter, 89.95 * DEG);
      const sinT = Math.sin(tCenter);
      const tanT = Math.tan(tClamped);
      const projR = h * tanT;
      for (let ip = 0; ip < N_PHI; ip++) {
        const pCenter = (ip + 0.5) * dp;
        const x = 0.5 + projR * Math.cos(pCenter);
        const y = 0.5 + projR * Math.sin(pCenter);
        const w = sinT * dt * dp;
        weightSum += w;
        if (x >= 0 && x <= 1 && y >= 0 && y <= 1) pSum += w;
        else wSum += w;
      }
    }
    if (weightSum > 0) {
      D_P.push(pSum / weightSum);
      D_W.push(wSum / weightSum);
    } else {
      D_P.push(1);
      D_W.push(0);
    }
    D_C.push(0);
  }
  return { D_P, D_W, D_C };
}

/** View factor between two unit-side coaxial parallel rectangles
 *  separated by `h` (Hamilton-Morgan / Howell catalog C-14). */
function viewFactorParallelSquares(h: number): number {
  if (h <= 0) return 1;
  const X = 1 / h;
  const Y = 1 / h;
  const X2 = X * X;
  const Y2 = Y * Y;
  const lnArg = ((1 + X2) * (1 + Y2)) / (1 + X2 + Y2);
  const t1 = 0.5 * Math.log(lnArg);
  const t2 = X * Math.sqrt(1 + Y2) * Math.atan(X / Math.sqrt(1 + Y2));
  const t3 = Y * Math.sqrt(1 + X2) * Math.atan(Y / Math.sqrt(1 + X2));
  const t4 = X * Math.atan(X);
  const t5 = Y * Math.atan(Y);
  const F = (2 / (Math.PI * X * Y)) * (t1 + t2 + t3 - t4 - t5);
  return Math.max(0, Math.min(1, F));
}

/** Gauss elimination with partial pivoting for a 3×3 system. Returns
 *  [0,0,0] when the matrix is degenerate (caller treats the cell as
 *  CU=0). */
function solve3x3(A: number[][], b: number[]): number[] {
  const M = A.map((row, i) => [row[0], row[1], row[2], b[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    }
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    if (Math.abs(M[col][col]) < 1e-12) return [0, 0, 0];
    for (let row = col + 1; row < 3; row++) {
      const f = M[row][col] / M[col][col];
      for (let c = col; c <= 3; c++) M[row][c] -= f * M[col][c];
    }
  }
  const x = [0, 0, 0];
  for (let row = 2; row >= 0; row--) {
    let s = M[row][3];
    for (let c = row + 1; c < 3; c++) s -= M[row][c] * x[c];
    x[row] = s / M[row][row];
  }
  return x;
}

/* ── luminance at standard viewing angles ────────────────── */

/** Average projected luminance (cd/m²) at standard viewing angles.
 *  L = I / A_proj(θ), where A_proj is the Type-C-averaged luminous
 *  silhouette area at the viewing angle (LM-63-19 §5.10–§5.11 +
 *  Annex D — sign convention decoded, units converted to metres).
 *
 *  The crosswise column samples the 0° horizontal plane; lengthwise
 *  samples the 90° plane. Files that declare a point source
 *  (bottomAreaM2 == 0 — e.g. point shape or vertical-circle-facing-PH)
 *  return openingAreaM2 = 0 and the panel hides itself. */
export function luminanceAtViewingAngles(
  ies: IESParseResult,
  angles: number[] = [45, 55, 65, 75, 85],
): LuminanceTable {
  const opening = ies.luminousOpening ?? luminousOpening(ies);
  const openingAreaM2 = opening.bottomAreaM2;

  if (openingAreaM2 <= 0) {
    return { rows: [], openingAreaM2: 0 };
  }

  const rows = angles.map((deg) => {
    // Lower-clamp the projection so files declaring a flat opening
    // don't drive luminance to infinity at the θ → π/2 edge case.
    const minArea = openingAreaM2 * 0.01;
    const projected = Math.max(minArea, opening.projectedAreaAtTheta(deg * DEG));
    const Icross = candelaAt(ies, deg, 0);
    const Ilen = candelaAt(ies, deg, 90);
    return {
      angleDeg: deg,
      crosswise: Icross / projected,
      lengthwise: Ilen / projected,
    };
  });

  // All-zero luminance — treat as not-derivable so downstream consumers
  // (LuminanceTable, LuminancePolarPlot) hide via their existing
  // `!rows.length` checks instead of each having to add a parallel
  // dataMax > 0 guard.
  const anyNonZero = rows.some((r) => r.crosswise > 0 || r.lengthwise > 0);
  if (!anyNonZero) {
    return { rows: [], openingAreaM2 };
  }

  return { rows, openingAreaM2 };
}

/* ── 3D candela surface ──────────────────────────────────── */

/** A 3D candela "polar pattern" surface: for each (θ, φ) pair on the
 *  IES grid, place a point at the corresponding Cartesian position
 *  scaled by the candela value at that direction. The fixture sits at
 *  the origin pointing down (−z); points are produced in the lower
 *  hemisphere for a Type C downlight, or both hemispheres if upward
 *  candela is non-zero.
 *
 *  Returns matrices shaped [phi][theta] suitable for Plotly's `surface`
 *  trace, plus a flat candela array for surfaceColor. */
export interface CandelaSurface {
  x: number[][];
  y: number[][];
  z: number[][];
  /** Per-vertex candela for surfaceColor / colorbar. Same shape as x/y/z. */
  candela: number[][];
  /** Peak candela value found on the grid (max of `candela`). */
  maxCandela: number;
}

export function candelaSurface3D(ies: IESParseResult): CandelaSurface {
  const { vAngles, hAngles } = ies;
  if (vAngles.length === 0 || hAngles.length === 0) {
    return { x: [], y: [], z: [], candela: [], maxCandela: 0 };
  }

  // Build the φ sweep. For files that already span the full circle we
  // keep the stored H grid (and close the loop). For axisymmetric
  // (numH = 1), quadrant-symmetric (hSpan ≈ 90°) and bilaterally
  // symmetric (hSpan ≈ 180°) files we render the full 360° bowl by
  // sampling with `candelaAt`, which mirrors / wraps the requested
  // angle back into the file's stored range per LM-63. Without this,
  // an elliptical Type C file storing only a quadrant would render as
  // a 90° wedge in 3D instead of a full elongated bowl.
  const hSpan = hAngles[hAngles.length - 1] - hAngles[0];
  const fullSweep = hAngles.length >= 2 && Math.abs(hSpan - 360) < 0.01;
  // 5° step around the circle matches typical reference viewer
  // resolution (Viso etc.) and keeps the mesh modest (73 × numV).
  const SYMMETRIC_STEP = 5;
  const hList: number[] = fullSweep
    ? [...hAngles, hAngles[0] + 360]
    : Array.from(
        { length: Math.round(360 / SYMMETRIC_STEP) + 1 },
        (_, k) => k * SYMMETRIC_STEP,
      );

  const x: number[][] = [];
  const y: number[][] = [];
  const z: number[][] = [];
  const c: number[][] = [];
  let maxC = 0;

  for (let h = 0; h < hList.length; h++) {
    const hDeg = hList[h];
    const phi = hDeg * DEG;
    const sP = Math.sin(phi);
    const cP = Math.cos(phi);

    const rx: number[] = [];
    const ry: number[] = [];
    const rz: number[] = [];
    const rc: number[] = [];
    for (let v = 0; v < vAngles.length; v++) {
      const vDeg = vAngles[v];
      const theta = vDeg * DEG;
      const sT = Math.sin(theta);
      const cT = Math.cos(theta);
      const I = candelaAt(ies, vDeg, hDeg);
      // Type C convention: θ measured from the fixture downward axis
      // (−z). Position the vertex at +z = −cosθ so the surface visibly
      // hangs below the origin like a real luminaire.
      rx.push(I * sT * cP);
      ry.push(I * sT * sP);
      rz.push(-I * cT);
      rc.push(I);
      if (I > maxC) maxC = I;
    }
    x.push(rx);
    y.push(ry);
    z.push(rz);
    c.push(rc);
  }

  return { x, y, z, candela: c, maxCandela: maxC };
}
