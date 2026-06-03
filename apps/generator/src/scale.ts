import type { AppImageWidthBasis, DimensionsMm } from "@wac/shared";

/**
 * Scale engine (Phase 2c).
 *
 * Turns a fixture's real-world dimensions (mm) + the scene scale (px per mm,
 * times the user's correction) into the exact pixel size the cutout should be
 * composited at, preserving the cutout's native aspect ratio. This is the
 * deterministic "pixel size from dimensions_mm + scene scale" core; it is the
 * reusable sizing logic that the hybrid (Option C) pipeline will also use.
 */

/**
 * Hard cap on a computed cutout edge. A bad pxPerMm (or scaleAdjust) must not be
 * allowed to size a fixture to tens of thousands of pixels and OOM sharp - we
 * fail loudly with an actionable error instead.
 */
export const MAX_CUTOUT_PX = 8000;

export interface ComputeCutoutPixelSizeArgs {
  dimensionsMm: DimensionsMm;
  pxPerMm: number;
  scaleAdjust: number;
  /** Source cutout aspect ratio = nativeWidth / nativeHeight. */
  cutoutAspect: number;
  widthBasis: AppImageWidthBasis;
}

export interface PixelSize {
  width: number;
  height: number;
}

type Axis = "width" | "height";

/**
 * Resolve which real-world dimension governs the cutout's on-screen size, and
 * whether it maps to the horizontal (width) or vertical (height) axis.
 *
 * `auto` priority is `width > diameter > length > height`. Rationale for WAC's
 * product mix: round fixtures (downlights, landscape) expose `diameter` and
 * linear fixtures expose `length` - both describe the fixture's horizontal
 * extent as seen head-on, so they map to the cutout's width. `height` is the
 * last-resort vertical measure for tall fixtures with no horizontal dimension.
 * Keep this order stable - downstream steps (2d/2e) rely on it.
 */
function resolveGoverning(
  dims: DimensionsMm,
  widthBasis: AppImageWidthBasis,
): { mm: number; axis: Axis } {
  if (widthBasis !== "auto") {
    const mm = dims[widthBasis];
    if (typeof mm === "number" && mm > 0) {
      return { mm, axis: widthBasis === "height" ? "height" : "width" };
    }
    throw new Error(
      `widthBasis "${widthBasis}" was requested but dimensions_mm.${widthBasis} is missing or non-positive`,
    );
  }

  if (dims.width && dims.width > 0) return { mm: dims.width, axis: "width" };
  if (dims.diameter && dims.diameter > 0) {
    return { mm: dims.diameter, axis: "width" };
  }
  if (dims.length && dims.length > 0) return { mm: dims.length, axis: "width" };
  if (dims.height && dims.height > 0) return { mm: dims.height, axis: "height" };

  throw new Error(
    "no usable dimension in dimensions_mm (need one of width/diameter/length/height)",
  );
}

export function computeCutoutPixelSize(
  args: ComputeCutoutPixelSizeArgs,
): PixelSize {
  const { dimensionsMm, pxPerMm, scaleAdjust, cutoutAspect, widthBasis } = args;

  if (!(pxPerMm > 0)) throw new Error(`invalid pxPerMm: ${pxPerMm}`);
  if (!(scaleAdjust > 0)) throw new Error(`invalid scaleAdjust: ${scaleAdjust}`);
  if (!(cutoutAspect > 0)) {
    throw new Error(`invalid cutoutAspect: ${cutoutAspect}`);
  }

  const { mm, axis } = resolveGoverning(dimensionsMm, widthBasis);
  const governingPx = mm * pxPerMm * scaleAdjust;

  let width: number;
  let height: number;
  if (axis === "width") {
    width = Math.round(governingPx);
    height = Math.round(governingPx / cutoutAspect);
  } else {
    height = Math.round(governingPx);
    width = Math.round(governingPx * cutoutAspect);
  }

  width = Math.max(1, width);
  height = Math.max(1, height);

  if (width > MAX_CUTOUT_PX || height > MAX_CUTOUT_PX) {
    throw new Error(
      `computed cutout size ${width}x${height}px exceeds MAX_CUTOUT_PX ` +
        `(${MAX_CUTOUT_PX}px); check pxPerMm (${pxPerMm}) / scaleAdjust (${scaleAdjust})`,
    );
  }

  return { width, height };
}
