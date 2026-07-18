// @ts-nocheck — VERBATIM port of the WIES Studio layout SOLVER
// (wies-app/src/lib/estimator.ts, the compute half below its reference tables).
// Kept byte-for-byte with the validated WIES source: its fixture-count / fc
// numbers are the contract, pinned by ies/layout.test.ts. This repo enables
// noUncheckedIndexedAccess (WIES does not), so the verbatim bounded-array math
// produces many index diagnostics; suppressing at file scope preserves the port
// with zero behavioral change (same approach photometry.ts F3 used) rather than
// scattering non-null assertions through validated math. The exported function
// signatures + all IES/estimator types (ies/types.ts) stay type-checked, so
// every call site is checked normally.
//
// Adaptations from the WIES source (NON-algorithmic):
//   * import specifiers use this repo NodeNext .js style;
//   * the reference tables (ESTIMATOR_TASKS / REFLECTANCE_PRESETS / findTask /
//     tasksForTarget) live in ./estimator.ts and are NOT re-declared here (the
//     solver body does not reference them);
//   * the fixtureConfiguration.ts `defaultsForMounting` re-export (DOM/React
//     coupled) is dropped;
//   * the linear/area sub-solvers take a minimal CatalogEntry instead of the
//     full WIES ProductSpec (only .family / .line are read).

import type {
  AimDirection,
  AreaEstimatorInputs,
  AreaEstimatorResult,
  CatalogEntry,
  CUTable,
  EstimatorInputs,
  EstimatorResult,
  IESParseResult,
  LinearEstimatorInputs,
  LinearEstimatorResult,
  MountingOrientation,
  PlacedFixture,
  RoomReflectances,
  RoomWall,
  TargetSurface,
} from "./types.js";
import {
  candelaAt,
  coefficientOfUtilization,
  totalLuminaireLumens,
  zonalSummary,
} from "./photometry.js";
import { M_PER_FT } from "./units.js";

const DEG = Math.PI / 180;
const FC_PER_LUX = 1 / 10.7639;

/* ── 3D vector helpers ───────────────────────────────────── */

export type V3 = [number, number, number];

function vAdd(a: V3, b: V3): V3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function vSub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vDot(a: V3, b: V3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vCross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function vLen(a: V3): number { return Math.sqrt(vDot(a, a)); }
function vNorm(a: V3): V3 {
  const L = vLen(a);
  return L > 0 ? [a[0] / L, a[1] / L, a[2] / L] : [0, 0, 0];
}

/* ── fixture local frame from mounting + aim ─────────────── */

/** For a given mounting + aim, return the world-frame unit vectors
 *  for the fixture's local axes. The IES Type C convention is:
 *    - local -z is the optical axis (where θ = 0 points)
 *    - local +x is the φ = 0 direction
 *    - local +y completes a right-handed frame
 *
 *  We anchor:
 *    - localOpticalDown_world: world direction of local -z (where the
 *      light is "primarily" pointing).
 *    - localPhiZero_world: world direction of local +x; chosen so that
 *      the φ=0 plane lies in a meaningful direction for the fixture's
 *      mounting (e.g. for a wall sconce, φ=0 runs along the wall).
 *
 *  For string aims ("down" / "up" / "forward") we pick natural
 *  defaults; the {tiltDeg, rotDeg} object form lets advanced users
 *  override.
 */
export function localFrame(
  mounting: MountingOrientation,
  aim: AimDirection,
): { opticalDown: V3; phiZero: V3 } {
  // Step 1: pick the OPTICAL axis (local -z) direction in world coords.
  let opticalDown: V3;

  if (typeof aim === "object") {
    // Custom tilt + rotation. Tilt is angle from the mounting normal
    // (ceiling-down / wall-out / floor-up) toward the "forward"
    // direction, rotated `rotDeg` around the mounting normal.
    const mountNormal = mountingNormal(mounting);
    const fwd = mountingForward(mounting);
    const right = vNorm(vCross(mountNormal, fwd));
    const tiltRad = aim.tiltDeg * DEG;
    const rotRad = aim.rotDeg * DEG;
    // Build optical direction by rotating mountNormal toward (fwd
    // rotated `rotDeg` around mountNormal) by `tiltDeg`.
    const rotFwd = vAdd(
      [fwd[0] * Math.cos(rotRad), fwd[1] * Math.cos(rotRad), fwd[2] * Math.cos(rotRad)],
      [right[0] * Math.sin(rotRad), right[1] * Math.sin(rotRad), right[2] * Math.sin(rotRad)],
    );
    opticalDown = vNorm(vAdd(
      [mountNormal[0] * Math.cos(tiltRad), mountNormal[1] * Math.cos(tiltRad), mountNormal[2] * Math.cos(tiltRad)],
      [rotFwd[0] * Math.sin(tiltRad), rotFwd[1] * Math.sin(tiltRad), rotFwd[2] * Math.sin(tiltRad)],
    ));
  } else {
    opticalDown = stringAimToDirection(mounting, aim);
  }

  // Step 2: pick the φ=0 direction. We need any unit vector
  // perpendicular to opticalDown. Use the mounting "along" direction
  // (e.g. for a wall sconce, along the wall) when it's perpendicular
  // enough to the optical axis; otherwise fall back to world +x.
  const along = mountingAlong(mounting);
  let phiZero = vNorm(vSub(along, vScale(opticalDown, vDot(along, opticalDown))));
  if (vLen(phiZero) < 0.01) {
    // Optical axis is parallel to the "along" reference; pick another.
    const fallback: V3 = Math.abs(opticalDown[2]) > 0.99 ? [1, 0, 0] : [0, 0, 1];
    phiZero = vNorm(vSub(fallback, vScale(opticalDown, vDot(fallback, opticalDown))));
  }

  return { opticalDown, phiZero };
}

function vScale(a: V3, s: number): V3 { return [a[0] * s, a[1] * s, a[2] * s]; }

/** World-frame outward normal of the surface the fixture is mounted on.
 *  Ceiling-mounted = world -z (ceiling normal points down into the room).
 *  Wall-mounted = world +y (wall at y=0 with room in +y half-space).
 *  Floor-mounted = world +z (floor normal points up into the room).
 */
export function mountingNormal(m: MountingOrientation): V3 {
  if (m === "ceiling") return [0, 0, -1];
  if (m === "wall") return [0, 1, 0];
  return [0, 0, 1];
}

/** "Forward" direction for "forward"-aimed fixtures. */
function mountingForward(m: MountingOrientation): V3 {
  if (m === "ceiling") return [0, 1, 0];
  if (m === "wall") return [0, 1, 0];
  return [0, 1, 0];
}

/** "Along the mounting surface" direction — used to anchor φ=0. */
function mountingAlong(m: MountingOrientation): V3 {
  if (m === "ceiling") return [1, 0, 0];
  if (m === "wall") return [1, 0, 0];
  return [1, 0, 0];
}

function stringAimToDirection(m: MountingOrientation, aim: "down" | "up" | "forward"): V3 {
  if (aim === "down") return [0, 0, -1];
  if (aim === "up") return [0, 0, 1];
  // "forward" — meaning depends on mounting. For wall, away from wall
  // (+y). For ceiling, default to a 30° tilt from straight down toward
  // +y (typical track-head accent). For floor, default to a 30° tilt
  // from straight up toward +y (typical bollard / outdoor flood).
  if (m === "wall") return [0, 1, 0];
  if (m === "ceiling") {
    const t = 30 * DEG;
    return vNorm([0, Math.sin(t), -Math.cos(t)]);
  }
  // floor + forward
  const t = 30 * DEG;
  return vNorm([0, Math.sin(t), Math.cos(t)]);
}

/* ── candela in a world direction ────────────────────────── */

/** Look up the IES candela value along a world direction emitted from
 *  a fixture at `pos` with the given mounting + aim. The world
 *  direction is the unit vector from the fixture pointing toward the
 *  receiving point.
 *
 *  Implementation: build the fixture's local frame, project the world
 *  direction into local coordinates, derive (θ, φ) per the Type C
 *  convention, then call existing candelaAt(). */
export function candelaInWorldDirection(
  ies: IESParseResult,
  fixture: PlacedFixture,
  worldDir: V3,
): number {
  const { opticalDown, phiZero } = localFrame(fixture.mounting, fixture.aim);
  // local axes in world coords:
  //   localZ = -opticalDown  (zenith of distribution)
  //   localX = phiZero
  //   localY = localZ × localX
  const localZ: V3 = vScale(opticalDown, -1);
  const localX = phiZero;
  const localY = vNorm(vCross(localZ, localX));

  const Lx = vDot(localX, worldDir);
  const Ly = vDot(localY, worldDir);
  const Lz = vDot(localZ, worldDir);

  // θ measured from local -z (optical axis pointing OUT of fixture).
  // local-down direction in local frame is (0, 0, -1); angle from
  // (0,0,-1) to (Lx, Ly, Lz) is acos(-Lz).
  const thetaDeg = Math.acos(Math.max(-1, Math.min(1, -Lz))) / DEG;
  const phiDeg = ((Math.atan2(Ly, Lx) / DEG) + 360) % 360;

  return candelaAt(ies, thetaDeg, phiDeg);
}

/* ── target surface helpers ──────────────────────────────── */

/** Return the outward-facing normal of a target surface (in world
 *  coords) as seen from a particular fixture. The normal always points
 *  from the target back toward the source so that `-dot(rayDir, n)`
 *  yields the (positive) cosine of the angle of incidence on the lit
 *  side of the surface. Light arriving on the back side of the
 *  surface gives a negative cosine and is dropped.
 *
 *  - horizontal target: normal flips between +z and -z depending on
 *    whether the fixture sits above or below the plane.
 *  - vertical target: surface lives at a fixed y; normal points along
 *    -y for a fixture in the +y half-space and +y for a fixture
 *    behind the surface. */
function targetNormalFor(target: TargetSurface, fixture: PlacedFixture): V3 {
  if (target.kind === "horizontal") {
    return fixture.z >= target.heightAboveFloor ? [0, 0, 1] : [0, 0, -1];
  }
  return fixture.y >= target.offsetFromOrigin ? [0, 1, 0] : [0, -1, 0];
}

/** Build the (xs, ys) sample grid on the target surface in world coords.
 *  For horizontal targets, xs/ys are room x/y at z = heightAboveFloor.
 *  For vertical targets, xs is along-wall (room x) and ys is up-wall
 *  height; the surface is at y = offset. */
function buildTargetGrid(
  target: TargetSurface,
  roomLength: number,
  roomWidth: number,
  ceilingHeight: number,
  gridN = 33,
): {
  /** Sample x positions in the target's local 2D frame. */
  xs: number[];
  /** Sample y positions in the target's local 2D frame. */
  ys: number[];
  /** Function that maps a (xi, yj) index pair back to a world point. */
  worldPoint: (i: number, j: number) => V3;
} {
  if (target.kind === "horizontal") {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < gridN; i++) xs.push((roomWidth * i) / (gridN - 1));
    for (let j = 0; j < gridN; j++) ys.push((roomLength * j) / (gridN - 1));
    return {
      xs,
      ys,
      worldPoint: (i, j) => [xs[i], ys[j], target.heightAboveFloor],
    };
  }
  // Vertical: along-wall extent uses room width, up-wall height uses
  // the user-specified `heightUp` (capped to ceilingHeight).
  const w = Math.min(target.widthAlong, roomWidth);
  const h = Math.min(target.heightUp, ceilingHeight);
  const x0 = (roomWidth - w) / 2;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < gridN; i++) xs.push(x0 + (w * i) / (gridN - 1));
  for (let j = 0; j < gridN; j++) ys.push((h * j) / (gridN - 1));
  return {
    xs,
    ys,
    worldPoint: (i, j) => [xs[i], target.offsetFromOrigin, ys[j]],
  };
}

