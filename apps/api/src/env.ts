import type { GenerationMessage } from "./generation.js";
import type { GenerationContainer } from "./container.js";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  HUBSPOT_TOKEN?: string;
  // Sales Layer PIM (Phase 2), legacy Connector API (api.saleslayer.com).
  // Auth is sha256(connectorId + secretKey + time + unique). When unset
  // (dev / pre-launch) the products cache simply isn't refreshed.
  SALES_LAYER_CONNECTOR_ID?: string;
  SALES_LAYER_SECRET_KEY?: string;
  // The user originally pasted the secret here; accepted as a fallback for
  // SALES_LAYER_SECRET_KEY so existing .dev.vars keep working.
  SALES_LAYER_API_KEY?: string;
  // Optional overrides.
  SALES_LAYER_API_HOST?: string; // default api.saleslayer.com
  SALES_LAYER_API_VERSION?: string; // default 1.18
  // Source unit for raw Sales Layer fixture dimensions: "mm" | "cm" | "in".
  // WAC's catalog publishes inches, so the adapter defaults to "in".
  SALES_LAYER_DIMENSION_UNIT?: string;
  // Optional override pinning the exact Sales Layer product field that holds the
  // brand. When unset, the adapter auto-discovers it from common field names.
  SALES_LAYER_BRAND_FIELD?: string;
  SHORT_LINK_HOST: string;
  SHORT_LINKS: KVNamespace;
  ASSETS_BUCKET: R2Bucket;
  ASSETS: Fetcher;

  // Phase 2b — async generation pipeline.
  // Producer binding the API enqueues jobs onto; the consumer is configured in
  // wrangler.jsonc and handled by the queue() export in index.ts.
  GENERATION_QUEUE: Queue<GenerationMessage>;
  // Container-enabled Durable Object namespace (see container.ts).
  GENERATION_CONTAINER: DurableObjectNamespace<GenerationContainer>;
  // R2 S3-API credentials forwarded into the generation Container so it can
  // write generated assets directly. These never live in the image — they are
  // injected via the container's envVars at start (see container.ts).
  R2_ENDPOINT: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;

  // Phase 2d — AI image providers for the Application Image hybrid/concept
  // modes. Forwarded into the generation Container (see container.ts). When
  // unset, only the deterministic `composite` mode works. Optional so the
  // Worker still boots (and Phase 1 keeps running) without them.
  BFL_API_KEY?: string; // Black Forest Labs — FLUX.1 Fill (masked inpainting)
  GEMINI_API_KEY?: string; // Google Gemini 2.5 Flash Image — harmonize / concept
  // Gemini model for text-to-room scene generation. Defaults to a Gemini 3
  // image model in the container (4K-capable); override here to pin a model.
  GEMINI_SCENE_MODEL?: string;
  // fal.ai key for BiRefNet background removal (matting) of fixture cutouts.
  // When unset, the generator falls back to requiring pre-cut transparent PNGs.
  FAL_API_KEY?: string;
}
