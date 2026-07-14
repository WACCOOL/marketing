import type { GenerationMessage } from "./generation.js";
import type { GenerationContainer } from "./container.js";
import type { IngestMessage } from "./ingest.js";
import type { EventLeadBody } from "./eventLead.js";
import type { ZendeskSyncMessage } from "./zendeskSyncQueue.js";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  HUBSPOT_TOKEN?: string;
  // Gate for the weekly deal-stage probability writer (refreshStageProbabilities).
  // When != "1" the cron computes + logs the calibrated probabilities but does NOT
  // write them to the HubSpot pipeline — lets the numbers be validated first, and the
  // computation needs no extra scope. Set to "1" (and grant crm.pipelines.deals on the
  // private app) to enable writes.
  STAGE_PROB_WRITE?: string;
  // Gate for the derived dealstage/closedate writes in the SAP deal push
  // (absorbs HubSpot workflows 1741406037 + 1765878069, see @wac/shared
  // deriveDealStageAndCloseDate). When != "1" the push computes + logs what it
  // WOULD write ("[dealstage] would write ...") but writes nothing — dark
  // launch while the workflows still own these properties. Set to "1" after
  // the close-date backfill has run and the logged values check out.
  DEAL_STAGE_DERIVE_WRITE?: string;
  // Sub-gate: also maintain closedate on Closed Lost deals (newest line-item
  // rejection_date, fallback quote_last_changed_date). The HubSpot workflows
  // never did this — enable only if the lost-date rule is approved.
  DEAL_LOST_CLOSEDATE_WRITE?: string;
  // Gate for the derived createdate writes in the SAP deal push (@wac/shared
  // deriveCreateDate): backdate HubSpot's system createdate to the SAP quote
  // day (noon UTC) when quote_creation_date is on an earlier calendar day —
  // bulk-imported deals carry their import date, not the real quote date.
  // When != "1" the push computes + logs what it WOULD write ("[createdate]
  // would write ..."). Deals are the one HubSpot object whose createdate the
  // API accepts; the territory-sync --reconcile-deal-create-dates backfill
  // probe proves it against the live portal before this goes on.
  DEAL_CREATEDATE_WRITE?: string;
  // Gate for the derived amount writes in the SAP deal push (@wac/shared
  // deriveDealAmount): amount = Σ line quantity × unit_price. SAP's
  // quote_net_value header tracks OPEN value — it hits 0.00 when a quote fully
  // converts (exactly when the deal goes Closed Won), so the pass-through
  // zeroes/understates converted deals. When != "1" the push computes + logs
  // what it WOULD write ("[dealamount] would write ...").
  DEAL_AMOUNT_DERIVE_WRITE?: string;
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
  // Phase 2 (Product Information) — optional overrides pinning the exact
  // raw_json field that holds existing romance copy / the raw CCT value. When
  // unset, both are auto-discovered from common field names.
  SALES_LAYER_ROMANCE_FIELD?: string;
  SALES_LAYER_CCT_FIELD?: string;
  // Gemini model for Product Information text generation (SEO metadata),
  // called directly from the Worker (no container). Default: gemini-2.5-flash.
  GEMINI_TEXT_MODEL?: string;
  // Gemini model for ROMANCE COPY specifically — quality matters most there,
  // so it defaults to gemini-3.1-pro-preview (the strongest text model the
  // key exposes; SEO stays on flash). Override to pin/downgrade.
  GEMINI_ROMANCE_MODEL?: string;
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

  // Marketing data ingestion (Phase 1). The ingest endpoint enqueues onto this
  // producer; the consumer is the wac-ingest config in wrangler.jsonc, handled
  // by the queue() export in index.ts (branches to ingestQueue.ts).
  INGEST_QUEUE: Queue<IngestMessage>;

  // Marketing-event lead routing. The webhook enqueues one message per enrolled
  // contact; the wac-event-leads consumer (max_concurrency 1 → serial, rate-limit
  // friendly) processes them via eventLeadQueue.ts.
  EVENT_LEAD_QUEUE: Queue<EventLeadBody>;
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

  // Shared secret for server-to-server callers that have no Supabase session —
  // the fixture-sync CLI presents it (Bearer token) to trigger a GLB export when
  // baking picker thumbnails. When unset, the admin path is closed and only real
  // user sessions are accepted.
  ADMIN_API_TOKEN?: string;

  // Shared secret for the marketing data ingest endpoint (POST /api/ingest/:source).
  // Power Automate flows present it as a Bearer token to push files in. DEDICATED
  // (separate from ADMIN_API_TOKEN) so a leaked ingest token can't reach admin
  // routes. When unset, only authenticated GUI uploads work (the manual path).
  INGEST_API_TOKEN?: string;

  // Shared secret for the SAP -> HubSpot sync capture endpoint
  // (POST /api/hubspot-sync/...). The two AWS Lambdas present it as a Bearer
  // token to forward each payload + push outcome. DEDICATED (separate from the
  // ingest/admin tokens) so a leaked SAP token can't reach the file inbox or
  // admin routes. When unset, the capture endpoint is closed.
  SAP_SYNC_TOKEN?: string;

  // Full Google Cloud service-account JSON key for the Showroom PO Orders
  // sync (showroomOrders.ts) — Sheets API read-only. Each agency sheet must be
  // shared (Viewer) with the key's client_email. When unset, the sync is
  // skipped (cron) / errors clearly (manual route).
  GOOGLE_SA_KEY?: string;
  // Gate for the half-hourly showroom-orders cron. Deploy dark first (unset),
  // backfill via the manual route, then set to "1" to enable the schedule.
  SHOWROOM_SYNC_ENABLED?: string;
  // Per-source sync state (content markers + last-run summaries) so the
  // half-hourly polls skip unchanged sheets. Separate namespace from
  // SHORT_LINKS so sync bookkeeping can never collide with live redirects.
  SYNC_STATE: KVNamespace;

  // Slack incoming-webhook URL for severe HubSpot-sync alerts (heartbeat
  // no-data; Phase 2: DLQ / held-needs-decision / failure spikes). Best-effort —
  // when unset, alerts are logged only.
  ALERT_SLACK_WEBHOOK?: string;

  // HubSpot owner (by email) who receives the review TASK when the SAP push
  // auto-creates a Rep Code record for an unknown rep code (hubspotPush.ts).
  // Defaults in code to davis.rothenberg@waclighting.com; unresolvable email →
  // the task is created unassigned.
  REP_CODE_ALERT_OWNER_EMAIL?: string;

  // Microsoft Graph app-only (client-credentials) creds for the scheduled
  // ingestion pullers (graphPull.ts): pull the Territory file from SharePoint
  // and the Open Orders attachment from a mailbox. Requires admin-consented
  // Application permissions (Sites.Read.All, Mail.Read). When unset, the Graph
  // pull is skipped.
  MS_TENANT_ID?: string;
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  // The mailbox (UPN/address) the daily SAP Open Orders email lands in.
  OPEN_ORDERS_MAILBOX?: string;
  // SharePoint sharing URL of the "Annuity Pipeline" workbook — source of the
  // National-Account wildcard map applied to deals in pushDeal. Unset → the
  // real-time "National Account" labeling no-ops (the daily reconcile still runs).
  ANNUITY_SHEET_URL?: string;

  // Shared token for HubSpot-workflow-called endpoints: the public zip ->
  // rep-codes lookup (GET/POST /api/rep-codes/by-zip) AND the company sub-type
  // classifier (POST /api/hubspot/classify-company[/sync]), which the
  // territory-sync backfill also presents. When unset, those endpoints are closed.
  REP_LOOKUP_TOKEN?: string;

  // Additional token accepted ONLY by the Material Bank endpoints
  // (/api/hubspot/material-bank/*). Exists because the REP_LOOKUP_TOKEN value
  // is unrecoverable outside the deployed secret (HubSpot masks it; local
  // mirror went stale) — new callers (the Make.com file relay, the sync CLI)
  // use this one instead of forcing a rotation across live HubSpot workflows.
  MATERIAL_BANK_TOKEN?: string;

  // Minimum model confidence (0..1) required to WRITE a sub-type. Default 0.6.
  CLASSIFY_MIN_CONFIDENCE?: string;
  // Gemini model for sub-type classification. Default: gemini-2.5-flash.
  CLASSIFY_MODEL?: string;
  // Gemini model for the interior-designer project-focus classifier. Falls back to
  // CLASSIFY_MODEL / GEMINI_TEXT_MODEL / gemini-2.5-flash.
  PROJECT_FOCUS_MODEL?: string;
  // Confidence bar to mark a company Commercial (default 0.8) — higher than the base
  // threshold so commercial must be a real focus, not a passing mention.
  PROJECT_FOCUS_COMMERCIAL_MIN?: string;
  // Gemini model for the decorative-vs-functional product-focus classifier. Falls back
  // to CLASSIFY_MODEL / GEMINI_TEXT_MODEL / gemini-2.5-flash.
  PRODUCT_FOCUS_MODEL?: string;

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

  // --- Zendesk <-> HubSpot ticket mirror (zendeskSync.ts / quoteDesk.ts) ---
  // Zendesk API-token basic auth: base64("{email}/token:{api_token}") against
  // https://{subdomain}.zendesk.com. All three must be set or every Zendesk
  // call returns a clear "not configured" error (mirror + card stay closed).
  ZENDESK_SUBDOMAIN?: string;
  ZENDESK_EMAIL?: string;
  ZENDESK_API_TOKEN?: string;
  // Signing secret of the Zendesk webhook (Admin Center -> Webhooks -> reveal
  // secret). Verifies X-Zendesk-Webhook-Signature = base64(HMAC-SHA256(secret,
  // timestamp + raw body)) on POST /api/zendesk/webhook. Unset = endpoint closed.
  ZENDESK_WEBHOOK_SECRET?: string;
  // Client secret of the "wac-quote-desk" HubSpot developer-project app.
  // hubspot.fetch signs every card request with X-HubSpot-Signature-v3 using
  // this secret; the /api/quote-desk/* routes verify it (and only then trust
  // the server-appended userEmail query param as the submitting user). Unset =
  // card endpoints closed.
  QUOTE_DESK_CLIENT_SECRET?: string;
  // Gate for HubSpot writes in the Zendesk mirror (tickets / notes / contacts /
  // associations). When != "1" the sync computes matches, maintains the
  // Supabase mapping, and logs "[zendesk-sync] would ..." — dark launch while
  // the group->pipeline map and fake-email patterns are validated against real
  // traffic. Zendesk-side writes from the Quote Desk card are NOT gated (the
  // card replaces the make.com path 1:1).
  ZENDESK_SYNC_WRITE?: string;
  // JSON allowlist of the Zendesk groups that mirror to HubSpot, keyed by
  // group id: { "<groupId>": { "name": "Quotes", "pipelineId": "…",
  // "stages": { "new": "…", "open": "…", "pending": "…", "hold": "…",
  // "solved": "…", "closed": "…" } } }. Internal groups (IT/HR) are excluded
  // by omission. Unset = the whole mirror is off.
  ZD_SYNC_GROUPS?: string;
  // Zendesk mirror queue. The webhook/backfill/reconcile enqueue ticket ids;
  // the wac-zendesk-sync consumer (max_concurrency 1 -> serial, rate-limit
  // friendly on both APIs) processes them via zendeskSyncQueue.ts.
  ZENDESK_SYNC_QUEUE: Queue<ZendeskSyncMessage>;

  // Outermost ceiling (ms) the queue consumer waits on a shot3d (3D app-shot /
  // cam-solve) render before aborting. A Max-tier render can take well over an
  // hour on a CPU box, so this must sit ABOVE the generator→worker fetch cap
  // (RENDER_FINAL_TIMEOUT_MS) which in turn sits above the worker's Blender
  // hard-cap (RENDER_TIMEOUT_MS). Optional; defaults to 70 minutes.
  SHOT3D_CONTAINER_TIMEOUT_MS?: string;
}
