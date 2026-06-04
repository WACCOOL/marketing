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
 * The set of adapters available for a generation run. Each slot is populated
 * only when the corresponding provider key is configured, so the pipeline can
 * fail with a precise "X not configured" error rather than a null deref.
 */
export interface ImageGenAdapters {
  inpainter?: InpaintAdapter;
  harmonizer?: HarmonizeAdapter;
  generator?: GenerateAdapter;
  segmenter?: SegmentAdapter;
}

export interface AdapterConfig {
  /** Black Forest Labs API key (FLUX.1 Fill). */
  bflApiKey?: string;
  /** Google Gemini API key (image generation + understanding/segmentation). */
  geminiApiKey?: string;
  /** Gemini model for segmentation (background removal). */
  geminiSegmentModel?: string;
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
