/**
 * Image-generation adapter layer (Phase 2d — Option C hybrid pipeline).
 *
 * The container's AI steps run behind these small capability interfaces so the
 * underlying provider (BFL FLUX.1 Fill, Google Gemini) can be swapped without
 * touching the pipeline. Each adapter owns its own request timeout so a stuck
 * provider surfaces an actionable error instead of a generic container timeout.
 *
 * Capabilities are intentionally split: a provider implements only what it can.
 * - inpaint:   masked, prompt-driven local edit (FLUX.1 Fill). No reference img.
 * - harmonize: prompt-driven full-image lighting pass (Gemini). No mask.
 * - generate:  prompt (+ optional references) -> new image (Gemini concept mode).
 * - segment:   return object segmentation masks for background removal (Gemini).
 */

import { makeBflAdapter } from "./bfl.js";
import { makeGeminiAdapter } from "./gemini.js";
import { makeModelRenderAdapter } from "./modelRender.js";

/** Inpaint a masked region. White mask pixels are repainted; black preserved. */
export interface InpaintRequest {
  /** Composited base image (PNG/JPEG bytes). */
  image: Buffer;
  /** Mask bytes: white = repaint (lighting halo), black = keep (fixture core). */
  mask: Buffer;
  prompt: string;
  /** Optional sampling controls passed through to the provider. */
  steps?: number;
  guidance?: number;
  seed?: number;
}

/** Full-image, prompt-driven lighting/harmonization pass (no mask). */
export interface HarmonizeRequest {
  image: Buffer;
  prompt: string;
}

/**
 * Generative relight pass: edit the composited image so the fixture's lighting
 * fits the room (optionally "lights on"). `references` are the real fixture
 * cutout(s), passed back as a design reference so a geometry-locked prompt can
 * keep the shape faithful (no invented arms/crystals). Returns an opaque image.
 */
export interface RelightRequest {
  image: Buffer;
  references?: Buffer[];
  prompt: string;
  timeoutMs?: number;
}

export interface RelightAdapter {
  readonly provider: string;
  relight(req: RelightRequest): Promise<Buffer>;
}

/** Pure-generative scene from a prompt, optionally conditioned on references. */
export interface GenerateRequest {
  prompt: string;
  referenceImages?: Buffer[];
  /**
   * Optional Gemini imageConfig controls. `aspectRatio` (e.g. "16:9") and
   * `imageSize` ("1K"|"2K"|"4K", uppercase K) drive output dimensions; 4K needs
   * a Gemini 3 image model, so callers pass `model` to override per call.
   */
  aspectRatio?: string;
  imageSize?: string;
  model?: string;
  /** Per-call timeout override (large sizes can take much longer than 30s). */
  timeoutMs?: number;
}

export interface InpaintAdapter {
  readonly provider: string;
  inpaint(req: InpaintRequest): Promise<Buffer>;
}

export interface HarmonizeAdapter {
  readonly provider: string;
  harmonize(req: HarmonizeRequest): Promise<Buffer>;
}

export interface GenerateAdapter {
  readonly provider: string;
  generate(req: GenerateRequest): Promise<Buffer>;
}

/**
 * One object segmentation mask from Gemini. `box2d` is `[y0, x0, y1, x1]`
 * normalized to 0..1000 (Gemini's convention); `maskPngBase64` is a base64 PNG
 * probability map (0..255) sized to the bounding box. Used for background
 * removal: the caller scales the mask to the box, applies it as an alpha
 * channel, and composites a transparent cutout.
 */
export interface SegmentationMask {
  box2d: [number, number, number, number];
  maskPngBase64: string;
  label?: string;
}

/** Segment the foreground object(s) in an image (Gemini image understanding). */
export interface SegmentAdapter {
  readonly provider: string;
  segment(image: Buffer): Promise<SegmentationMask[]>;
}

/**
 * A keystone hint for auto-fitting a fixture's perspective to a room surface.
 * `vertical` > 0 means the top edge should recede (looking up at a ceiling
 * fixture); `horizontal` > 0 means the right edge recedes. Both in [-0.3, 0.3].
 */
export interface PerspectiveHint {
  vertical: number;
  horizontal: number;
}

export interface PerspectiveRequest {
  /** The scene image to analyze. */
  image: Buffer;
  /** Where the fixture mounts, to focus the surface estimate. */
  mount?: string;
  timeoutMs?: number;
}

/** Estimate the perspective of a room surface from the scene (Gemini vision). */
export interface PerspectiveAdapter {
  readonly provider: string;
  estimatePerspective(req: PerspectiveRequest): Promise<PerspectiveHint>;
}

