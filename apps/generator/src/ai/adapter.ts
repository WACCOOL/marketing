/**
 * Image-generation adapter layer (Phase 2d — Option C hybrid pipeline).
 *
 * The container's AI steps run behind these small capability interfaces so the
 * underlying provider (BFL FLUX.1 Fill, Google Gemini, a future fal.ai / FLUX.2)
 * can be swapped without touching the pipeline. Every method takes and returns a
 * raw image `Buffer` — provider delivery URLs expire fast and have no CORS, so a
 * URL contract would be a footgun. Each adapter owns its own request timeout so
 * a stuck provider surfaces an actionable error instead of a generic container
 * timeout.
 *
 * Capabilities are intentionally split: a provider implements only what it can.
 * - inpaint:   masked, prompt-driven local edit (FLUX.1 Fill). No reference img.
 * - harmonize: prompt-driven full-image lighting pass (Gemini). No mask.
 * - generate:  prompt (+ optional references) -> new image (Gemini concept mode).
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
 * The set of adapters available for a generation run. Each slot is populated
 * only when the corresponding provider key is configured, so the pipeline can
 * fail with a precise "X not configured" error rather than a null deref.
 */
export interface ImageGenAdapters {
  inpainter?: InpaintAdapter;
  harmonizer?: HarmonizeAdapter;
  generator?: GenerateAdapter;
}

export interface AdapterConfig {
  /** Black Forest Labs API key (FLUX.1 Fill). */
  bflApiKey?: string;
  /** Google Gemini API key (gemini-2.5-flash-image). */
  geminiApiKey?: string;
}

/**
 * Build the available adapters from configured keys. BFL provides the inpainter;
 * Gemini provides both the harmonizer and the concept-mode generator. Missing
 * keys simply leave a slot unset.
 */
export function makeImageGenAdapters(config: AdapterConfig): ImageGenAdapters {
  const adapters: ImageGenAdapters = {};

  if (config.bflApiKey) {
    adapters.inpainter = makeBflAdapter({ apiKey: config.bflApiKey });
  }

  if (config.geminiApiKey) {
    const gemini = makeGeminiAdapter({ apiKey: config.geminiApiKey });
    adapters.harmonizer = gemini;
    adapters.generator = gemini;
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