/* ── multi-fixture point-by-point illuminance ────────────── */

/** Compute illuminance on the target surface from N placed fixtures.
 *  Returns the 2D grid (in fc) plus avg/max/min for the whole target
 *  surface, plus a separate avg/min and uniformity computed over a
 *  task-area subgrid inset from the perimeter.
 *
 *  Why the split: industry practice (IES RP-1 / RP-7) computes avg/min
 *  uniformity over the *task area*, not the entire room. Sampling
 *  edge-to-edge always pulls the perimeter strip — where direct light
 *  drops off — into the average and min, producing avg:min ratios of
 *  6–8 for completely normal layouts. The task-area inset gives a
 *  number that's directly comparable to AGi32 / DIALux task-area
 *  reports.
 *
 *  E_lux at point P = Σ_fixtures  I(direction F→P) * cos(θ_inc) / d²
 *  where cos(θ_inc) is the angle between the incoming ray and the
 *  target surface's outward normal (clamped to ≥ 0 — light arriving
 *  from the wrong side contributes nothing).
 *
 *  The task-area inset is supplied by the caller (it knows the
 *  fixture spacing); inset is in metres in the target's local 2D
 *  frame. For horizontal targets that's room x/y; for vertical
 *  targets that's along-wall / up-wall. If the caller-supplied inset
 *  would shrink the region below a single sample row/column, we fall
 *  back to the whole-grid numbers so the UI never reports NaN. */
export function multiFixtureIlluminance(
  ies: IESParseResult,
  fixtures: PlacedFixture[],
  target: TargetSurface,
  roomLength: number,
  roomWidth: number,
  ceilingHeight: number,
  gridN = 33,
  taskAreaInset: { x: number; y: number } = { x: 0, y: 0 },
): {
  xs: number[];
  ys: number[];
  values: number[][];
  avgFc: number;
  maxFc: number;
  minFc: number;
  /** Avg illuminance over the task-area subgrid (or whole grid if the
   *  inset collapses the region). */
  taskAvgFc: number;
  /** Max illuminance over the task-area subgrid. */
  taskMaxFc: number;
  /** Min illuminance over the task-area subgrid. */
  taskMinFc: number;
  /** taskAvgFc / taskMinFc — the avg:min ratio compared against the
   *  per-task uniformity threshold. */
  uniformity: number;
} {
  const { xs, ys, worldPoint } = buildTargetGrid(
    target, roomLength, roomWidth, ceilingHeight, gridN,
  );

  const values: number[][] = [];
  let sum = 0;
  let max = 0;
  let min = Infinity;

  for (let j = 0; j < ys.length; j++) {
    const row: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      const P = worldPoint(i, j);
      let E_lux = 0;
      for (const fx of fixtures) {
        const F: V3 = [fx.x, fx.y, fx.z];
        const ray = vSub(P, F);
        const d = vLen(ray);
        if (d < 0.05) continue; // skip near-singular sample
        const dir = vScale(ray, 1 / d);
        const normal = targetNormalFor(target, fx);
        const cosInc = -vDot(dir, normal);
        if (cosInc <= 0) continue; // wrong side of surface
        const I = candelaInWorldDirection(ies, fx, dir);
        E_lux += (I * cosInc) / (d * d);
      }
      const E_fc = E_lux * FC_PER_LUX;
      row.push(E_fc);
      sum += E_fc;
      if (E_fc > max) max = E_fc;
      if (E_fc < min) min = E_fc;
    }
    values.push(row);
  }
  const cells = xs.length * ys.length;
  const avg = cells > 0 ? sum / cells : 0;
  const minOut = min < Infinity ? min : 0;

  // Task-area subgrid: index ranges that fall within the inset region.
  const xRange = taskAreaRange(xs, taskAreaInset.x);
  const yRange = taskAreaRange(ys, taskAreaInset.y);
  let taskSum = 0;
  let taskMin = Infinity;
  let taskMax = 0;
  let taskCells = 0;
  for (let j = yRange.start; j < yRange.end; j++) {
    for (let i = xRange.start; i < xRange.end; i++) {
      const v = values[j][i];
      taskSum += v;
      if (v < taskMin) taskMin = v;
      if (v > taskMax) taskMax = v;
      taskCells++;
    }
  }
  // Fall back to whole-grid stats when the inset collapses the region
  // (tiny rooms, very tight fixture spacing). Better to over-report a
  // pessimistic uniformity than to surface NaN to the user.
  const taskAvg = taskCells > 0 ? taskSum / taskCells : avg;
  const taskMinOut = taskCells > 0 && taskMin < Infinity ? taskMin : minOut;
  const taskMaxOut = taskCells > 0 ? taskMax : max;
  const uniformity = taskMinOut > 0 ? taskAvg / taskMinOut : 0;

  return {
    xs,
    ys,
    values,
    avgFc: avg,
    maxFc: max,
    minFc: minOut,
    taskAvgFc: taskAvg,
    taskMaxFc: taskMaxOut,
    taskMinFc: taskMinOut,
    uniformity,
  };
}

/** Return the [start, end) index range into a sorted coordinate axis
 *  that falls at least `inset` metres inside both endpoints. Returns
 *  the full range when the inset would leave fewer than 2 cells (tiny
 *  rooms / aggressive insets). */
function taskAreaRange(
  coords: number[],
  inset: number,
): { start: number; end: number } {
  const n = coords.length;
  if (n === 0 || inset <= 0) return { start: 0, end: n };
  const lo = coords[0] + inset;
  const hi = coords[n - 1] - inset;
  if (hi <= lo) return { start: 0, end: n };
  let start = 0;
  while (start < n && coords[start] < lo) start++;
  let end = n;
  while (end > start && coords[end - 1] > hi) end--;
  if (end - start < 2) return { start: 0, end: n };
  return { start, end };
}

/* ── room cavity ratio + CU interpolation (lumen method) ─── */

export function roomCavityRatio(
  roomLength: number,
  roomWidth: number,
  ceilingHeight: number,
  workingPlaneHeight: number,
): number {
  const hCavity = Math.max(0, ceilingHeight - workingPlaneHeight);
  const area = roomLength * roomWidth;
  if (area <= 0) return 0;
  return (5 * hCavity * (roomLength + roomWidth)) / area;
}

/** Bilinear lookup of CU table at the user's reflectance + RCR.
 *  Picks the nearest reflectance row (CU table reflectance combos are
 *  discrete) and interpolates RCR linearly. */
export function interpolateCU(
  cuTable: CUTable,
  refl: RoomReflectances,
  rcr: number,
): number {
  if (cuTable.reflectances.length === 0) return 0.5;
  // Pick nearest reflectance row by Euclidean distance.
  let bestRow = 0;
  let bestDist = Infinity;
  for (let i = 0; i < cuTable.reflectances.length; i++) {
    const r = cuTable.reflectances[i];
    const d = (r.ceiling - refl.ceiling) ** 2
      + (r.wall - refl.wall) ** 2
      + (r.floor - refl.floor) ** 2;
    if (d < bestDist) { bestDist = d; bestRow = i; }
  }
  const row = cuTable.values[bestRow];
  const rcrs = cuTable.rcrs;
  if (rcr <= rcrs[0]) return row[0];
  if (rcr >= rcrs[rcrs.length - 1]) return row[row.length - 1];
  for (let i = 1; i < rcrs.length; i++) {
    if (rcr <= rcrs[i]) {
      const t = (rcr - rcrs[i - 1]) / (rcrs[i] - rcrs[i - 1]);
      return row[i - 1] * (1 - t) + row[i] * t;
    }
  }
  return row[row.length - 1];
}

/* ── fixture placement ───────────────────────────────────── */

/** Pick the smallest balanced rectangle (rows × cols ≥ N) for a
 *  ceiling-mounted horizontal-target layout. Used by solveLayout
 *  to snap the lumen-method N up to a uniform grid so the heatmap
 *  always covers the full room — eliminates the partial-last-row
 *  pattern that made the bug-report screenshot show a corner gap.
 *
 *  Cost minimisation:
 *      cost = deficit + LAMBDA · |ln(gridAspect / roomAspect)|
 *
 *  with deficit = rows·cols − N and gridAspect = cols/rows. LAMBDA = 1
 *  keeps the algorithm aggressive about reducing deficit (good for
 *  "minimise over-spec") while still rejecting oblong grids in
 *  square rooms. ASPECT_BAND = 2.5 hard-filters candidates whose
 *  grid aspect is more than 2.5× off the room aspect (rejects 1×17
 *  in square rooms, 1×8 in wide rooms, etc.). If the filter rejects
 *  every candidate (e.g. a 4×120 ft corridor at N=2), the function
 *  falls back to the unfiltered min-cost candidate so the caller
 *  always gets a valid shape.
 *
 *  Tie-break (lex ascending): cost → deficit → mismatch → cols.
 *  The final `cols`-ascending tie-break makes the orientation
 *  deterministic for square rooms (where rows×cols and cols×rows
 *  have identical cost): smaller cols wins, e.g. N=14 → 3×5 not
 *  5×3. Locked in by the regression test in
 *  _verify-search-undercount.mts. */
export function pickGridShape(
  N: number,
  roomLength: number,
  roomWidth: number,
): { rows: number; cols: number; count: number } {
  if (N <= 0) return { rows: 0, cols: 0, count: 0 };
  if (N === 1) return { rows: 1, cols: 1, count: 1 };

  const roomAspect = roomLength > 0 ? roomWidth / roomLength : 1;
  const ASPECT_BAND = 2.5;
  const LAMBDA = 1.0;
  const minAspect = roomAspect / ASPECT_BAND;
  const maxAspect = roomAspect * ASPECT_BAND;

  type Cand = {
    rows: number;
    cols: number;
    count: number;
    deficit: number;
    mismatch: number;
    cost: number;
  };
  const filtered: Cand[] = [];
  const all: Cand[] = [];
  for (let rows = 1; rows <= N; rows++) {
    const cols = Math.ceil(N / rows);
    const gridAspect = cols / rows;
    const deficit = rows * cols - N;
    const mismatch = Math.abs(Math.log(gridAspect / roomAspect));
    const cost = deficit + LAMBDA * mismatch;
    const cand: Cand = { rows, cols, count: rows * cols, deficit, mismatch, cost };
    all.push(cand);
    if (gridAspect >= minAspect && gridAspect <= maxAspect) filtered.push(cand);
  }

  // Lex tie-break with a small epsilon on cost/mismatch so 1-ULP
  // floating-point drift between mathematically-equal values (e.g.
  // |ln(1.5)| vs |ln(2/3)| in a square room) doesn't sneakily break
  // ties before the cols-ascending fallback can fire. Without this,
  // N=14 in 14×14 ft would non-deterministically pick 5×3 vs 3×5
  // depending on how Math.log rounds.
  const TIE_EPS = 1e-9;
  const pool = filtered.length > 0 ? filtered : all;
  pool.sort((a, b) => {
    if (Math.abs(a.cost - b.cost) > TIE_EPS) return a.cost - b.cost;
    if (a.deficit !== b.deficit) return a.deficit - b.deficit;
    if (Math.abs(a.mismatch - b.mismatch) > TIE_EPS) return a.mismatch - b.mismatch;
    return a.cols - b.cols;
  });
  const best = pool[0];
  return { rows: best.rows, cols: best.cols, count: best.count };
}

