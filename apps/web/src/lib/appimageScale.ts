import type {
  AppImageAnchor,
  AppImageWidthBasis,
  DimensionsMm,
} from "@wac/shared";

/**
 * Frontend mirror of the generator's scale engine + anchor placement
 * (apps/generator/src/scale.ts and composite.ts). The placement canvas needs to
 * preview exactly where/what size each cutout will land, so this duplicates that
 * deterministic math. Keep it in lockstep with the server.
 */

export interface PixelSize {
  width: number;
  height: number;
}

type Axis = "width" | "height";

/**
 * `auto` priority is `width > diameter > length > height`, matching
 * resolveGoverning in the generator. Returns null when no usable dimension or a
 * requested non-auto basis is missing (the UI surfaces this instead of throwing).
 */
function resolveGoverning(
  dims: DimensionsMm,
  widthBasis: AppImageWidthBasis,
): { mm: number; axis: Axis } | null {
  if (widthBasis !== "auto") {
    const mm = dims[widthBasis];
    if (typeof mm === "number" && mm > 0) {
      return { mm, axis: widthBasis === "height" ? "height" : "width" };
    }
    return null;
  }

  if (dims.width && dims.width > 0) return { mm: dims.width, axis: "width" };
  if (dims.diameter && dims.diameter > 0) {
    return { mm: dims.diameter, axis: "width" };
  }
  if (dims.length && dims.length > 0) return { mm: dims.length, axis: "width" };
  if (dims.height && dims.height > 0) return { mm: dims.height, axis: "height" };
  return null;
}

export interface ComputeCutoutPixelSizeArgs {
  dimensionsMm: DimensionsMm;
  pxPerMm: number;
  scaleAdjust: number;
  /** Source cutout aspect ratio = nativeWidth / nativeHeight. */
  cutoutAspect: number;
  widthBasis: AppImageWidthBasis;
}

/** Pixel size (in scene-native pixels) the cutout will be composited at, or null. */
export function computeCutoutPixelSize(
  args: ComputeCutoutPixelSizeArgs,
): PixelSize | null {
  const { dimensionsMm, pxPerMm, scaleAdjust, cutoutAspect, widthBasis } = args;
  if (!(pxPerMm > 0) || !(scaleAdjust > 0) || !(cutoutAspect > 0)) return null;

  const governing = resolveGoverning(dimensionsMm, widthBasis);
  if (!governing) return null;

  const governingPx = governing.mm * pxPerMm * scaleAdjust;
  let width: number;
  let height: number;
  if (governing.axis === "width") {
    width = governingPx;
    height = governingPx / cutoutAspect;
  } else {
    height = governingPx;
    width = governingPx * cutoutAspect;
  }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/**
 * Translate an anchor + fractional position into a top-left pixel offset for the
 * resized cutout, clamped inside the scene. Mirrors anchorToTopLeft in the
 * generator's composite.ts.
 */
export function anchorToTopLeft(
  anchor: AppImageAnchor,
  xPct: number,
  yPct: number,
  size: PixelSize,
  sceneW: number,
  sceneH: number,
): { left: number; top: number } {
  const anchorX = xPct * sceneW;
  const anchorY = yPct * sceneH;
  const [vert, horiz] =
    anchor === "center" ? ["center", "center"] : anchor.split("-");

  let left: number;
  if (horiz === "left") left = anchorX;
  else if (horiz === "right") left = anchorX - size.width;
  else left = anchorX - size.width / 2;

  let top: number;
  if (vert === "top") top = anchorY;
  else if (vert === "bottom") top = anchorY - size.height;
  else top = anchorY - size.height / 2;

  const clamp = (n: number, min: number, max: number) =>
    Math.min(max, Math.max(min, n));
  return {
    left: clamp(left, 0, Math.max(0, sceneW - size.width)),
    top: clamp(top, 0, Math.max(0, sceneH - size.height)),
  };
}

/**
 * Scene scale: pixels-per-mm from the scene's natural pixel width and the user's
 * real-world width estimate. The generator's `auto` basis maps horizontal
 * dimensions to width, so anchoring scale to the scene width is consistent.
 */
export function pxPerMmFromSceneWidth(
  sceneNaturalWidthPx: number,
  sceneWidthMm: number,
): number | null {
  if (!(sceneNaturalWidthPx > 0) || !(sceneWidthMm > 0)) return null;
  return sceneNaturalWidthPx / sceneWidthMm;
}