export interface SceneInspectRequest {
  /** The generated scene image to inspect. */
  image: Buffer;
  /** Where the real fixture will mount — focuses the check on that surface. */
  mount?: string;
  timeoutMs?: number;
}

/**
 * Vision check used to keep scene generation "clean": returns true when the
 * generated room already contains a light fixture or mounting hardware (junction
 * box, canopy, etc.) on the target surface, so the caller can regenerate before
 * we composite the real fixture on top.
 */
export interface SceneInspectAdapter {
  readonly provider: string;
  hasMountedFixture(req: SceneInspectRequest): Promise<boolean>;
}

/** Suggested corrections to a fixture placement, each in its own unit. */
export interface PlacementAdjust {
  /** Absolute screen target for the fixture center (0..1), if a move is needed. */
  xPct?: number;
  yPct?: number;
  /** Absolute fixture height as a fraction of the frame (0..1). */
  coverage?: number;
  /** Absolute light slider (0..100). */
  brightness?: number;
}

export interface PlacementCritiqueRequest {
  /** The preview composite to judge. */
  image: Buffer;
  /** Fixture context so the rubric fits the type (sconce vs chandelier). */
  fixtureType?: string;
  mount?: "ceiling" | "wall" | "floor" | "recessed";
  /** The current placement, so the model returns sensible absolute corrections. */
  current?: PlacementAdjust;
  timeoutMs?: number;
}

export interface PlacementCritique {
  approved: boolean;
  /** Absolute corrected values to apply before the next preview (when not approved). */
  adjust?: PlacementAdjust;
  /** Short human-readable reason (logged, not shown to the user). */
  reason?: string;
}

/** Request to analyze a BARE room (no fixture yet) for the best mount spot. */
export interface RoomAnalysisRequest {
  /** The empty room plate. */
  image: Buffer;
  fixtureType?: string;
  mount?: "ceiling" | "wall" | "floor" | "recessed";
  timeoutMs?: number;
}

/** Where the fixture should go, read off the room itself before any render. */
export interface RoomPlacement {
  /** Fixture center as 0..1 from top-left. */
  xPct: number;
  yPct: number;
  /** Fixture height as a fraction of the frame (0..1), if the model offers one. */
  coverage?: number;
  reason?: string;
}

/**
 * Vision critic for the auto-placement loop: judges a preview composite (is the
 * fixture grounded, correctly scaled/positioned, and clearly lighting the space?)
 * and returns absolute corrections to apply before the next preview. Fails open
 * (approved=true) so a flaky vision call never deadlocks the loop.
 *
 * `analyzeRoom` (optional) reads the BARE room before any render to find the
 * natural mount point (ceiling center above the seating, a clear wall, etc.), so
 * the fixture starts in the right place instead of dead-center.
 */
export interface PlacementCriticAdapter {
  readonly provider: string;
  critiquePlacement(req: PlacementCritiqueRequest): Promise<PlacementCritique>;
  analyzeRoom?(req: RoomAnalysisRequest): Promise<RoomPlacement | null>;
}

/** Camera pose for an orbit render of a 3D fixture (degrees + framing factors). */
export interface ModelRenderPose {
  azimuthDeg?: number;
  elevationDeg?: number;
  /** Roll about the camera's view axis (side-to-side tilt / lean), in degrees. */
  rollDeg?: number;
  fovDeg?: number;
  distanceFactor?: number;
  marginFactor?: number;
}

/**
 * Render a real 3D fixture model (.blend/.glb) to a transparent PNG at a given
 * pose. Either `modelUrl` (fetched by the worker) or `modelPath` (local, POC).
 */
export interface ModelRenderRequest {
  modelUrl?: string;
  modelPath?: string;
  /** Helps the worker pick the fixture collection inside the file. */
  sku?: string;
  pose?: ModelRenderPose;
  width?: number;
  height?: number;
  engine?: string;
  samples?: number;
  lightsOn?: boolean;
}

export interface ExportGlbRequest {
  modelUrl?: string;
  modelPath?: string;
  /** Helps the worker pick the fixture collection inside the file. */
  sku?: string;
}

export interface ModelRenderAdapter {
  readonly provider: string;
  render(req: ModelRenderRequest): Promise<Buffer>;
  /** Export the fixture (no studio rig) to a GLB for the web 3D viewer. */
  exportGlb(req: ExportGlbRequest): Promise<Buffer>;
}

/**
 * Render a 3D fixture composited INTO a room plate (the in-Blender app-shot
 * pipeline): the fixture refracts/lights the real room and the result IS the
 * framed image. `preview` does a fast low-res single render for the interactive
 * AI/slider loop; the final render emits the layered PSD + AVIF too.
 */