/** Place `count` fixtures inside the room according to mounting and
 *  target. Returns world positions and the per-fixture mounting/aim
 *  (constant per call — every fixture in a layout shares orientation).
 *
 *  Layout strategy:
 *  - Horizontal target on ceiling-mount → rectangular grid in x/y.
 *    When `gridShape` is supplied (the post-snap path used by
 *    solveLayout), the function emits the full `rows × cols`
 *    rectangle so the heatmap is always uniformly tiled. When
 *    `gridShape` is omitted (used during the lumen-method iteration
 *    in solveLayout, where placement doesn't affect fc for the
 *    horizontal-floor + CU case), the legacy `cols = round(sqrt(N))`
 *    derivation is used and exactly `count` fixtures are placed
 *    (the last row may be partial).
 *  - Horizontal target on wall/floor mount → single row of fixtures
 *    along the y=0 wall (sconces / cove / in-grade strip).
 *  - Vertical target → single row (1×N or N×1) parallel to the target
 *    wall, at the mounting plane and at a sensible setback. Setback
 *    follows the IALD wall-wash rule of thumb: ceiling-mounted
 *    washers sit ~25–30 % of (ceiling − targetTop) out from the wall;
 *    here we use 25 % of `ceilingHeight - target.heightUp`. */
export function placeFixtures(
  inputs: EstimatorInputs,
  count: number,
  gridShape?: { rows: number; cols: number },
): PlacedFixture[] {
  const { mounting, aim, target, roomLength, roomWidth, ceilingHeight } = inputs;
  if (count <= 0) return [];

  const mountZ = mountingPlaneZ(mounting, ceilingHeight);

  if (target.kind === "horizontal") {
    // Ceiling mount: full 2D rectangular grid across the room.
    if (mounting === "ceiling") {
      let cols: number, rows: number;
      if (gridShape) {
        cols = Math.max(1, gridShape.cols);
        rows = Math.max(1, gridShape.rows);
      } else {
        const aspect = roomWidth / roomLength;
        cols = Math.max(1, Math.round(Math.sqrt(count * aspect)));
        rows = Math.max(1, Math.ceil(count / cols));
      }
      const dx = roomWidth / cols;
      const dy = roomLength / rows;
      const fixtures: PlacedFixture[] = [];
      if (gridShape) {
        // Snap-driven path: emit the full rows × cols rectangle so the
        // layout is always uniformly tiled. The caller is responsible
        // for ensuring `count === rows × cols` (solveLayout does this
        // via pickGridShape).
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            fixtures.push({
              x: dx * (c + 0.5),
              y: dy * (r + 0.5),
              z: mountZ,
              mounting,
              aim,
            });
          }
        }
      } else {
        // Legacy path used during the lumen-method iteration: emit
        // exactly `count` fixtures (partial last row OK). Placement
        // does not affect fc in the horizontal-floor + CU case where
        // headline fc is the analytical lumen-method formula.
        outer: for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            fixtures.push({
              x: dx * (c + 0.5),
              y: dy * (r + 0.5),
              z: mountZ,
              mounting,
              aim,
            });
            if (fixtures.length >= count) break outer;
          }
        }
      }
      return fixtures;
    }
    // Wall or floor mount with horizontal target = single row of
    // fixtures along the y=0 wall (sconces / cove / in-grade strip).
    const dx = roomWidth / count;
    const z = mounting === "wall" ? Math.min(ceilingHeight * 0.75, ceilingHeight - 0.3) : 0;
    const fixtures: PlacedFixture[] = [];
    for (let c = 0; c < count; c++) {
      fixtures.push({
        x: dx * (c + 0.5),
        y: mounting === "wall" ? 0 : 0.15, // 6" off the wall for in-grade
        z,
        mounting,
        aim,
      });
    }
    return fixtures;
  }

  // Vertical target — single row of fixtures parallel to the target wall.
  const w = Math.min(target.widthAlong, roomWidth);
  const x0 = (roomWidth - w) / 2;
  const dx = w / count;
  // Setback distance from target wall (along -y from target's y).
  let setback: number;
  if (mounting === "ceiling") {
    setback = Math.max(0.3, (ceilingHeight - target.heightUp) * 0.3);
  } else if (mounting === "floor") {
    setback = 0.6; // typical in-grade / cove offset
  } else {
    // wall-mounted on the *opposite* wall, looking forward
    setback = 0; // fixture sits on the opposite wall (y = 0)
  }
  const fixtureY = Math.max(0, target.offsetFromOrigin - setback);

  // For wall washers we usually want ALL fixtures aimed at the target
  // wall — keep the same aim per call (the user picked it).
  const fixtures: PlacedFixture[] = [];
  for (let c = 0; c < count; c++) {
    fixtures.push({
      x: x0 + dx * (c + 0.5),
      y: fixtureY,
      z: mountZ,
      mounting,
      aim,
    });
  }
  return fixtures;
}

function mountingPlaneZ(mounting: MountingOrientation, ceilingHeight: number): number {
  if (mounting === "ceiling") return ceilingHeight;
  if (mounting === "floor") return 0;
  // wall — anchor sconces near the ceiling by default
  return Math.min(ceilingHeight * 0.75, ceilingHeight - 0.3);
}

/* ── envelope canary ─────────────────────────────────────── */

/** One-shot console.warn when CU is being computed outside the
 *  validated envelope of the three-cavity flux-transfer model in
 *  photometry.ts. Does NOT refuse to compute — the model still
 *  produces a CU value — but surfaces in the dev-tools console
 *  that the caller is operating where simplifications drift.
 *
 *  Envelope:
 *    - RCR > 10. The CU table only spans 0-10; values outside
 *      this range are clamped during interpolation, masking
 *      unusually tall cavities.
 *    - Any reflectance > 0.9. The Lambertian / no-specular
 *      assumption breaks for near-mirror finishes.
 *    - Room aspect ratio > 4:1. The equivalent-square cavity
 *      simplification documented in photometry.ts loses the
 *      most accuracy in long/narrow rooms.
 *
 *  Repeats are deduplicated by a stringified key, so each
 *  unique (rcr-bucket, refl, aspect-bucket) combo logs at most
 *  once per page session. */
const ENVELOPE_LOG_SEEN = new Set<string>();

function warnIfOutsideEnvelope(
  rcr: number,
  refl: RoomReflectances,
  roomLength: number,
  roomWidth: number,
): void {
  if (typeof console === "undefined" || typeof console.warn !== "function") return;

  const flagged: string[] = [];
  if (rcr > 10) flagged.push(`RCR=${rcr.toFixed(2)} > 10`);
  if (refl.ceiling > 0.9) flagged.push(`ρ_ceiling=${refl.ceiling.toFixed(2)} > 0.9`);
  if (refl.wall > 0.9) flagged.push(`ρ_wall=${refl.wall.toFixed(2)} > 0.9`);
  if (refl.floor > 0.9) flagged.push(`ρ_floor=${refl.floor.toFixed(2)} > 0.9`);
  const aspect = Math.max(roomLength, roomWidth) / Math.max(0.01, Math.min(roomLength, roomWidth));
  if (aspect > 4) flagged.push(`aspect=${aspect.toFixed(2)}:1 > 4:1`);
  if (flagged.length === 0) return;

  // Bucket continuous values so near-identical scenarios coalesce
  // into a single log entry rather than spamming on every drag of a
  // slider in the search form.
  const key = JSON.stringify({
    rcr_b: Math.round(rcr * 2) / 2,
    refl,
    aspect_b: Math.round(aspect * 4) / 4,
  });
  if (ENVELOPE_LOG_SEEN.has(key)) return;
  ENVELOPE_LOG_SEEN.add(key);
  console.warn(
    `[WIES] CU computed outside the validated three-cavity flux-transfer envelope: ${flagged.join("; ")}. ` +
    `Result is still produced; expect drift from a full real-room radiosity. ` +
    `See photometry.ts coefficientOfUtilization docstring for the documented simplifications.`,
  );
}

/* ── lumen-method seed ───────────────────────────────────── */

/** IESNA lumen-method count (horizontal target, enclosed room only):
 *      N = (E_target_fc * Area_ft²) / (Φ_down_lm * CU * LLF)
 *
 *  Returns both the raw (real-valued) result and the integer ceiling.
 *  The raw is stashed on EstimatorResult.lumenMethodNRaw for the
 *  diagnostic panel; the snapped ceiling is what the iterative
 *  solver seeds with. */
export function lumenMethodCount(
  ies: IESParseResult,
  inputs: EstimatorInputs,
  cu: number,
): { raw: number; snapped: number } {
  const areaFt2 = (inputs.roomLength / M_PER_FT) * (inputs.roomWidth / M_PER_FT);
  const phiDown = totalLuminaireLumens(ies); // approx; downward dominant
  if (phiDown <= 0 || cu <= 0 || inputs.llf <= 0) return { raw: 1, snapped: 1 };
  const raw = (inputs.targetFc * areaFt2) / (phiDown * cu * inputs.llf);
  return { raw, snapped: Math.max(1, Math.ceil(raw)) };
}

/* ── degenerate-geometry detection ───────────────────────── */

/** Return a description of why a fixture/aim/target combination is
 *  physically incapable of producing direct illumination on the
 *  target, or null when the geometry is fine.
 *
 *  We check the four combinations the v1 estimator can express that
 *  predictably produce ~0 fc results — the kind of "the number looks
 *  broken" outcome where the user blames the product rather than the
 *  geometry. The solver still runs and reports its tiny number; this
 *  guard just tells the UI to surface a yellow callout explaining it.
 */
export function detectDegenerate(
  inputs: EstimatorInputs,
): { reason: string; suggestion: string } | null {
  const { mounting, aim, target, ceilingHeight } = inputs;
  const aimStr = typeof aim === "string" ? aim : null;

  // Wall mount: fixture sits at ~75% of ceiling height by default
  // (see mountingPlaneZ). If the user picks a horizontal target on
  // the wrong side of that plane relative to the aim, the direct
  // contribution drops to a graze.
  const wallMountZ = Math.min(ceilingHeight * 0.75, ceilingHeight - 0.3);

  if (mounting === "wall" && target.kind === "horizontal") {
    if (aimStr === "up" && target.heightAboveFloor < wallMountZ) {
      return {
        reason: "Wall fixture aimed up cannot directly illuminate a horizontal target below the fixture height.",
        suggestion: "Try aim = down for a sconce downwash, or move the target plane near the ceiling for an uplight wash.",
      };
    }
    if (aimStr === "down" && target.heightAboveFloor > wallMountZ) {
      return {
        reason: "Wall fixture aimed down cannot directly illuminate a horizontal target above the fixture height.",
        suggestion: "Try aim = up to wash the ceiling, or lower the target to the working plane / floor.",
      };
    }
  }

  if (mounting === "floor" && aimStr === "down" && target.kind === "horizontal" && target.heightAboveFloor > 0.05) {
    return {
      reason: "Floor-mounted fixture aimed down cannot directly illuminate a horizontal target above the floor.",
      suggestion: "Try aim = up (to wash the ceiling) or aim = forward (to graze a wall).",
    };
  }

  // Vertical target on the same wall the fixture is mounted to with
  // aim along that wall = light grazes parallel to the surface.
  if (
    mounting === "wall"
    && target.kind === "vertical"
    && target.offsetFromOrigin <= 0.1
    && (aimStr === "up" || aimStr === "down")
  ) {
    return {
      reason: "A wall-mounted fixture cannot wash the wall it is mounted on — light leaves parallel to the surface.",
      suggestion: "Choose a vertical target on a different wall, or change mounting to ceiling for a wall-wash effect.",
    };
  }

  return null;
}

