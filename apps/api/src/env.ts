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
  // Gemini model for segmentation-based background removal of fixture cutouts.
  // Defaults to gemini-2.5-flash in the container; override here to pin a model.
  GEMINI_SEGMENT_MODEL?: string;
  // Phase 3 — base URL of the self-hosted Blender render-worker for 3D fixture
  // rendering. POC: a local/tunneled dev box; prod: the GPU server. When unset,
  // fixtures that carry a 3D model fail with a precise "not configured" error.
  RENDER_WORKER_URL?: string;

  // Origin used when building public URLs (uploads / generated scenes / shot
  // previews) that the render-worker and generator fetch back over HTTP. Defaults
  // to the request origin. LOCAL DEV: wrangler stamps the configured custom-domain
  // host (marketing.gowac.cc) onto request.url even when served on localhost, so
  // set PUBLIC_BASE_URL=http://localhost:8787 to make those URLs fetchable locally.
  PUBLIC_BASE_URL?: string;

  // LOCAL DEV ONLY — base URL of a host-run generation service (node). When set,
  // the API calls this URL directly instead of the GENERATION_CONTAINER Durable
  // Object. This sidesteps the local container runtime (whose proxy sidecar is
  // flaky under some Docker/kernel setups; see workers-sdk#12965). MUST be unset
  // in production so the real container path is used.
  GENERATOR_URL?: string;
}
