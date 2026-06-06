import sharp from "sharp";
import type {
  AppImageAnchor,
  AppImageModel,
  AppImageOutput,
  AppImagePerspective,
  AppImageWidthBasis,
  DimensionsMm,
} from "@wac/shared";
import { fetchImageBuffer } from "./fetchImage.js";
import { computeCutoutPixelSize, type PixelSize } from "./scale.js";
import { isIdentityPerspective, warpCutout } from "./warp.js";

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
  /** Catalog image URL. Optional when `model` is set (cutout is rendered). */
  cutoutUrl?: string;
  /**
   * Optional 3D model + pose. When set, the cutout is rendered from the real
   * fixture geometry (Blender) instead of fetched/matted — true viewpoint/scale.
   */
  model?: AppImageModel;
  dimensionsMm: DimensionsMm;
  anchor: AppImageAnchor;
  xPct: number;
  yPct: number;
  widthBasis: AppImageWidthBasis;
  /**
   * Optional deterministic perspective warp applied to the (background-removed)
   * cutout before sizing/placement. Corrects viewing angle using the real
   * pixels — never re-renders the fixture.
   */
  perspective?: AppImagePerspective;
}

/** A short label for a fixture used in errors + placement metadata. */
function fixtureLabel(f: { cutoutUrl?: string; model?: AppImageModel }): string {
  return f.cutoutUrl ?? f.model?.url ?? "model";
}

/**
 * Hook to transform a freshly-fetched cutout before it's composited - used to
 * swap in a background-removed (matted) version. Receives the source URL and the
 * fetched image; returns the image to actually composite.
 */
export type PrepareCutout = (
  sourceUrl: string,
  fetched: SourceImage,
) => Promise<SourceImage>;

/**
 * Hook to render a fixture's 3D model into a transparent cutout (Blender via the
 * render-worker), tightly trimmed to the fixture. Returns the image to composite
 * exactly like a matted photo cutout, so the rest of the pipeline is unchanged.
 */
export type RenderModel = (model: AppImageModel) => Promise<SourceImage>;

export interface CompositeInput {
  sceneUrl: string;
  pxPerMm: number;
  scaleAdjust: number;
  fixtures: FixtureInput[];
  output: AppImageOutput;
  prepareCutout?: PrepareCutout;
  renderModel?: RenderModel;
}

export interface Placement {
  cutoutUrl: string;
  dimensionsMm: DimensionsMm;
  computedPx: PixelSize;
  position: { left: number; top: number };
  anchor: AppImageAnchor;
}

/**
 * A placement plus the resized RGBA cutout buffer actually composited. The
 * hybrid pipeline (2d) needs the resized cutout's alpha to subtract the fixture
 * core when building the inpaint mask, so the real product pixels are preserved.
 */
export interface PlacedFixture extends Placement {
  resizedCutout: Buffer;
}

/** The composited scene before output-format encoding, plus where each fixture landed. */
export interface PlaceResult {
  /** Lossless PNG of the scene with every cutout composited at its scaled size. */
  base: Buffer;
  width: number;
  height: number;
  placements: PlacedFixture[];
}

/** An image encoded to its final delivery format (PNG or JPEG). */
export interface EncodedImage {
  body: Buffer;
  format: "png" | "jpeg";
  contentType: string;
  width: number;
  height: number;
}