/* ── solver ──────────────────────────────────────────────── */

/** Solve for the smallest fixture grid that meets or exceeds the
 *  user's target illuminance. Strategy:
 *
 *  - For horizontal floor + room walls defined: use lumen method as
 *    a starting seed, then refine with point-by-point. The reported
 *    actualFc is `max(direct_pp, lumen_method_total)` — point-by-point
 *    is direct-only and underreports interreflection; the lumen method
 *    accounts for it via CU.
 *  - For everything else: iterate from N=1 upward until point-by-point
 *    avg meets target (cap at 144 fixtures for sanity).
 *
 *  Benchmark vs WAC Downlighting Estimator (waclighting.com/downlighting-
 *  estimator/, FOLD Systems widget, 2026-05-06; refreshed post-Phase-B
 *  on 2026-05-11 with the three-cavity flux-transfer CU model and
 *  evaluateLayout / placeFixtures fixes for the May 2026 search
 *  undercount bug, then again post-Phase-C with the snap-to-uniform-
 *  grid pickGridShape integration):
 *
 *    SKU: R2RD2T (Volta 2") narrow N optic, 15W. WIES uses the
 *    NTWA-WT 4000K IES file (651 lumens declared, ~14.91 W actual);
 *    WAC's tool only carries the older fixed-CCT N830-WT 3000K
 *    variant.
 *
 *    Inputs: 30 fc target, 80/50/30 reflectance (closest WAC option
 *    to our 80/50/20), LLF 0.9 (closest to 0.85), 2.5 ft WP.
 *
 *      Room        | WAC | WIES N_lm | WIES placed | placed cols×rows | WIES fc | WIES CU
 *      10x10x9 ft  |  4  |     8     |       8     |      2 × 4       |  32.5   |  0.69
 *      13x13x9 ft  |  6  |    13     |      15     |      3 × 5       |  36.8   |  0.71
 *      20x20x10 ft | 16  |    29     |      30     |      5 × 6       |  31.8   |  0.72
 *
 *    "WIES N_lm" is the analytical lumen-method count (Phase B's
 *    answer); "WIES placed" is the post-snap count after the Phase C
 *    `pickGridShape` step rounds N up to a uniform rectangular
 *    grid. The 13×13 room shows the largest snap (+15 %, deficit 2)
 *    because 13 is prime; the 20×20 case is +1 fixture for a 5×6
 *    grid; the 10×10 case factors cleanly so no snap is required.
 *    Ground-truth values are locked in by _verify-search-undercount
 *    .mts §6.3 — refresh that file (NOT this comment) when re-
 *    deriving the table.
 *
 *    WIES still requires roughly 2x more fixtures than WAC's tool;
 *    the gap is unchanged by Phase C since the snap is a small
 *    delta on top of the lumen-method answer.
 *
 *    Root cause of the gap remains the same: WAC's tool effectively
 *    uses ~1450 lm per fixture (back-solved from their 6-fix / 41-fc
 *    / CU 0.88 / LLF 0.9 answer in Room B), versus the 651 lm
 *    declared in our 2021-issued IES file. The old FOLD Systems
 *    widget (© 2012/2013) appears to use a different / older
 *    photometric data set than the IES files WAC publishes today,
 *    OR uses LED-chip lumens rather than fixture-delivered lumens.
 *
 *    Conclusion: WIES matches the user's hand-calc lumen-method
 *    (CU = 0.71, 14 fixtures at 30 fc for the R2SD2T bug-report case
 *    that snaps to 15) and matches the IES file's literal
 *    photometric data. Do NOT tune toward WAC's tool — that would
 *    mean inflating lumens that aren't in the IES data. WIES is
 *    conservative (predicts more fixtures than WAC's tool), which is
 *    the safer specifier outcome.
 */
export function solveLayout(
  ies: IESParseResult,
  inputs: EstimatorInputs,
  entry?: CatalogEntry,
): EstimatorResult {
  const isHorizontalFloor =
    inputs.target.kind === "horizontal"
    && inputs.target.heightAboveFloor < inputs.ceilingHeight * 0.9;

  // Compute CU + RCR when applicable.
  const cuTable = coefficientOfUtilization(ies);
  let cu = NaN, rcr = NaN, includesCUBonus = false;
  if (isHorizontalFloor && inputs.target.kind === "horizontal") {
    rcr = roomCavityRatio(
      inputs.roomLength, inputs.roomWidth,
      inputs.ceilingHeight, inputs.target.heightAboveFloor,
    );
    cu = interpolateCU(cuTable, inputs.reflectances, rcr);
    includesCUBonus = true;
    warnIfOutsideEnvelope(rcr, inputs.reflectances, inputs.roomLength, inputs.roomWidth);
  }

  // Pick the wattage source: IES file first (most accurate), then the
  // catalog entry, then mark unknown so the UI can render "—".
  const wattsPerFixture =
    ies.inputWatts > 0
      ? ies.inputWatts
      : (entry?.wattage ?? 0);
  const wattsUnknown = wattsPerFixture <= 0;

  // Initial count guess.
  const seed = isHorizontalFloor && cu > 0
    ? lumenMethodCount(ies, inputs, cu)
    : { raw: NaN, snapped: 1 };
  let count = seed.snapped;

  // Iterate up to a reasonable cap, growing count until target met.
  // This loop produces `lumenMethodN` — the analytical lumen-method
  // answer (or the PBP-iterated count for non-horizontal layouts).
  // The snap step below converts that into a buildable rectangular
  // grid; if the snap raises the count by 1-3 fixtures, the surplus
  // is surfaced honestly in the Estimator UI ("Calculated: 17 —
  // placed 18 for a uniform grid").
  const MAX = 144;
  let result = evaluateLayout(ies, inputs, count, cu, rcr, includesCUBonus, wattsPerFixture);
  while (result.actualFc < inputs.targetFc && count < MAX) {
    count++;
    result = evaluateLayout(ies, inputs, count, cu, rcr, includesCUBonus, wattsPerFixture);
  }

  const lumenMethodN = count;

  // Snap to a uniform rectangular grid for ceiling-mounted horizontal
  // targets. Other mounting types are already linear arrays (no snap
  // needed). The snap runs even when no CU bonus applies — so a
  // ceiling-mounted uplight at the ceiling plane also gets a clean
  // grid; fc may shift proportionally to the count change but the
  // uniform layout is the visually-correct buildable answer.
  const shouldSnap =
    inputs.mounting === "ceiling"
    && inputs.target.kind === "horizontal"
    && count > 0;
  if (shouldSnap) {
    const snap = pickGridShape(count, inputs.roomLength, inputs.roomWidth);
    if (snap.count > 0) {
      result = evaluateLayout(
        ies, inputs, snap.count, cu, rcr, includesCUBonus, wattsPerFixture,
        { rows: snap.rows, cols: snap.cols },
      );
    }
  }

  // The solver hit the cap and we still haven't met target — flag as
  // unreachable so the UI can swap the "Below X fc" pill for an
  // explicit "physically can't reach this target" message. Computed
  // post-snap so the message reflects the buildable layout.
  const unreachable =
    result.count >= MAX && result.actualFc < inputs.targetFc;

  // Indirect working-plane contribution from a one-bounce ceiling
  // reflection. Only meaningful when the install is genuinely
  // pointing light at the ceiling and the user is asking about a
  // working-plane (not a directly-lit ceiling) — i.e. wall sconce
  // uplight or floor cove uplight aimed at the ceiling.
  const indirectWPFc = computeIndirectWPFc(ies, inputs, result.count);

  const degenerate = detectDegenerate(inputs);

  return {
    ...result,
    unreachable: unreachable || undefined,
    indirectWPFc,
    degenerate: degenerate ?? undefined,
    wattsUnknown: wattsUnknown || undefined,
    lumenMethodN,
    lumenMethodNRaw: Number.isFinite(seed.raw) ? seed.raw : undefined,
  };
}

/** First-order indirect working-plane illuminance from one ceiling
 *  bounce. Used when the install is aimed up (ceiling washes the
 *  ceiling), where the specifier really cares about the bounce-back
 *  light at desk height — not the ceiling itself.
 *
 *  Model:    E_WP_indirect ≈  N · Φ_up · ρ_ceiling · (1 - ρ_avg)  /  Area_target
 *
 *  This is a single-bounce approximation; full radiosity would add a
 *  geometric series for higher bounces. Documented as "first-order"
 *  in the UI footnote so users know to validate in AGi32 for spec. */
function computeIndirectWPFc(
  ies: IESParseResult,
  inputs: EstimatorInputs,
  count: number,
): number | undefined {
  const { mounting, aim, target, ceilingHeight, reflectances, llf, roomLength, roomWidth } = inputs;
  const aimStr = typeof aim === "string" ? aim : null;
  if (aimStr !== "up") return undefined;
  if (mounting !== "wall" && mounting !== "floor") return undefined;
  // Only meaningful when the user is asking about a horizontal target
  // somewhere below the ceiling — i.e. the working plane the bounce
  // ends up at.
  if (target.kind !== "horizontal") return undefined;
  // If the target is essentially at the ceiling, the user is asking
  // about the ceiling wash itself; the direct point-by-point already
  // shows that, no separate indirect estimate needed.
  if (target.heightAboveFloor > ceilingHeight * 0.9) return undefined;

  const phiUpLumens = zonalSummary(ies).upward;
  if (!Number.isFinite(phiUpLumens) || phiUpLumens <= 0) return undefined;

  const areaFt2 = (roomLength / M_PER_FT) * (roomWidth / M_PER_FT);
  if (areaFt2 <= 0) return undefined;

  const rhoAvg = (reflectances.wall + reflectances.floor) / 2;
  const absorption = Math.max(0.05, 1 - rhoAvg); // floor at 5% so a near-mirror room doesn't divide by ~0
  // E (fc) ≈ N · Φ_up (lm) · ρ_ceil · (1 - ρ_avg) · LLF / Area (ft²).
  // The (1 - ρ_avg) term approximates the fraction of bounced light
  // that reaches the working plane on the first reflection rather
  // than re-bouncing off the walls/floor; tighter rooms lose more
  // light to absorption before it lands on the target.
  const E_fc = (count * phiUpLumens * reflectances.ceiling * absorption * llf) / areaFt2;
  return Number.isFinite(E_fc) && E_fc > 0 ? E_fc : undefined;
}

