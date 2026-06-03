import sharp from "sharp";
import type {
  AppImageAnchor,
  AppImageOutput,
  AppImageWidthBasis,
  DimensionsMm,
} from "@wac/shared";
import { fetchImageBuffer } from "./fetchImage.js";
import { computeCutoutPixelSize, type PixelSize } from "./scale.js";

/**
 * Compositing (Phase 2c). Fetches the scene + each cutout, sizes every cutout
 * from its real dimensions via the scale engine, and composites them onto the
 * scene at anchor/percentage positions. Deterministic - no AI here.
 *
 * Cutouts MUST be RGBA PNGs (transparent background). Background removal is out
 * of scope; an opaque cutout (JPEG, or PNG with no alpha) is rejected so we never
 * paste a visible rectangle into the scene.
 */

export interface FixtureInput {
  cutoutUrl: string;
  dimensionsMm: DimensionsMm;
  anchor: AppImageAnchor;
  xPct: number;
  yPct: number;
  widthBasis: AppImageWidthBasis;
}

export interface CompositeInput {
  sceneUrl: string;
  pxPerMm: number;
  scaleAdjust: number;
  fixtures: FixtureInput[];
  output: AppImageOutput;
}

export interface Placement {
  cutoutUrl: string;
  dimensionsMm: DimensionsMm;
  computedPx: PixelSize;
  position: { left: number; top: number };
  anchor: AppImageAnchor;
}

export interface CompositeResult {
  body: Buffer;
  format: "png" | "jpeg";
  contentType: string;
  width: number;
  height: number;
  placements: Placement[];
}

/** A decoded source image (scene or cutout) with the metadata the engine needs. */
export interface SourceImage {
  buffer: Buffer;
  width: number;
  height: number;
  hasAlpha: boolean;
}

export interface PreparedFixture extends FixtureInput {
  source: SourceImage;
}

export interface CompositeFixturesInput {
  scene: SourceImage;
  fixtures: PreparedFixture[];
  pxPerMm: number;
  scaleAdjust: number;
  output: AppImageOutput;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Translate an anchor + fractional position into a top-left pixel offset for the
 * resized cutout, clamped so the overlay stays fully inside the scene (sharp
 * rejects overlays that extend past the base image).
 */
function anchorToTopLeft(
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

  return {
    left: Math.round(clamp(left, 0, Math.max(0, sceneW - size.width))),
    top: Math.round(clamp(top, 0, Math.max(0, sceneH - size.height))),
  };
}

/**
 * Fetch the scene + every cutout from their URLs, then composite. The fetch is
 * separated from `compositeFixtures` so the deterministic compositing can be
 * exercised directly with in-memory buffers (the fetch path is https-only).
 */
export async function composeAppImage(
  input: CompositeInput,
): Promise<CompositeResult> {
  const sceneFetched = await fetchImageBuffer(input.sceneUrl);
  if (!sceneFetched.width || !sceneFetched.height) {
    throw new Error(`scene image has no readable dimensions: ${input.sceneUrl}`);
  }
  const scene: SourceImage = {
    buffer: sceneFetched.buffer,
    width: sceneFetched.width,
    height: sceneFetched.height,
    hasAlpha: sceneFetched.hasAlpha,
  };

  const fixtures: PreparedFixture[] = [];
  for (const fixture of input.fixtures) {
    const cut = await fetchImageBuffer(fixture.cutoutUrl);
    if (!cut.width || !cut.height) {
      throw new Error(`cutout has no readable dimensions: ${fixture.cutoutUrl}`);
    }
    fixtures.push({
      ...fixture,
      source: {
        buffer: cut.buffer,
        width: cut.width,
        height: cut.height,
        hasAlpha: cut.hasAlpha,
      },
    });
  }

  return compositeFixtures({
    scene,
    fixtures,
    pxPerMm: input.pxPerMm,
    scaleAdjust: input.scaleAdjust,
    output: input.output,
  });
}

/**
 * Deterministic compositing core: size every cutout from its real dimensions,
 * place it at its anchor, and flatten onto the scene. No network here.
 */
export async function compositeFixtures(
  input: CompositeFixturesInput,
): Promise<CompositeResult> {
  const { scene } = input;
  const sceneW = scene.width;
  const sceneH = scene.height;
  if (!sceneW || !sceneH) {
    throw new Error("scene image has no readable dimensions");
  }

  const overlays: sharp.OverlayOptions[] = [];
  const placements: Placement[] = [];

  for (const fixture of input.fixtures) {
    const cut = fixture.source;
    if (!cut.hasAlpha) {
      throw new Error(
        `cutout ${fixture.cutoutUrl} has no alpha channel; cutouts must be ` +
          `RGBA PNGs with a transparent background (background removal is not ` +
          `performed here)`,
      );
    }
    if (!cut.width || !cut.height) {
      throw new Error(`cutout has no readable dimensions: ${fixture.cutoutUrl}`);
    }

    const size = computeCutoutPixelSize({
      dimensionsMm: fixture.dimensionsMm,
      pxPerMm: input.pxPerMm,
      scaleAdjust: input.scaleAdjust,
      cutoutAspect: cut.width / cut.height,
      widthBasis: fixture.widthBasis,
    });

    if (size.width > sceneW || size.height > sceneH) {
      throw new Error(
        `cutout ${fixture.cutoutUrl} sized to ${size.width}x${size.height}px ` +
          `is larger than the scene (${sceneW}x${sceneH}px); reduce scaleAdjust ` +
          `or use a larger scene`,
      );
    }

    // The computed size already matches the cutout's aspect ratio, so `fill`
    // yields exactly width x height (deterministic, alpha preserved).
    const resized = await sharp(cut.buffer)
      .resize(size.width, size.height, { fit: "fill" })
      .png()
      .toBuffer();

    const position = anchorToTopLeft(
      fixture.anchor,
      fixture.xPct,
      fixture.yPct,
      size,
      sceneW,
      sceneH,
    );

    overlays.push({ input: resized, left: position.left, top: position.top });
    placements.push({
      cutoutUrl: fixture.cutoutUrl,
      dimensionsMm: fixture.dimensionsMm,
      computedPx: size,
      position,
      anchor: fixture.anchor,
    });
  }

  const composited = sharp(scene.buffer).composite(overlays);

  if (input.output.format === "jpeg") {
    const body = await composited
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: input.output.quality ?? 90 })
      .toBuffer();
    return {
      body,
      format: "jpeg",
      contentType: "image/jpeg",
      width: sceneW,
      height: sceneH,
      placements,
    };
  }

  const body = await composited.png().toBuffer();
  return {
    body,
    format: "png",
    contentType: "image/png",
    width: sceneW,
    height: sceneH,
    placements,
  };
}