export interface CompositeResult extends EncodedImage {
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

export interface FetchedScene {
  scene: SourceImage;
  fixtures: PreparedFixture[];
}

/**
 * Fetch the scene + every cutout from their URLs. Separated from placement so
 * the deterministic compositing can be exercised with in-memory buffers (the
 * fetch path is https-only) and so the hybrid pipeline can reuse the same data.
 */
export async function fetchSceneAndFixtures(
  sceneUrl: string,
  fixtures: FixtureInput[],
  prepareCutout?: PrepareCutout,
  renderModel?: RenderModel,
): Promise<FetchedScene> {
  const sceneFetched = await fetchImageBuffer(sceneUrl);
  if (!sceneFetched.width || !sceneFetched.height) {
    throw new Error(`scene image has no readable dimensions: ${sceneUrl}`);
  }
  const scene: SourceImage = {
    buffer: sceneFetched.buffer,
    width: sceneFetched.width,
    height: sceneFetched.height,
    hasAlpha: sceneFetched.hasAlpha,
  };

  const prepared: PreparedFixture[] = [];
  for (const fixture of fixtures) {
    // 3D-model fixtures are rendered to a transparent cutout (Blender); flat
    // catalog cutouts are fetched + matted. Both yield an RGBA SourceImage.
    if (fixture.model) {
      if (!renderModel) {
        throw new Error(
          "fixture has a 3D model but model rendering is not configured " +
            "(set RENDER_WORKER_URL on the generator)",
        );
      }
      const source = await renderModel(fixture.model);
      prepared.push({ ...fixture, source });
      continue;
    }

    if (!fixture.cutoutUrl) {
      throw new Error("fixture has neither a cutoutUrl nor a 3D model");
    }
    const cut = await fetchImageBuffer(fixture.cutoutUrl);
    if (!cut.width || !cut.height) {
      throw new Error(`cutout has no readable dimensions: ${fixture.cutoutUrl}`);
    }
    let source: SourceImage = {
      buffer: cut.buffer,
      width: cut.width,
      height: cut.height,
      hasAlpha: cut.hasAlpha,
    };
    if (prepareCutout) {
      source = await prepareCutout(fixture.cutoutUrl, source);
    }
    prepared.push({ ...fixture, source });
  }

  return { scene, fixtures: prepared };
}

/**
 * Conform a (possibly generative) image back to an exact width×height frame.
 * Gemini image edits emit ~1024px, often squarish, so the relight pass would
 * otherwise shrink/squarify the composite. We stretch-fit back to the original
 * scene frame so the deterministic geometry/aspect is preserved. No-op when the
 * dimensions already match.
 */
export async function conformToSize(
  image: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  if (meta.width === width && meta.height === height) return image;
  return sharp(image).resize(width, height, { fit: "fill" }).png().toBuffer();
}

/**
 * Encode a composited base image to the requested output format. The base is
 * always a lossless PNG (preserving any alpha); JPEG output is flattened onto
 * white. Shared by the composite and hybrid paths so output handling is uniform.
 */
export async function encodeOutput(
  base: Buffer,
  output: AppImageOutput,
): Promise<EncodedImage> {
  const pipeline =
    output.format === "jpeg"
      ? sharp(base)
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: output.quality ?? 90 })
      : sharp(base).png();
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    body: data,
    format: output.format === "jpeg" ? "jpeg" : "png",
    contentType: output.format === "jpeg" ? "image/jpeg" : "image/png",
    width: info.width,
    height: info.height,
  };
}

/**
 * Fetch the scene + cutouts, then composite. Convenience wrapper that runs the
 * full deterministic path (Phase 2c behaviour, unchanged externally).
 */
export async function composeAppImage(
  input: CompositeInput,
): Promise<CompositeResult> {
  const { scene, fixtures } = await fetchSceneAndFixtures(
    input.sceneUrl,
    input.fixtures,
    input.prepareCutout,
    input.renderModel,
  );
  return compositeFixtures({
    scene,
    fixtures,
    pxPerMm: input.pxPerMm,
    scaleAdjust: input.scaleAdjust,
    output: input.output,
  });
}

/**
 * Size every cutout from its real dimensions and composite it onto the scene,
 * returning the lossless PNG base plus where each fixture landed (with the
 * resized cutout, for mask derivation). No network, no output encoding here.
 */
export async function placeFixtures(
  input: Omit<CompositeFixturesInput, "output">,
): Promise<PlaceResult> {
  const { scene } = input;
  const sceneW = scene.width;
  const sceneH = scene.height;
  if (!sceneW || !sceneH) {
    throw new Error("scene image has no readable dimensions");
  }

  const overlays: sharp.OverlayOptions[] = [];
  const placements: PlacedFixture[] = [];

  for (const fixture of input.fixtures) {
    let cut = fixture.source;
    if (!cut.hasAlpha) {
      throw new Error(
        `cutout ${fixtureLabel(fixture)} has no alpha channel; cutouts must be ` +
          `RGBA PNGs with a transparent background (background removal is not ` +
          `performed here)`,
      );
    }
    if (!cut.width || !cut.height) {
      throw new Error(
        `cutout has no readable dimensions: ${fixtureLabel(fixture)}`,
      );
    }

    // Deterministic perspective correction of the real pixels (if requested),
    // before sizing so the warped footprint drives the on-screen scale.
    if (!isIdentityPerspective(fixture.perspective)) {
      const warped = await warpCutout(cut.buffer, fixture.perspective!);
      const meta = await sharp(warped).metadata();
      cut = {
        buffer: warped,
        width: meta.width ?? cut.width,
        height: meta.height ?? cut.height,
        hasAlpha: true,
      };
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
        `cutout ${fixtureLabel(fixture)} sized to ${size.width}x${size.height}px ` +
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
      cutoutUrl: fixtureLabel(fixture),
      dimensionsMm: fixture.dimensionsMm,
      computedPx: size,
      position,
      anchor: fixture.anchor,
      resizedCutout: resized,
    });
  }

  const base = await sharp(scene.buffer).composite(overlays).png().toBuffer();
  return { base, width: sceneW, height: sceneH, placements };
}

/**
 * Deterministic compositing core (Phase 2c): place every cutout and encode to
 * the requested output format. No network here.
 */
export async function compositeFixtures(
  input: CompositeFixturesInput,
): Promise<CompositeResult> {
  const placed = await placeFixtures(input);
  const encoded = await encodeOutput(placed.base, input.output);
  const placements: Placement[] = placed.placements.map(
    ({ resizedCutout, ...rest }) => rest,
  );
  return { ...encoded, placements };
}