export function evaluateLayout(
  ies: IESParseResult,
  inputs: EstimatorInputs,
  count: number,
  cu: number,
  rcr: number,
  includesCUBonus: boolean,
  wattsPerFixture: number,
  gridShape?: { rows: number; cols: number },
): EstimatorResult {
  const fixtures = placeFixtures(inputs, count, gridShape);

  // When the caller supplies an explicit gridShape (the snap-driven
  // path from solveLayout), use it directly so spacingX / spacingY
  // report the same pitch placeFixtures laid out — and so cols × rows
  // === count is preserved as a downstream invariant. For the legacy
  // path (no shape), mirror the (cols × rows) shape placeFixtures
  // picks via the round-sqrt heuristic; this matches the partial-row
  // layout used during the lumen-method iteration.
  const actualCount = fixtures.length;
  let cols: number, rows: number;
  if (gridShape) {
    cols = Math.max(1, gridShape.cols);
    rows = Math.max(1, gridShape.rows);
  } else if (inputs.target.kind === "vertical" || inputs.mounting !== "ceiling") {
    cols = actualCount; rows = 1;
  } else {
    const aspect = inputs.roomWidth / inputs.roomLength;
    cols = Math.max(1, Math.round(Math.sqrt(actualCount * aspect)));
    rows = Math.max(1, Math.ceil(actualCount / cols));
  }
  const spacingX = cols > 0 ? inputs.roomWidth / cols : inputs.roomWidth;
  const spacingY = rows > 0 ? inputs.roomLength / rows : inputs.roomLength;

  // Task-area inset for the uniformity calculation. Industry practice
  // (IES RP-1 / RP-7) computes avg:min over the task area, not the
  // entire room — a 0.6 m / ~2 ft perimeter strip is the common
  // exclusion. We also widen to half a fixture spacing on each side
  // so we're always sampling between fixtures, even in big rooms with
  // sparse layouts. For vertical targets, the up-wall extent is
  // already user-bounded by `heightUp`, so we only inset along-wall.
  const TASK_AREA_FLOOR_M = 0.6;
  const insetX = Math.max(TASK_AREA_FLOOR_M, spacingX * 0.5);
  const insetY = inputs.target.kind === "vertical"
    ? 0
    : Math.max(TASK_AREA_FLOOR_M, spacingY * 0.5);

  // 51×51 sample grid (~3.3" cells in a 14 ft room) is fine enough to
  // resolve the per-fixture peaks of a typical downlight layout
  // without smearing across them. The earlier 25×25 grid (~7" cells)
  // was just coarse enough that adjacent-fixture rows could blur into
  // each other in the contour rendering, making inter-fixture valleys
  // look brighter than wall-adjacent points.
  const grid = multiFixtureIlluminance(
    ies, fixtures, inputs.target,
    inputs.roomLength, inputs.roomWidth, inputs.ceilingHeight, 51,
    { x: insetX, y: insetY },
  );

  // Headline avg fc.
  //
  // Enclosed-room horizontal target: use the LLF-adjusted lumen
  // method as the headline. Direct point-by-point ignores wall
  // absorption (multiFixtureIlluminance sums I·cosInc/d² with no
  // reflection model), so it systematically *overstates* fc in
  // finite rooms. The earlier `max(grid, lumenMethodFc)` rule
  // silently dropped LLF whenever direct PBP > lumenMethodFc and let
  // that overstatement become the headline — which is precisely how
  // the search under-spec'd fixture counts in the May 2026 bug
  // report. The lumen method with proper CU + LLF is the correct
  // headline for enclosed-room sizing; the PBP grid still drives
  // the heatmap (scaled below by `llfScale`).
  //
  // Other targets (vertical wash, uplight on the ceiling): apply
  // LLF to the direct PBP result. `multiFixtureIlluminance` is pure
  // direct candela summation — no interreflection contribution — so
  // multiplying by inputs.llf does not double-count.
  let actualFc;
  if (includesCUBonus && cu > 0 && inputs.target.kind === "horizontal") {
    const phiDown = totalLuminaireLumens(ies);
    const areaFt2 = (inputs.roomLength / M_PER_FT) * (inputs.roomWidth / M_PER_FT);
    actualFc = (actualCount * phiDown * cu * inputs.llf) / Math.max(1, areaFt2);
  } else {
    actualFc = grid.avgFc * inputs.llf;
  }

  const totalWatts = actualCount * Math.max(0, wattsPerFixture);
  const targetAreaFt2 = inputs.target.kind === "horizontal"
    ? (inputs.roomLength / M_PER_FT) * (inputs.roomWidth / M_PER_FT)
    : (Math.min(inputs.target.widthAlong, inputs.roomWidth) / M_PER_FT)
      * (Math.min(inputs.target.heightUp, inputs.ceilingHeight) / M_PER_FT);
  const wPerFt2 = targetAreaFt2 > 0 ? totalWatts / targetAreaFt2 : 0;

  // Apply LLF to max/min as well so reporting stays consistent.
  const llfScale = includesCUBonus
    ? (actualFc / Math.max(0.0001, grid.avgFc))
    : inputs.llf;

  return {
    count: actualCount,
    cols,
    rows,
    spacingX,
    spacingY,
    fixtures,
    actualFc,
    maxFc: grid.maxFc * llfScale,
    minFc: grid.minFc * llfScale,
    taskAvgFc: grid.taskAvgFc * llfScale,
    taskMaxFc: grid.taskMaxFc * llfScale,
    taskMinFc: grid.taskMinFc * llfScale,
    uniformity: grid.uniformity,
    totalWatts,
    wPerFt2,
    cu,
    rcr,
    includesCUBonus,
    grid: {
      xs: grid.xs,
      ys: grid.ys,
      values: grid.values.map((row) => row.map((v) => v * llfScale)),
    },
  };
}

/* ── default inputs ──────────────────────────────────────── */

/** A reasonable starting set of inputs for a downlight in an office.
 *  The Layout Estimator panel uses this when first opened, with the
 *  user's existing isolux room dimensions taken as the room. */
export function defaultEstimatorInputs(): EstimatorInputs {
  return {
    mounting: "ceiling",
    aim: "down",
    target: { kind: "horizontal", heightAboveFloor: 0.76 }, // 30" desk
    roomLength: 4.27, // 14 ft
    roomWidth: 4.27,
    ceilingHeight: 2.74, // 9 ft
    reflectances: { ceiling: 0.8, wall: 0.5, floor: 0.2 },
    targetFc: 30,
    taskKey: "office-general",
    llf: 0.85,
    unit: "fc",
    system: "imperial",
  };
}


/* ════════════════════════════════════════════════════════════════════
   linear-continuous solver (tape light) — Phase 1
   ────────────────────────────────────────────────────────────────────

   Tape's IES file IS one foot of strip, so the photometric data is
   already per-foot. Sizing is by run length, not fixture count, and
   the user-facing numbers are totals × LLF, plus a driver count from
   the connected wattage. No grid solver, no lumen-method, no PBP.

   Phase 2 (see `solveLineSourceIlluminance` below) overlays a
   line-source point-by-point onto a target strip for the cove /
   under-cabinet / perimeter-accent presets.
   ════════════════════════════════════════════════════════════════════ */

/** Default per-foot cut increment by InvisiLED family code. Values
 *  in canonical metres; the runtime UI converts to ft / mm for
 *  display. Derived from WAC's published cut-mark conventions per
 *  product line (InvisiLED Pro / Pro 2 / Pro 3 / Lite / Classic).
 *  The pickup heuristic in `defaultCutIncrementM` uses `line` plus
 *  family hints; anything we don't recognise falls back to ~100 mm
 *  (4"), the typical InvisiLED Pro increment, so the cut-count
 *  display still has *some* number to show. */
const DEFAULT_CUT_INCREMENT_M_BY_FAMILY: Record<string, number> = {
  // ~4" / ~100 mm: InvisiLED Pro 3 (LED-TE24), InvisiLED Pro 2 (LED-TX24),
  //                InvisiLED Pro (LED-T24), InvisiLED Pro Outdoor.
  "LED-TE24":     4 * 0.0254,
  "LED-TX24":     4 * 0.0254,
  "LED-T24":      4 * 0.0254,
  "LED-TO24":     4 * 0.0254,
  // ~2" / ~50 mm: InvisiLED Lite.
  "LED-T24-570":  2 * 0.0254,
  // 25 mm: InvisiLED Classic.
  "LED-T24-572":  0.025,
};

/** Default driver max load (W) for tape-light families. WAC's
 *  InvisiLED ecosystem ships drivers in 60 / 96 / 150 / 192 W
 *  sizes; we pick the middle-of-the-pack 96 W default because (a)
 *  it's the most-quoted default in WAC's spec sheets and (b) it
 *  lets a typical 16-25 ft run land on a single driver without
 *  picking the largest size by default. The user can always
 *  override in the input panel. */
export const DEFAULT_DRIVER_MAX_W = 96;

/** Resolve the cut increment to use for a given product. Prefers an
 *  explicit user input, then the per-family lookup above, then the
 *  ~100 mm fallback so the result always has *a* sane number. */
export function defaultCutIncrementM(product?: CatalogEntry | null): number {
  if (!product) return 4 * 0.0254;
  const direct = DEFAULT_CUT_INCREMENT_M_BY_FAMILY[product.family];
  if (direct) return direct;
  // The catalog uses suffixes like "LED-T24-570" / "LED-T24-572";
  // the bare "LED-T24" prefix covers the rest of the Pro / Pro 2 /
  // Pro 3 / Outdoor families.
  for (const prefix of Object.keys(DEFAULT_CUT_INCREMENT_M_BY_FAMILY)) {
    if (product.family.startsWith(prefix)) {
      return DEFAULT_CUT_INCREMENT_M_BY_FAMILY[prefix];
    }
  }
  return 4 * 0.0254;
}

/** Defaults for a fresh linear-configurator session. 10 ft (~3 m)
 *  is a friendly starting run length — long enough that the totals
 *  feel real, short enough that one default driver always fits.
 *  Defaults to the cove-uplight application so the user lands on a
 *  preset that includes installation context (cove ledge, ceiling
 *  wash, working plane), not a free-form preset that produces
 *  numbers without spatial context. The cove-to-ceiling distance
 *  is seeded at 0.5 ft so the illuminance kernel produces a result
 *  immediately. */
export function defaultLinearInputs(): LinearEstimatorInputs {
  return {
    runLengthM: 10 * M_PER_FT,
    llf: 0.85,
    unit: "fc",
    system: "imperial",
    application: "cove-uplight",
    coveToCeilingM: 0.5 * M_PER_FT,
    // Room context: 14 × 14 ft × 9 ft ceiling is a recognisable
    // residential / small-commercial room with a comfortable
    // cove-to-ceiling above an 8'4" cove ledge. The run defaults
    // to the south wall starting at the corner; the user can
    // re-anchor in the inputs panel.
    roomLengthM: 14 * M_PER_FT,
    roomWidthM: 14 * M_PER_FT,
    ceilingHeightM: 9 * M_PER_FT,
    runWall: "south",
    runStartM: 0,
  };
}

/** Snap a length UP to the next cut mark. Returns the input length
 *  unchanged when no cut increment is set (the result.cutCount field
 *  is then left undefined and the UI hides the cut row). */
