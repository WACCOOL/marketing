import type { GenerationMessage } from "./generation.js";
import type { GenerationContainer } from "./container.js";
import type { IngestMessage } from "./ingest.js";
import type { EventLeadBody } from "./eventLead.js";
import type { ZendeskSyncMessage } from "./zendeskSyncQueue.js";
import type { ThomIngestMessage } from "./thomIngest.js";

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
  // Optional override for the Sales Layer VARIANT field carrying plant status
  // (feeds the Retired / Limited-Availability rules). Not yet in the export; set
  // this to its field name once the connector adds it. Unset => auto-scan known
  // candidates (all currently absent, so plant_status stays null).
  SALES_LAYER_PLANT_STATUS_FIELD?: string;
  // Thom Bot — comma-separated override of the Sales Layer file fields that
  // hold spec-sheet / manual PDFs. Defaults to the confirmed live-connector
  // fields "specsheet_pdf,inst_sheet"; set this to add more (e.g. ftc_label_pdf)
  // without a code change. See docs/thom-bot-deferred-sources.
  SALES_LAYER_DOC_FIELDS?: string;
  // Thom Bot — dark-launch flag for Sales Layer doc capture (writes kb_documents
  // + product_documents during the product sync). Unset/"0" = discover + log
  // coverage only, no writes; "1" = capture. Kept off until the ingest pipeline
  // (apps/docs-ingest) is ready to extract the pending_extract rows.
  THOM_DOC_CAPTURE?: string;
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
  /** Shared secret for the public Thom worker's turn-logging bridge. */
  THOM_LOG_TOKEN?: string;
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

  // --- Thom Bot (chat assistant) ---
  // Anthropic API key for the Thom chat brain (Claude). Optional so the Worker
  // boots without it — chat routes return a clear "not configured" error, the
  // same posture as GEMINI_API_KEY. Set via `wrangler secret put ANTHROPIC_API_KEY`.
  ANTHROPIC_API_KEY?: string;
  // Model overrides. Router/default model handles routing + simple lookups
  // (a Haiku-class id); the escalation model handles multi-doc synthesis
  // (a Sonnet-class id). Defaults live in anthropic.ts.
  ANTHROPIC_ROUTER_MODEL?: string;
  ANTHROPIC_MODEL?: string;
  // Model tiering kill-switch. Unset/"1" = escalate hard questions (multi-doc
  // synthesis, multi-product comparisons, long tool chains) from the router
  // model up to ANTHROPIC_MODEL; "0" = router-only (today's behavior, a safe
  // rollback). Reuses ANTHROPIC_MODEL — no new model id needed.
  THOM_TIERING?: string;
  // Thom web_search gate (INTERNAL-ONLY, dark-launched). Anthropic's native
  // server-side web_search runs as a LAST RESORT for things the catalog /
  // spec-sheets can't answer (competitor specs, obscure codes). OFF by default
  // — every search is billed per-use, so this dark-launches like THOM_DOC_CAPTURE:
  // unset/"0" = disabled (no server tool sent); "1" = enabled. Enforced in CODE
  // (buildWebSearchTools returns [] when off), not just the prompt.
  THOM_WEB_SEARCH?: string;
  // Hard cap on web_search calls per turn (Anthropic max_uses). Parsed as an
  // int, default 3, clamped to 1–5 so a bad value can't uncork billing.
  THOM_WEB_SEARCH_MAX_USES?: string;
  // Thom photometrics gate (dark-launched, mirrors THOM_WEB_SEARCH). Unset/"0" =
  // the get_photometrics + lighting_requirement tools are NOT offered to the
  // model; "1" = composed onto the internal tool set. Enforced in CODE
  // (photometricsEnabled in agent.ts), not just the prompt. Metrics are
  // precomputed out-of-band by apps/photometrics-sync.
  THOM_PHOTOMETRICS?: string;
  // Thom layout tool gate (dark-launched, mirrors THOM_PHOTOMETRICS). Unset/"0"
  // = the plan_layout tool is NOT offered to the model; "1" = composed onto the
  // internal tool set. Enforced in CODE (layoutEnabled in agent.ts), not just
  // the prompt. Needs product_photometrics populated (head IES/lumens) and, for
  // track BOMs, the track_systems/track_components seed (migrations 0049/0050).
  THOM_LAYOUT?: string;
  // Thom dimming-compatibility tool gate (dark-launched, mirrors
  // THOM_SPEC_FILTER; dimming plan §D). Unset/"0" = check_dimmer_compatibility
  // + find_products_for_dimmer are NOT offered and the compatibility prompt
  // keeps its search_docs dimmer bullet; "1" = both tools composed + the
  // dimming-chart bullets (incl. the DC3 competitor carve-out) emitted.
  // Needs migration 0067 + the gated `--dimming` extraction run for data.
  THOM_DIMMING?: string;
  // Thom Bot — dark-launch flag for ZenDesk Help Center ARTICLE capture in the
  // docs-ingest CLI (apps/docs-ingest). Unset/"0" = no article capture; "1" =
  // list published articles and fold them into kb_documents/kb_chunks so Thom's
  // search_docs can cite support articles. Reuses the ZENDESK_* creds above.
  // (Consumed by the Node CLI via process.env; declared here so the Thom env
  // surface is documented in one place.)
  THOM_ZENDESK_ARTICLES?: string;
  // JSON map of ZenDesk Help Center section_id / category_id -> brand string
  // ("WAC Lighting" | "Modern Forms" | "Schonbek" | "AiSpire"), e.g.
  // { "360001": "WAC Lighting" }. Drives kb_documents.brand for captured
  // articles; a label matching a brand name is the fallback. Unset = brand null.
  ZENDESK_HC_BRAND_MAP?: string;
  // Help Center locale to ingest (default "en-us"). Consumed by the docs-ingest CLI.
  ZENDESK_HC_LOCALE?: string;
  // Thom Bot — dark-launch flag for ZenDesk INTERNAL-TICKET capture. Unset/"0" =
  // no ticket capture (no piggyback enqueue, no reconcile sweep, consumer drops
  // ticket messages); "1" = capture eligible tickets as INTERNAL-scope pointer
  // rows (NO body in kb_documents; the redacted body lands as kb_chunks via the
  // docs-ingest extraction pass). Enforced in CODE at every seam, not just docs.
  THOM_ZENDESK_TICKETS?: string;
  // KB allowlist of ZenDesk group ids whose INTERNAL tickets feed Thom's KB —
  // JSON array ([123,456]) or CSV ("123,456"). DELIBERATELY SEPARATE from
  // ZD_SYNC_GROUPS: which groups' tickets are knowledge is a different decision
  // from which groups mirror to HubSpot. Unset/empty = capture off.
  THOM_TICKET_GROUPS?: string;
  // READ-ONLY HubSpot private-app token for Thom's internal CRM tools (deals /
  // companies / orders / rep codes). DELIBERATELY a separate app from
  // HUBSPOT_TOKEN: Thom ingests untrusted text (tickets, web results), so the
  // bot's credential must be INCAPABLE of writes no matter what a bug or an
  // injected instruction asks for. Never hand HUBSPOT_TOKEN to the bot.
  HUBSPOT_READ_TOKEN?: string;
  // Thom category-sales tool gate (dark-launched, mirrors THOM_PHOTOMETRICS;
  // category-sales plan v2 / migration 0065). Unset/"0" = crm_sales_by_category
  // is NOT offered and the CRM guidance's sales bullets are NOT composed (CS6 —
  // tool and guidance flip together, atomically); "1" = both appear on the
  // INTERNAL surface. Enabling is a committed `vars` edit in apps/api
  // wrangler.jsonc ONLY — no apps/thom-bot (public) edit exists for this flag.
  // Apply migration 0065 + run its G.1 gate BEFORE flipping this on.
  THOM_CATEGORY_SALES?: string;
  // Workers AI — bge-m3 embeddings (1024-dim) for KB + product hybrid search.
  // Used at query time (embed the question) and by the ingest pipeline.
  AI: Ai;
  // Thom knowledge-ingestion queue (Tier A). Syncs enqueue discovered docs;
  // the wac-thom-ingest consumer (thomIngest.ts) fetches/hashes/stores them
  // as kb_documents pending_extract. Heavy parsing lives in apps/docs-ingest.
  THOM_INGEST_QUEUE: Queue<ThomIngestMessage>;

  // Outermost ceiling (ms) the queue consumer waits on a shot3d (3D app-shot /
  // cam-solve) render before aborting. A Max-tier render can take well over an
  // hour on a CPU box, so this must sit ABOVE the generator→worker fetch cap
  // (RENDER_FINAL_TIMEOUT_MS) which in turn sits above the worker's Blender
  // hard-cap (RENDER_TIMEOUT_MS). Optional; defaults to 70 minutes.
  SHOT3D_CONTAINER_TIMEOUT_MS?: string;
}
