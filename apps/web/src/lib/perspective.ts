import type { AppImagePerspective } from "@wac/shared";

/**
 * Client-side perspective helpers for the placement canvas. Mirrors the
 * generator's deterministic warp: a perspective is four corner offsets (as
 * fractions of the cutout's width/height). Here we additionally build a CSS
 * `matrix3d` so the overlay preview shows the exact same projective warp the
 * server will apply, and expose simple keystone presets + an auto-suggestion.
 */

export const IDENTITY_PERSPECTIVE: AppImagePerspective = {
  topLeft: { dx: 0, dy: 0 },
  topRight: { dx: 0, dy: 0 },
  bottomRight: { dx: 0, dy: 0 },
  bottomLeft: { dx: 0, dy: 0 },
};

export function isIdentityPerspective(p?: AppImagePerspective): boolean {
  if (!p) return true;
  return [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].every(
    (c) => c.dx === 0 && c.dy === 0,
  );
}

type Point = { x: number; y: number };

/** Gaussian elimination for a small dense system A·x = b. */
function gaussianSolve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const pv = m[col]![col]!;
    if (Math.abs(pv) < 1e-12) return [];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / pv;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** Homography (row-major 3x3, h22=1) mapping the 4 `from` points to `to`. */
function solveHomography(from: Point[], to: Point[]): number[] {
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
  return h.length === 8 ? [...h, 1] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

/**
 * Build a CSS `matrix3d(...)` string that warps an element of size `pxW`×`pxH`
 * (transform-origin top-left) so its corners land at the perspective's
 * destinations. Matches the server's projective warp exactly.
 */
export function perspectiveToMatrix3d(
  p: AppImagePerspective,
  pxW: number,
  pxH: number,
): string {
  const src: Point[] = [
    { x: 0, y: 0 },
    { x: pxW, y: 0 },
    { x: pxW, y: pxH },
    { x: 0, y: pxH },
  ];
  const offs = [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft];
  const dst: Point[] = src.map((s, i) => ({
    x: s.x + offs[i]!.dx * pxW,
    y: s.y + offs[i]!.dy * pxH,
  }));
  const h = solveHomography(src, dst);
  // CSS matrix3d is column-major 4x4; embed the 2D homography.
  return `matrix3d(${h[0]},${h[3]},0,${h[6]},${h[1]},${h[4]},0,${h[7]},0,0,1,0,${h[2]},${h[5]},0,${h[8]})`;
}

/**
 * Map two intuitive keystone sliders to corner offsets:
 * - `vertical` > 0 narrows the TOP edge (looking up at a ceiling fixture);
 *   < 0 narrows the bottom.
 * - `horizontal` > 0 narrows the RIGHT edge (fixture turned away to the right);
 *   < 0 narrows the left.
 * Values are fractions (e.g. 0.1 = 10%).
 */
export function keystoneToPerspective(
  vertical: number,
  horizontal: number,
): AppImagePerspective {
  const v = vertical / 2;
  const h = horizontal / 2;
  return {
    topLeft: { dx: +v, dy: +h },
    topRight: { dx: -v, dy: +h },
    bottomRight: { dx: -v, dy: -h },
    bottomLeft: { dx: +v, dy: -h },
  };
}

/** Recover the (vertical, horizontal) keystone sliders from a perspective. */
export function perspectiveToKeystone(p?: AppImagePerspective): {
  vertical: number;
  horizontal: number;
} {
  if (!p) return { vertical: 0, horizontal: 0 };
  return { vertical: p.topLeft.dx * 2, horizontal: p.topLeft.dy * 2 };
}

/**
 * Best-effort auto-suggestion: a fixture mounted high in the frame (low `yPct`)
 * is typically viewed from below, so the top recedes — apply a mild vertical
 * keystone proportional to how high it sits. Returns the identity for fixtures
 * near eye level. The user can always override.
 */
export function autoSuggestPerspective(yPct: number): AppImagePerspective {
  // yPct 0 (top) -> ~12% keystone; 0.5+ (mid/low) -> none.
  const amount = Math.max(0, (0.5 - yPct)) * 0.24;
  if (amount < 0.01) return IDENTITY_PERSPECTIVE;
  return keystoneToPerspective(amount, 0);
}