export function snapUpToCut(lengthM: number, cutM: number | undefined): number {
  if (!cutM || cutM <= 0) return lengthM;
  const steps = Math.ceil(lengthM / cutM);
  return steps * cutM;
}

/** Solve the tape-light layout for a single run.
 *
 *  Per-foot lumens come from the IES file's zonal-integrated total
 *  (`totalLuminaireLumens(ies)`); per-foot watts come from the IES
 *  header `inputWatts`. For tape, the IES file IS one foot of strip,
 *  so no division by a fixture count is needed. We multiply by the
 *  run length in feet to get totals, then apply LLF to the lumen
 *  side (electrical wattage is unaffected by LLF — it's a maintenance
 *  derate on the optical output, not the connected load).
 *
 *  Driver count uses the same `ceil(totalWatts / maxLoad)` math the
 *  tape spec describes (§3.1 of the layout-method plan). The
 *  `driverOverloaded` flag is set when a single buildable run would
 *  exceed one driver's load — the UI uses it to suggest splitting
 *  into driver-sized segments. */
export function solveLinearLayout(
  ies: IESParseResult,
  inputs: LinearEstimatorInputs,
  product?: CatalogEntry | null,
): LinearEstimatorResult {
  const cutM = inputs.cutIncrementM ?? defaultCutIncrementM(product);
  const buildableLengthM = snapUpToCut(inputs.runLengthM, cutM);
  const buildableFt = buildableLengthM / M_PER_FT;

  // Per-foot photometric + electrical readings. The IES file is one
  // foot of strip — `lumens` and `watts` here ARE the per-foot
  // values directly.
  const lumensPerFt = Math.max(0, totalLuminaireLumens(ies));
  const wattsPerFt = Math.max(0, ies.inputWatts);
  const wattsUnknown = wattsPerFt <= 0;

  const totalLumens = lumensPerFt * buildableFt * inputs.llf;
  const totalWatts = wattsPerFt * buildableFt;

  const driverMaxW = inputs.driverMaxW ?? DEFAULT_DRIVER_MAX_W;
  const driverCount = totalWatts > 0
    ? Math.max(1, Math.ceil(totalWatts / Math.max(1, driverMaxW)))
    : (wattsUnknown ? 0 : 1);
  const driverOverloaded = totalWatts > driverMaxW;

  let cutCount: number | undefined;
  if (cutM > 0) {
    // floor(buildable / cut) gives the number of cut points between
    // the two ends; subtract 1 because we don't count the end faces.
    // Clamp at 0 — a 4" run on a 4" cut increment has no interior
    // cut points.
    cutCount = Math.max(0, Math.floor(buildableLengthM / cutM) - 1);
  }

  const result: LinearEstimatorResult = {
    requestedLengthM: inputs.runLengthM,
    buildableLengthM,
    lumensPerFt,
    wattsPerFt,
    totalLumens,
    totalWatts,
    driverMaxW,
    driverCount,
    driverOverloaded,
    cutCount,
    cutIncrementM: cutM > 0 ? cutM : undefined,
    wattsUnknown: wattsUnknown || undefined,
  };

  // Phase 2: line-source PBP for the three non-free-form presets.
  if (inputs.application !== "free-form") {
    const surface = solveLineSourceIlluminance(ies, inputs);
    if (surface) result.surface = surface;
    if (inputs.application === "cove-uplight") {
      const indirect = computeLinearCoveIndirectFc(ies, inputs);
      if (indirect !== undefined) result.indirectWPFc = indirect;
    }
  }

  return result;
}

/* ── line-source PBP kernel (tape Phase 2) ───────────────── */

/** Phase 2 surface-illuminance computation for the cove / under-
 *  cabinet / perimeter-accent presets. Implements the line-source
 *  Riemann sum from §3.2 of the layout-method plan: sample the run
 *  at ~1" pitch as virtual point sources, reuse
 *  `multiFixtureIlluminance` against the preset's target strip.
 *
 *  Returns `null` when the preset's required geometry inputs are
 *  missing (the UI is then expected to surface a "fill in the
 *  geometry" prompt rather than crash). */
function solveLineSourceIlluminance(
  ies: IESParseResult,
  inputs: LinearEstimatorInputs,
): LinearEstimatorResult["surface"] | null {
  const SEG_PITCH_M = 0.0254; // ~1"
  const runM = Math.max(0, inputs.runLengthM);
  if (runM <= 0) return null;

  const nSeg = Math.max(1, Math.ceil(runM / SEG_PITCH_M));
  const segLenM = runM / nSeg;
  // Per-segment lumens — `lumens_per_ft × (segLen_ft / 12)` worth of
  // flux. We pass this through the IES candela table directly via
  // `candelaInWorldDirection`; the headline kernel below scales the
  // resulting candela values by the per-segment fraction.
  const segFracOfFt = segLenM / M_PER_FT;

  // Build virtual fixtures along the run, anchored to a frame the
  // preset chooses.
  //
  // Convention: the kernel works in a **wall-local frame** where
  // x = along the wall the run sits on (0 = wall's first corner),
  // y = perpendicular distance from the wall into the room (plan
  // views) or 0 (elevation views with target on the wall itself),
  // z = up from the floor. The plot rotates this frame onto the
  // room rectangle based on `inputs.runWall`. This keeps the
  // physics simple (always "south-wall convention") while letting
  // the user place the run on any wall.
  type Preset = {
    sourceFor: (s: number) => PlacedFixture;
    targetGrid: { xs: number[]; ys: number[]; worldPoint: (i: number, j: number) => V3 };
    /** Returns the +outward normal of the target strip at the
     *  sample point. Always points back toward the source so the
     *  inner-product cosine reads positive on the lit face. */
    targetNormal: V3;
    /** Plan view (xs along-wall, ys into-room) vs elevation view
     *  (xs along-wall, ys up-wall). */
    view: "plan" | "elevation";
    /** Rect on the target surface the stats are computed over
     *  (a subset of the full grid). */
    targetRect: { x: number; y: number; w: number; h: number };
  };

  let preset: Preset | null = null;
  if (inputs.application === "cove-uplight") {
    preset = makeCovePreset(inputs, runM);
  } else if (inputs.application === "under-cabinet") {
    preset = makeUnderCabinetPreset(inputs, runM);
  } else if (inputs.application === "perimeter-accent") {
    preset = makePerimeterAccentPreset(inputs, runM);
  }
  if (!preset) return null;

  const { xs, ys, worldPoint } = preset.targetGrid;
  const normal = preset.targetNormal;

  // Accumulate the field across the full grid, then derive headline
  // stats from only the target-rect cells.
  const values: number[][] = [];
  let max = 0;
  let min = Infinity;
  let inRectSum = 0;
  let inRectCount = 0;
  let inRectMin = Infinity;
  let inRectMax = 0;
  const { x: rx, y: ry, w: rw, h: rh } = preset.targetRect;

  for (let j = 0; j < ys.length; j++) {
    const row: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      const P = worldPoint(i, j);
      let E_lux = 0;
      for (let s = 0; s < nSeg; s++) {
        const source = preset.sourceFor((s + 0.5) / nSeg);
        const F: V3 = [source.x, source.y, source.z];
        const ray = vSub(P, F);
        const d = vLen(ray);
        if (d < 0.05) continue;
        const dir = vScale(ray, 1 / d);
        const cosInc = -vDot(dir, normal);
        if (cosInc <= 0) continue;
        const Iraw = candelaInWorldDirection(ies, source, dir);
        // The IES candela values describe one foot of strip. A
        // segment of length `segFracOfFt` feet contributes that
        // fraction of the full per-foot intensity in the same
        // direction (linear scaling — the strip is linearly uniform
        // in flux per length). The Riemann sum converges to the
        // true line integral.
        const I = Iraw * segFracOfFt;
        E_lux += (I * cosInc) / (d * d);
      }
      const E_fc = E_lux * FC_PER_LUX * inputs.llf;
      row.push(E_fc);
      if (E_fc > max) max = E_fc;
      if (E_fc < min) min = E_fc;
      const xi = xs[i];
      const yj = ys[j];
      if (xi >= rx && xi <= rx + rw && yj >= ry && yj <= ry + rh) {
        inRectSum += E_fc;
        inRectCount += 1;
        if (E_fc > inRectMax) inRectMax = E_fc;
        if (E_fc < inRectMin) inRectMin = E_fc;
      }
    }
    values.push(row);
  }
  const avgFc = inRectCount > 0 ? inRectSum / inRectCount : 0;

  return {
    xs,
    ys,
    values,
    avgFc,
    minFc: inRectMin < Infinity ? inRectMin : (min < Infinity ? min : 0),
    maxFc: inRectMax > 0 ? inRectMax : max,
    view: preset.view,
    targetRect: preset.targetRect,
    fixtureLine: {
      x0: inputs.runStartM,
      y0: 0,
      x1: inputs.runStartM + runM,
      y1: 0,
    },
  };
}

/** Helper: the length of the wall the run sits on (along-wall axis)
 *  and the perpendicular extent into the room. Wall-local convention
 *  — south/north walls run along +x with the room extending in +y,
 *  east/west walls run along +y with the room extending in +x. */
function wallSpan(inputs: LinearEstimatorInputs | AreaEstimatorInputs, wall: RoomWall): {
  alongLen: number;
  perpLen: number;
} {
  if (wall === "south" || wall === "north") {
    return { alongLen: inputs.roomWidthM, perpLen: inputs.roomLengthM };
  }
  return { alongLen: inputs.roomLengthM, perpLen: inputs.roomWidthM };
}

/** Cove uplight: tape sits in a cove with its emitting face pointing
 *  up at the ceiling. The wash strip on the ceiling above the cove
 *  is the spec target — but the full ceiling above the room is
 *  sampled so the plot can show the wash falloff in room context. */
function makeCovePreset(
  inputs: LinearEstimatorInputs,
  runM: number,
): {
  sourceFor: (s: number) => PlacedFixture;
  targetGrid: { xs: number[]; ys: number[]; worldPoint: (i: number, j: number) => V3 };
  targetNormal: V3;
  view: "plan" | "elevation";
  targetRect: { x: number; y: number; w: number; h: number };
} | null {
  const coveDistM = inputs.coveToCeilingM ?? 0.15;
  if (coveDistM <= 0) return null;
  const ceilingZ = inputs.ceilingHeightM;
  const ledgeZ = ceilingZ - coveDistM;
  if (ledgeZ <= 0) return null;
  // Wall-local frame: x along the wall (0 = wall's first corner,
  // increasing to the wall's full length), y perpendicular into
  // the room (0 = wall plane, increasing to the opposite wall),
  // z = up from floor.
  const { alongLen, perpLen } = wallSpan(inputs, inputs.runWall);
  const sourceFor = (s: number): PlacedFixture => ({
    x: inputs.runStartM + s * runM,
    y: 0,           // tape sits on (or just in front of) the wall
    z: ledgeZ,
    mounting: "floor",
    aim: "up",
  });
  // Sample the ceiling above the entire room footprint.
  const xn = 41;
  const yn = 41;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < xn; i++) xs.push((alongLen * i) / (xn - 1));
  for (let j = 0; j < yn; j++) ys.push((perpLen * j) / (yn - 1));
  // The "wash strip" — stats are computed over this — is along the
  // run, extending ~3× the cove-to-ceiling distance into the room.
  const stripDepth = Math.max(0.3, 3 * coveDistM);
  return {
    sourceFor,
    targetGrid: {
      xs,
      ys,
      worldPoint: (i, j) => [xs[i], ys[j], ceilingZ],
    },
    targetNormal: [0, 0, -1], // ceiling faces down into the room
    view: "plan",
    targetRect: {
      x: inputs.runStartM,
      y: 0,
      w: runM,
      h: stripDepth,
    },
  };
}