export interface CompositeRenderRequest {
  modelUrl?: string;
  modelPath?: string;
  sku?: string;
  /** The room plate to composite into (URL the worker fetches, or local path). */
  roomUrl?: string;
  roomPath?: string;
  /** Manufacturer IES photometry for accurate spill (optional — decoratives lack it). */
  iesUrl?: string;
  iesPath?: string;
  iesRotation?: [number, number, number];
  pose?: ModelRenderPose;
  cameraName?: string;
  /** Fixture height as a fraction of the frame (0..1). */
  coverage?: number;
  /** Screen position of the fixture center (0..1). */
  xPct?: number;
  yPct?: number;
  /** Fixture-brightness slider (0..200, 25 = neutral): the fixture's own glow. */
  brightness?: number;
  /** Light-output slider (0..200, 25 = neutral): real light thrown into the room. */
  lightOutput?: number;
  warm?: number;
  samples?: number;
  highQuality?: boolean;
  /** Final export emits the layered PSD; preview is png-only. */
  layers?: boolean;
  preview?: boolean;
  previewMaxPx?: number;
  /** Render at this multiple of the target size then downscale (crisp fixture AA). */
  supersample?: number;
  /** Final export: upscale the room so its long edge is >= this many px. */
  finalLongEdge?: number;
  timeoutMs?: number;
}

export interface CompositeResult {
  png: Buffer;
  avif?: Buffer;
  /** Layered PSD (Background / Light+Shadow / Fixture / Fixture Glow) on finals. */
  psd?: Buffer;
}

export interface CompositeAdapter {
  readonly provider: string;
  composite(req: CompositeRenderRequest): Promise<CompositeResult>;
}

/**
 * The set of adapters available for a generation run. Each slot is populated
 * only when the corresponding provider key is configured, so the pipeline can
 * fail with a precise "X not configured" error rather than a null deref.
 */
export interface ImageGenAdapters {
  inpainter?: InpaintAdapter;
  harmonizer?: HarmonizeAdapter;
  generator?: GenerateAdapter;
  segmenter?: SegmentAdapter;
  relighter?: RelightAdapter;
  perspective?: PerspectiveAdapter;
  inspector?: SceneInspectAdapter;
  /** Self-hosted Blender render-worker (Phase 3 3D fixture path). */
  modelRenderer?: ModelRenderAdapter;
  /** In-Blender room compositing (Phase 3 app-shot pipeline). */
  compositor?: CompositeAdapter;
  /** Vision check that critiques + auto-corrects fixture placement. */
  placementCritic?: PlacementCriticAdapter;
}

export interface AdapterConfig {
  /** Black Forest Labs API key (FLUX.1 Fill). */
  bflApiKey?: string;
  /** Google Gemini API key (image generation + understanding/segmentation). */
  geminiApiKey?: string;
  /** Gemini model for segmentation (background removal). */
  geminiSegmentModel?: string;
  /** Render-worker base URL (Blender 3D fixture rendering). */
  renderWorkerUrl?: string;
}

/**
 * Build the available adapters from configured keys. BFL provides the inpainter;
 * Gemini provides the harmonizer, the concept-mode generator, and the segmenter
 * (background removal). Missing keys leave a slot unset.
 */
export function makeImageGenAdapters(config: AdapterConfig): ImageGenAdapters {
  const adapters: ImageGenAdapters = {};

  if (config.bflApiKey) {
    adapters.inpainter = makeBflAdapter({ apiKey: config.bflApiKey });
  }

  if (config.geminiApiKey) {
    const gemini = makeGeminiAdapter({
      apiKey: config.geminiApiKey,
      segmentModel: config.geminiSegmentModel,
    });
    adapters.harmonizer = gemini;
    adapters.generator = gemini;
    adapters.segmenter = gemini;
    adapters.relighter = gemini;
    adapters.perspective = gemini;
    adapters.inspector = gemini;
    adapters.placementCritic = gemini;
  }

  if (config.renderWorkerUrl) {
    const worker = makeModelRenderAdapter({ url: config.renderWorkerUrl });
    adapters.modelRenderer = worker;
    adapters.compositor = worker;
  }

  return adapters;
}

// ---------------------------------------------------------------------------
// Shared fetch helper — single place for the per-call timeout + error shape.
// ---------------------------------------------------------------------------

/**
 * `fetch` with an AbortSignal timeout that turns an abort into a labelled error
 * (`<label> timed out after <ms>ms`) so a slow provider is diagnosable.
 */
export async function fetchWithTimeout(
  label: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw e;
  }
}
