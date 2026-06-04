/**
 * fal.ai adapter — BiRefNet background removal (matting), Phase 2.
 *
 * Sales Layer product images are not pre-cut: most have white/grey/black or even
 * full graphic backgrounds, so a deterministic chroma-key can't isolate the
 * fixture. BiRefNet is a learned matting model that handles those plus the fine
 * detail WAC fixtures carry (thin rods/cords, glass shades, lattice). We run it
 * managed via fal.ai to keep quality high without GPU infrastructure.
 *
 * The fal sync endpoint (`https://fal.run/{model}`) waits for the result and
 * returns `{ image: { url, ... } }` pointing at a transparent PNG; we download
 * those bytes and return them as a Buffer.
 */

import { fetchWithTimeout, type MatteAdapter, type MatteRequest } from "./adapter.js";

const DEFAULT_BASE_URL = "https://fal.run";
const DEFAULT_MODEL = "fal-ai/birefnet/v2";
// "General Use (Heavy)" maximizes edge quality on fine detail (glass/thin parts).
const DEFAULT_MATTE_MODEL_VARIANT = "General Use (Heavy)";
const DEFAULT_OPERATING_RESOLUTION = "2048x2048";

const SUBMIT_TIMEOUT_MS = 90_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export interface FalConfig {
  apiKey: string;
  /** Override the API host (tests). */
  baseUrl?: string;
  /** Override the matting model id (e.g. "fal-ai/birefnet"). */
  model?: string;
  /** BiRefNet model variant ("General Use (Heavy|Light)", "Portrait", ...). */
  modelVariant?: string;
  /** Operating resolution (higher = finer edges, slower). */
  operatingResolution?: string;
}

interface BirefnetResponse {
  image?: { url?: string; content_type?: string };
}

export function makeFalMatteAdapter(config: FalConfig): MatteAdapter {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = config.model ?? DEFAULT_MODEL;
  const modelVariant = config.modelVariant ?? DEFAULT_MATTE_MODEL_VARIANT;
  const operatingResolution =
    config.operatingResolution ?? DEFAULT_OPERATING_RESOLUTION;
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    Authorization: `Key ${config.apiKey}`,
  };

  return {
    provider: `fal-${model}`,
    async matte(req: MatteRequest): Promise<Buffer> {
      const body = {
        image_url: req.imageUrl,
        model: modelVariant,
        operating_resolution: operatingResolution,
        output_format: "png",
        refine_foreground: true,
      };

      const res = await fetchWithTimeout(
        "fal BiRefNet",
        `${baseUrl}/${model}`,
        { method: "POST", headers, body: JSON.stringify(body) },
        SUBMIT_TIMEOUT_MS,
      );
      if (!res.ok) {
        throw new Error(
          `fal BiRefNet failed ${res.status}: ${await res.text().catch(() => "")}`,
        );
      }

      const data = (await res.json()) as BirefnetResponse;
      const url = data.image?.url;
      if (!url) throw new Error("fal BiRefNet returned no image url");

      const dl = await fetchWithTimeout(
        "fal BiRefNet download",
        url,
        { method: "GET" },
        DOWNLOAD_TIMEOUT_MS,
      );
      if (!dl.ok) {
        throw new Error(`fal BiRefNet result download failed ${dl.status}`);
      }
      return Buffer.from(await dl.arrayBuffer());
    },
  };
}