/** Under-cabinet: tape on the underside of a wall cabinet, emitting
 *  downward onto the counter directly below. The plot shows the
 *  counter strip in front of the wall (room-context); stats are
 *  computed over the cabinet's footprint on the counter. */
function makeUnderCabinetPreset(
  inputs: LinearEstimatorInputs,
  runM: number,
): {
  sourceFor: (s: number) => PlacedFixture;
  targetGrid: { xs: number[]; ys: number[]; worldPoint: (i: number, j: number) => V3 };
  targetNormal: V3;
  view: "plan" | "elevation";
  targetRect: { x: number; y: number; w: number; h: number };
} | null {
  const cabinetH = inputs.cabinetHeightM ?? 0.46; // 18" typical
  const counterDepth = inputs.counterDepthM ?? 0.6; // ~24"
  if (cabinetH <= 0 || counterDepth <= 0) return null;
  // Counter sits at standard kitchen height (~36" ≈ 0.91 m).
  // For the wall-local plot, z is unused (we look top-down); the
  // tape is at counterZ + cabinetH and emits downward onto the
  // counter at z = counterZ.
  const counterZ = 0.91;
  const tapeZ = counterZ + cabinetH;
  const { alongLen, perpLen } = wallSpan(inputs, inputs.runWall);
  const sourceFor = (s: number): PlacedFixture => ({
    x: inputs.runStartM + s * runM,
    y: counterDepth * 0.5, // tape recessed under cabinet, ~mid-counter
    z: tapeZ,
    mounting: "ceiling",
    aim: "down",
  });
  // Sample plan view: along-wall × into-room. Drawn against the
  // full room footprint so the user sees the counter strip in
  // context against the rest of the room.
  const xn = 41;
  const yn = 41;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < xn; i++) xs.push((alongLen * i) / (xn - 1));
  for (let j = 0; j < yn; j++) ys.push((perpLen * j) / (yn - 1));
  return {
    sourceFor,
    targetGrid: {
      xs,
      ys,
      worldPoint: (i, j) => [xs[i], ys[j], counterZ],
    },
    targetNormal: [0, 0, 1],
    view: "plan",
    targetRect: {
      x: inputs.runStartM,
      y: 0,
      w: runM,
      h: counterDepth,
    },
  };
}

/** Perimeter accent: horizontal tape on a wall, washing the wall
 *  above and below. Elevation view of the wall — xs along the wall,
 *  ys up from the floor; target is the wall face itself. */
function makePerimeterAccentPreset(
  inputs: LinearEstimatorInputs,
  runM: number,
): {
  sourceFor: (s: number) => PlacedFixture;
  targetGrid: { xs: number[]; ys: number[]; worldPoint: (i: number, j: number) => V3 };
  targetNormal: V3;
  view: "plan" | "elevation";
  targetRect: { x: number; y: number; w: number; h: number };
} | null {
  const mountZ = inputs.wallMountHeightM ?? 1.2;
  const extent = inputs.wallExtentM ?? 0.6;
  if (extent <= 0) return null;
  const ceilingZ = inputs.ceilingHeightM;
  const { alongLen } = wallSpan(inputs, inputs.runWall);
  // Wall-local frame: x along the wall, y = perpendicular into room,
  // z = up. Sources sit on the wall (y = 0) at z = mountZ, emitting
  // along +y. For the perimeter-accent elevation plot, ys is
  // up-the-wall (z) rather than into-the-room.
  const sourceFor = (s: number): PlacedFixture => ({
    x: inputs.runStartM + s * runM,
    y: 0,
    z: mountZ,
    mounting: "wall",
    aim: "forward",
  });
  // Elevation view — sample the FULL wall surface so the plot can
  // draw the room frame (wall extent × floor-to-ceiling). xs span
  // the wall length, ys span 0..ceilingHeight.
  const xn = 41;
  const yn = 41;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < xn; i++) xs.push((alongLen * i) / (xn - 1));
  for (let j = 0; j < yn; j++) ys.push((ceilingZ * j) / (yn - 1));
  return {
    sourceFor,
    targetGrid: {
      xs,
      ys,
      // Receiver sits a few cm in front of the wall (y ≈ 0.02 m)
      // so the ray direction is well-defined for points near the
      // tape itself; the elevation plot reads the values at z = ys[j]
      // along the wall.
      worldPoint: (i, j) => [xs[i], 0.02, ys[j]],
    },
    // Receiver faces back at the wall (the source) so the
    // `cosInc = -dot(dir, normal)` convention reads positive on
    // light travelling outward from the wall.
    targetNormal: [0, -1, 0],
    view: "elevation",
    // Stats: the wash strip on the wall — along the run length,
    // extending `extent` above and below the tape's mount height.
    targetRect: {
      x: inputs.runStartM,
      y: Math.max(0, mountZ - extent),
      w: runM,
      h: Math.min(ceilingZ, mountZ + extent) - Math.max(0, mountZ - extent),
    },
  };
}

/** First-order indirect working-plane contribution from a cove
 *  uplight, analogous to `computeIndirectWPFc` for the area-grid
 *  case. Treats the run as a single equivalent fixture whose
 *  upward flux equals `lm/ft × runFt × LLF`. */
function computeLinearCoveIndirectFc(
  ies: IESParseResult,
  inputs: LinearEstimatorInputs,
): number | undefined {
  const runFt = inputs.runLengthM / M_PER_FT;
  const lmPerFt = Math.max(0, totalLuminaireLumens(ies));
  if (runFt <= 0 || lmPerFt <= 0) return undefined;
  // Without a room size in the linear inputs we can't translate the
  // bounce-back to fc on a working plane. Leave undefined; the UI
  // can prompt for a room dimension in a future iteration. Surface
  // the upward flux number directly so at least the magnitude is
  // visible.
  void ies;
  return undefined;
}

/* ════════════════════════════════════════════════════════════════════
   area-continuous solver (pixels) — Phase 1
   ────────────────────────────────────────────────────────────────────

   Same architectural pattern as the linear solver. The IES file IS
   one module/tile/cell, so per-module lumens and watts come straight
   from the file. Sizing is by region area, not fixture count.
   ════════════════════════════════════════════════════════════════════ */

/** Default driver max load for pixel products. Pixel power supplies
 *  in WAC's ecosystem (e.g. for Pixels 12×24) commonly come in 60 W
 *  and 96 W sizes; we pick 96 W as the middle-of-the-pack default
 *  for the same reason tape does. */
const DEFAULT_PIXEL_DRIVER_MAX_W = 96;

/** Default module increments for pixel families, canonical metres
 *  on each axis. WAC's Pixels 12×24 product has a 12" × 24"
 *  modular increment — the name encodes the dimensions. */
const DEFAULT_PIXEL_MODULE_INC_BY_FAMILY: Record<string, [number, number]> = {
  // Pixels 12×24 Configurable LED Light Sheet — 12" along × 24"
  // across (matches the SKU naming).
  PIXELS: [12 * 0.0254, 24 * 0.0254],
};

/** Resolve module increments for a given product. Prefers explicit
 *  inputs, then the per-family lookup, then a 12" × 12" fallback
 *  that's at least a recognisable default the user can override. */
export function defaultPixelModuleIncrement(
  product?: CatalogEntry | null,
): [number, number] {
  if (!product) return [12 * 0.0254, 12 * 0.0254];
  const direct =
    DEFAULT_PIXEL_MODULE_INC_BY_FAMILY[product.family]
    ?? DEFAULT_PIXEL_MODULE_INC_BY_FAMILY[(product.line || "").toUpperCase()];
  if (direct) return direct;
  return [12 * 0.0254, 12 * 0.0254];
}

/** Defaults for a fresh area-configurator session. 4 ft × 8 ft
 *  (~1.2 m × ~2.4 m) is a friendly starting region — large enough
 *  that the modular snap is interesting, small enough to fit in a
 *  single driver. */
export function defaultAreaInputs(): AreaEstimatorInputs {
  const roomLengthM = 14 * M_PER_FT;
  const roomWidthM = 14 * M_PER_FT;
  const ceilingHeightM = 9 * M_PER_FT;
  const regionLengthM = 8 * M_PER_FT;
  const regionWidthM = 4 * M_PER_FT;
  return {
    regionLengthM,
    regionWidthM,
    surface: "ceiling",
    llf: 0.85,
    unit: "fc",
    system: "imperial",
    // Default to ceiling-array: this is the preset where pixels
    // behave like a traditional troffer and produce a usable
    // working-plane average — the case where the math is most
    // valuable. Seed ceiling-to-working-plane at 6.5 ft (~2 m)
    // and average reflectances so the surface-illuminance overlay
    // is meaningful out of the box.
    application: "ceiling-array",
    targetDistanceM: 6.5 * M_PER_FT,
    reflectances: { ceiling: 0.8, wall: 0.5, floor: 0.2 },
    // Room context: same 14 × 14 × 9 ft room as the linear
    // defaults so the two screens read at a comparable scale.
    // For ceiling-array the panel is auto-centered on the
    // ceiling (room-center minus half the region on each axis).
    // For feature-wall the south wall is the default anchor.
    roomLengthM,
    roomWidthM,
    ceilingHeightM,
    arrayWall: "south",
    arrayStartXM: Math.max(0, (roomWidthM - regionLengthM) / 2),
    arrayStartYM: Math.max(0, (roomLengthM - regionWidthM) / 2),
  };
}

/** Snap a length UP to the next module mark on a single axis. */
function snapUpToModule(lengthM: number, incM: number): number {
  if (incM <= 0) return lengthM;
  const steps = Math.max(1, Math.ceil(lengthM / incM));
  return steps * incM;
}

/** Solve the pixel layout for a single region.
 *
 *  Per-module lumens come from `totalLuminaireLumens(ies)`; per-
 *  module watts from `ies.inputWatts`. The IES file IS one module,
 *  so no division by a fixture count is needed. We compute the
 *  buildable region by snapping each axis up to the next module
 *  increment, multiply through to get total modules, then derive
 *  lumens / watts / driver count from the per-module values. */
