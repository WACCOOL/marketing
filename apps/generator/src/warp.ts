import sharp from "sharp";
import type { AppImagePerspective } from "@wac/shared";

/**
 * Deterministic perspective (keystone) warp of the REAL cutout pixels.
 *
 * This is the non-generative half of "correct the fixture's angle" — the same
 * idea as Photoshop's Free Transform / Perspective Warp. We map the cutout's
 * rectangle to four user/auto-chosen destination corners via a projective
 * transform and resample the actual photo. Because it only moves existing
 * pixels, it can fix viewing angle WITHOUT inventing geometry (no extra arms or
 * crystals). Areas the warp leaves empty stay transparent.
 */

/** A 3x3 homography flattened row-major. */
type Mat3 = [number, number, number, number, number, number, number, number, number];

type Point = { x: number; y: number };

/** True when a perspective is missing or every corner offset is zero (identity). */
export function isIdentityPerspective(p?: AppImagePerspective): boolean {
  if (!p) return true;
  const corners = [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft];
  return corners.every((c) => c.dx === 0 && c.dy === 0);
}

/**
 * Solve the 3x3 homography mapping the four `from` points to the four `to`
 * points (DLT with h22 fixed to 1, i.e. an 8x8 linear solve). Returns a
 * row-major Mat3 such that `to ~= H * from` in homogeneous coordinates.
 */
function solveHomography(from: Point[], to: Point[]): Mat3 {
  // Build the 8x8 system A·h = b for h = [h00..h21].
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]!;
    const { x: u, y: v } = to[i]!;
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }
  const h = gaussianSolve(a, b);
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

/** Gaussian elimination with partial pivoting for a small dense system. */
function gaussianSolve(a: number[][], b: number[]): number[] {
  const n = b.length;
  // Augment.
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    // Pivot.
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const pivotVal = m[col]![col]!;
    if (Math.abs(pivotVal) < 1e-12) {
      throw new Error("perspective warp: degenerate (collinear) corners");
    }
    // Eliminate.
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r]![col]! / pivotVal;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) m[r]![c]! -= factor * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** Apply a homography to a point in homogeneous coordinates. */
function applyH(h: Mat3, x: number, y: number): Point {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

/**
 * Apply a perspective warp to an RGBA cutout. The cutout's corners
 * (TL, TR, BR, BL) move by the perspective's fractional offsets (in units of
 * the cutout's own width/height). The output is tightly cropped to the warped
 * quad and returned as an RGBA PNG; pixels outside the warped shape are
 * transparent.
 */
export async function warpCutout(
  cutout: Buffer,
  perspective: AppImagePerspective,
): Promise<Buffer> {
  const { data, info } = await sharp(cutout)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const channels = info.channels; // 4 after ensureAlpha

  // Source rectangle corners and their warped destinations (in px).
  const src: Point[] = [
    { x: 0, y: 0 },
    { x: W, y: 0 },
    { x: W, y: H },
    { x: 0, y: H },
  ];
  const offsets = [
    perspective.topLeft,
    perspective.topRight,
    perspective.bottomRight,
    perspective.bottomLeft,
  ];
  const dst: Point[] = src.map((p, i) => ({
    x: p.x + offsets[i]!.dx * W,
    y: p.y + offsets[i]!.dy * H,
  }));

  // Output bounding box of the warped quad, normalized to start at (0,0).
  const minX = Math.floor(Math.min(...dst.map((p) => p.x)));
  const minY = Math.floor(Math.min(...dst.map((p) => p.y)));
  const maxX = Math.ceil(Math.max(...dst.map((p) => p.x)));
  const maxY = Math.ceil(Math.max(...dst.map((p) => p.y)));
  const outW = Math.max(1, maxX - minX);
  const outH = Math.max(1, maxY - minY);
  const dstNorm = dst.map((p) => ({ x: p.x - minX, y: p.y - minY }));

  // Inverse map: output (dst) coords -> source coords, so we can sample.
  const hInv = solveHomography(dstNorm, src);

  const out = Buffer.alloc(outW * outH * 4, 0);
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const sp = applyH(hInv, ox + 0.5, oy + 0.5);
      const sx = sp.x - 0.5;
      const sy = sp.y - 0.5;
      if (sx < 0 || sy < 0 || sx > W - 1 || sy > H - 1) continue; // stays transparent
      sampleBilinear(data, W, H, channels, sx, sy, out, (oy * outW + ox) * 4);
    }
  }

  return sharp(out, { raw: { width: outW, height: outH, channels: 4 } })
    .png()
    .toBuffer();
}

/** Bilinear-sample an RGBA source into the 4-channel output at `outOff`. */
function sampleBilinear(
  data: Buffer,
  W: number,
  H: number,
  channels: number,
  sx: number,
  sy: number,
  out: Buffer,
  outOff: number,
): void {
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(x0 + 1, W - 1);
  const y1 = Math.min(y0 + 1, H - 1);
  const fx = sx - x0;
  const fy = sy - y0;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const i00 = (y0 * W + x0) * channels;
  const i10 = (y0 * W + x1) * channels;
  const i01 = (y1 * W + x0) * channels;
  const i11 = (y1 * W + x1) * channels;
  for (let c = 0; c < 4; c++) {
    out[outOff + c] = Math.round(
      data[i00 + c]! * w00 +
        data[i10 + c]! * w10 +
        data[i01 + c]! * w01 +
        data[i11 + c]! * w11,
    );
  }
}