export function solveAreaLayout(
  ies: IESParseResult,
  inputs: AreaEstimatorInputs,
  product?: CatalogEntry | null,
): AreaEstimatorResult {
  const [defIncX, defIncY] = defaultPixelModuleIncrement(product);
  const incX = inputs.moduleIncrementMx ?? defIncX;
  const incY = inputs.moduleIncrementMy ?? defIncY;

  const buildableLengthM = snapUpToModule(inputs.regionLengthM, incX);
  const buildableWidthM = snapUpToModule(inputs.regionWidthM, incY);
  const modulesAlong = Math.max(1, Math.round(buildableLengthM / incX));
  const modulesAcross = Math.max(1, Math.round(buildableWidthM / incY));
  const moduleCount = modulesAlong * modulesAcross;

  const lumensPerModule = Math.max(0, totalLuminaireLumens(ies));
  const wattsPerModule = Math.max(0, ies.inputWatts);
  const wattsUnknown = wattsPerModule <= 0;

  const totalLumens = lumensPerModule * moduleCount * inputs.llf;
  const totalWatts = wattsPerModule * moduleCount;

  const driverMaxW = inputs.driverMaxW ?? DEFAULT_PIXEL_DRIVER_MAX_W;
  const driverCount = totalWatts > 0
    ? Math.max(1, Math.ceil(totalWatts / Math.max(1, driverMaxW)))
    : (wattsUnknown ? 0 : 1);
  const driverOverloaded = totalWatts > driverMaxW;

  const result: AreaEstimatorResult = {
    requestedLengthM: inputs.regionLengthM,
    requestedWidthM: inputs.regionWidthM,
    buildableLengthM,
    buildableWidthM,
    modulesAlong,
    modulesAcross,
    moduleCount,
    lumensPerModule,
    wattsPerModule,
    totalLumens,
    totalWatts,
    driverMaxW,
    driverCount,
    driverOverloaded,
    moduleIncrementMx: incX,
    moduleIncrementMy: incY,
    wattsUnknown: wattsUnknown || undefined,
  };

  // Phase 2: surface illuminance for the three non-free-form presets.
  if (inputs.application !== "free-form") {
    const surface = solveAreaSourceIlluminance(ies, inputs, result);
    if (surface) result.surface = surface;
  }

  return result;
}

/* ── 2D Riemann-sum kernel (pixel Phase 2) ───────────────── */

/** Phase 2 surface-illuminance computation for the feature-wall /
 *  ceiling-array / signage presets. 2D analog of the line-source
 *  kernel: sample the region at module centres as virtual point
 *  sources, reuse `multiFixtureIlluminance`. Ceiling-array also
 *  overlays the CU-method room-average as a primary headline
 *  (`surface.roomAvgFc`) since that preset is the case where pixels
 *  actually behave like a troffer. */
function solveAreaSourceIlluminance(
  ies: IESParseResult,
  inputs: AreaEstimatorInputs,
  result: AreaEstimatorResult,
): AreaEstimatorResult["surface"] | null {
  const regionL = result.buildableLengthM;
  const regionW = result.buildableWidthM;
  if (regionL <= 0 || regionW <= 0) return null;

  const xs: number[] = [];
  const ys: number[] = [];

  // Convention: same wall-local frame as the line-source kernel.
  // For ceiling-array the "wall" doesn't apply — the panel sits on
  // the ceiling at (arrayStartXM, arrayStartYM) and the plot spans
  // the full room footprint. For feature-wall and signage the
  // array sits on the chosen wall and the plot is an elevation
  // view of that wall (xs along-wall, ys up-wall).
  let normal: V3;
  let worldPoint: (i: number, j: number) => V3;
  let sources: PlacedFixture[];
  let view: "plan" | "elevation";
  let targetRect: { x: number; y: number; w: number; h: number };
  let fixtureRect: { x: number; y: number; w: number; h: number };

  const GRID_N = 41;

  if (inputs.application === "ceiling-array") {
    const dropM = inputs.targetDistanceM ?? 2.0;
    // Sources distributed across the panel footprint on the ceiling
    // at (arrayStartXM, arrayStartYM) within the room. World frame
    // z = 0 is the ceiling, z = -dropM is the working plane.
    sources = makeAreaSourcesPlan(inputs, result);
    for (let i = 0; i < GRID_N; i++) xs.push((inputs.roomWidthM * i) / (GRID_N - 1));
    for (let j = 0; j < GRID_N; j++) ys.push((inputs.roomLengthM * j) / (GRID_N - 1));
    normal = [0, 0, 1]; // working plane faces up at the ceiling
    worldPoint = (i, j) => [xs[i], ys[j], -dropM];
    view = "plan";
    targetRect = {
      x: inputs.arrayStartXM,
      y: inputs.arrayStartYM,
      w: regionL,
      h: regionW,
    };
    fixtureRect = targetRect;
  } else if (inputs.application === "feature-wall") {
    // Elevation view of the chosen wall. xs span 0..wallLength,
    // ys span 0..ceilingHeight. The panel sits on the wall at
    // (arrayStartXM, arrayStartYM) where arrayStartYM is the
    // panel's bottom edge height above the floor.
    const offM = inputs.targetDistanceM ?? 0.05;
    sources = makeAreaSourcesWall(inputs, result);
    const { alongLen } = wallSpan(inputs, inputs.arrayWall);
    for (let i = 0; i < GRID_N; i++) xs.push((alongLen * i) / (GRID_N - 1));
    for (let j = 0; j < GRID_N; j++) ys.push((inputs.ceilingHeightM * j) / (GRID_N - 1));
    normal = [0, -1, 0]; // receiver faces back at the wall
    worldPoint = (i, j) => [xs[i], offM, ys[j]];
    view = "elevation";
    targetRect = {
      x: inputs.arrayStartXM,
      y: inputs.arrayStartYM,
      w: regionL,
      h: regionW,
    };
    fixtureRect = targetRect;
  } else {
    // signage: same elevation view as feature-wall but with a
    // larger viewer/target setback.
    const offM = inputs.targetDistanceM ?? 0.3;
    sources = makeAreaSourcesWall(inputs, result);
    const { alongLen } = wallSpan(inputs, inputs.arrayWall);
    for (let i = 0; i < GRID_N; i++) xs.push((alongLen * i) / (GRID_N - 1));
    for (let j = 0; j < GRID_N; j++) ys.push((inputs.ceilingHeightM * j) / (GRID_N - 1));
    normal = [0, -1, 0];
    worldPoint = (i, j) => [xs[i], offM, ys[j]];
    view = "elevation";
    targetRect = {
      x: inputs.arrayStartXM,
      y: inputs.arrayStartYM,
      w: regionL,
      h: regionW,
    };
    fixtureRect = targetRect;
  }

  const values: number[][] = [];
  let max = 0;
  let min = Infinity;
  let inRectSum = 0;
  let inRectCount = 0;
  let inRectMin = Infinity;
  let inRectMax = 0;
  const { x: rx, y: ry, w: rw, h: rh } = targetRect;

  for (let j = 0; j < ys.length; j++) {
    const row: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      const P = worldPoint(i, j);
      let E_lux = 0;
      for (const fx of sources) {
        const F: V3 = [fx.x, fx.y, fx.z];
        const ray = vSub(P, F);
        const d = vLen(ray);
        if (d < 0.05) continue;
        const dir = vScale(ray, 1 / d);
        const cosInc = -vDot(dir, normal);
        if (cosInc <= 0) continue;
        const I = candelaInWorldDirection(ies, fx, dir);
        E_lux += (I * cosInc) / (d * d);
      }
      const E_fc = E_lux * FC_PER_LUX * inputs.llf;
      row.push(E_fc);
      if (E_fc > max) max = E_fc;
      if (E_fc < min) min = E_fc;
      const xi = xs[i];
      const yj = ys[j];
      if (xi >= rx && xi <= rx + rw && yj >= ry && yj <= ry + rh) {
        inRectSum += E_fc;
        inRectCount += 1;
        if (E_fc > inRectMax) inRectMax = E_fc;
        if (E_fc < inRectMin) inRectMin = E_fc;
      }
    }
    values.push(row);
  }
  const avg = inRectCount > 0 ? inRectSum / inRectCount : 0;

  const out: NonNullable<AreaEstimatorResult["surface"]> = {
    xs,
    ys,
    values,
    avgFc: avg,
    minFc: inRectMin < Infinity ? inRectMin : (min < Infinity ? min : 0),
    maxFc: inRectMax > 0 ? inRectMax : max,
    view,
    targetRect,
    fixtureRect,
  };

  // Ceiling-array preset: also compute a CU-method room average.
  // This is the preset where pixels-as-panel produce a usable
  // working-plane number, and the room avg should be the primary
  // headline (per §3.5.2 of the plan). We treat the array as if it
  // were N equivalent "fixtures" each contributing `lumensPerModule`
  // flux, with CU interpolated from the IES file's CU table at the
  // user's reflectances and a room cavity ratio derived from the
  // ROOM footprint × the working-plane drop. (Previously approximated
  // the room as the panel footprint, which over-estimated CU because
  // the cavity is much smaller than the actual room.)
  if (
    inputs.application === "ceiling-array"
    && inputs.reflectances
    && inputs.targetDistanceM
    && inputs.targetDistanceM > 0
  ) {
    const cuTable = coefficientOfUtilization(ies);
    const rcr = roomCavityRatio(
      inputs.roomLengthM,
      inputs.roomWidthM,
      inputs.targetDistanceM,
      0,
    );
    const cu = interpolateCU(cuTable, inputs.reflectances, rcr);
    const roomAreaFt2 = (inputs.roomLengthM / M_PER_FT)
      * (inputs.roomWidthM / M_PER_FT);
    if (cu > 0 && roomAreaFt2 > 0) {
      const roomAvg =
        (result.moduleCount * result.lumensPerModule * cu * inputs.llf)
        / roomAreaFt2;
      out.roomAvgFc = roomAvg;
      out.rcr = rcr;
      out.cu = cu;
    }
  }

  return out;
}

/** Build virtual point sources at module centres for a ceiling-array
 *  preset. Anchored at the array's room position on the ceiling
 *  (`arrayStartXM`, `arrayStartYM`), ceiling plane at z = 0. */
function makeAreaSourcesPlan(
  inputs: AreaEstimatorInputs,
  result: AreaEstimatorResult,
): PlacedFixture[] {
  const incX = result.moduleIncrementMx;
  const incY = result.moduleIncrementMy;
  const sources: PlacedFixture[] = [];
  for (let r = 0; r < result.modulesAcross; r++) {
    for (let c = 0; c < result.modulesAlong; c++) {
      const xCenter = inputs.arrayStartXM + incX * (c + 0.5);
      const yCenter = inputs.arrayStartYM + incY * (r + 0.5);
      sources.push({
        x: xCenter,
        y: yCenter,
        z: 0,
        mounting: "ceiling",
        aim: "down",
      });
    }
  }
  return sources;
}

/** Build virtual point sources at module centres for a feature-wall
 *  / signage preset. Anchored on the chosen wall at (arrayStartXM,
 *  arrayStartYM) where x is along-wall and y is height-from-floor.
 *  Wall lives at world y = 0 with the room in +y. */
function makeAreaSourcesWall(
  inputs: AreaEstimatorInputs,
  result: AreaEstimatorResult,
): PlacedFixture[] {
  const incX = result.moduleIncrementMx;
  const incY = result.moduleIncrementMy;
  const sources: PlacedFixture[] = [];
  for (let r = 0; r < result.modulesAcross; r++) {
    for (let c = 0; c < result.modulesAlong; c++) {
      const xCenter = inputs.arrayStartXM + incX * (c + 0.5);
      const zCenter = inputs.arrayStartYM + incY * (r + 0.5);
      sources.push({
        x: xCenter,
        y: 0,
        z: zCenter,
        mounting: "wall",
        aim: "forward",
      });
    }
  }
  return sources;
}

