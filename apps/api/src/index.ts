import { Hono } from "hono";
import { cors } from "hono/cors";
import { generatorFetch } from "./generatorClient.js";
import type { AppBindings } from "./auth.js";
import type { Env } from "./env.js";
import { utmRoutes } from "./routes/utm.js";
import { vocabRoutes } from "./routes/vocab.js";
import { thomRoutes } from "./routes/thom.js";
import { thomContentRoutes } from "./routes/thomContent.js";
import { thomDictionaryRoutes } from "./routes/thomDictionary.js";
import { shortLinkRoutes } from "./routes/shortlinks.js";
import { qrRoutes } from "./routes/qr.js";
import { socialRoutes } from "./routes/social.js";
import { bulkRoutes } from "./routes/bulk.js";
import { assetRoutes } from "./routes/assets.js";
import { meRoutes } from "./routes/me.js";
import { productRoutes } from "./routes/products.js";
import { jobRoutes } from "./routes/jobs.js";
import { uploadRoutes } from "./routes/uploads.js";
import { sceneRoutes } from "./routes/scenes.js";
import { cutoutRoutes } from "./routes/cutout.js";
import { appShotRoutes } from "./routes/appshot.js";
import { adminRoutes } from "./routes/admin.js";
import { productInfoRoutes } from "./routes/productinfo.js";
import { pptRoutes } from "./routes/ppt.js";
import { ingestRoutes } from "./routes/ingest.js";
import { hubspotSyncRoutes } from "./routes/hubspotSync.js";
import { repCodeRoutes } from "./routes/repCodes.js";
import { companyClassifyRoutes } from "./routes/companyClassify.js";
import { eventLeadRoutes } from "./routes/eventLeads.js";
import { projectFocusRoutes } from "./routes/projectFocus.js";
import { productFocusRoutes } from "./routes/productFocus.js";
import { showroomOrderRoutes } from "./routes/showroomOrders.js";
import { materialBankRoutes } from "./routes/materialBank.js";
import { quoteDeskRoutes } from "./routes/quoteDesk.js";
import { zendeskWebhookRoutes } from "./routes/zendeskWebhook.js";
import { runShowroomOrdersSync } from "./showroomOrders.js";
import { syncNationalAccountDomains } from "./nationalAccounts.js";
import { makeProductAdapter } from "./saleslayer.js";
import { serviceSupabase } from "./supabase.js";
import { updateJobStatus, type GenerationMessage } from "./generation.js";
import { handleIngestBatch } from "./ingestQueue.js";
import { handleEventLeadBatch } from "./eventLeadQueue.js";
import { handleZendeskSyncBatch, type ZendeskSyncMessage } from "./zendeskSyncQueue.js";
import { handleThomIngestBatch, type ThomIngestMessage } from "./thomIngest.js";
import { runZendeskReconcile, runThomTicketSweep } from "./zendeskReconcile.js";
import type { IngestMessage } from "./ingest.js";
import type { EventLeadBody } from "./eventLead.js";
import { runGraphPull } from "./graphPull.js";
import { runHubspotHeartbeat } from "./alerts.js";
import { refreshHubspotOptions, refreshStageProbabilities } from "./hubspotPush.js";
import { GenerationContainer } from "./container.js";

const app = new Hono<AppBindings>();

app.use(
  "/api/*",
  cors({
    origin: (origin) => origin ?? "*",
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["authorization", "content-type"],
    maxAge: 600,
  }),
);

// Surface uncaught errors with the actual message + stack so the SPA (and the
// dev console) can show us what went wrong instead of a bare 500.
app.onError((err, c) => {
  const url = new URL(c.req.url);
  console.error(`[api] ${c.req.method} ${url.pathname} failed:`, err);
  return c.json(
    {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    },
    500,
  );
});

app.get("/api/_health", (c) => c.json({ ok: true }));

// Per-user feature (menu-tab) access is enforced inside the relevant route
// files via requireFeature() group/route middleware (see @wac/shared features):
//   utm → utm/qr/short-links/social/bulk · image → scenes/cutout ·
//   ppt → ppt (+ ppt-templates for template mgmt) · product → product-info ·
//   data → ingest/hubspot-sync (+ pricing for the manual pricing source) ·
//   utm-vocab → vocab source/medium.
// Shared utility groups are intentionally NOT feature-gated to avoid cross-tab
// breakage: jobs/uploads (generic generation pipeline used by image + ppt),
// assets (cross-tool library), appshot (carries the fixture-sync admin token),
// and the products catalog read. The web nav/route guards hide those tabs; the
// Admin page stays admin-only.
app.route("/api/me", meRoutes);
app.route("/api/utm", utmRoutes);
app.route("/api/vocab", vocabRoutes);
app.route("/api/thom", thomRoutes);
app.route("/api/thom-content", thomContentRoutes);
app.route("/api/thom-dictionary", thomDictionaryRoutes);
app.route("/api/short-links", shortLinkRoutes);
app.route("/api/qr", qrRoutes);
app.route("/api/social", socialRoutes);
app.route("/api/bulk", bulkRoutes);
app.route("/api/assets", assetRoutes);
app.route("/api/products", productRoutes);
app.route("/api/jobs", jobRoutes);
app.route("/api/uploads", uploadRoutes);
app.route("/api/scenes", sceneRoutes);
app.route("/api/cutout", cutoutRoutes);
app.route("/api/appshot", appShotRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/product-info", productInfoRoutes);
app.route("/api/ppt", pptRoutes);
app.route("/api/ingest", ingestRoutes);
app.route("/api/hubspot-sync", hubspotSyncRoutes);
app.route("/api/hubspot", companyClassifyRoutes);
app.route("/api/hubspot", eventLeadRoutes);
app.route("/api/hubspot", projectFocusRoutes);
app.route("/api/hubspot", productFocusRoutes);
app.route("/api/hubspot", showroomOrderRoutes);
app.route("/api/hubspot", materialBankRoutes);
app.route("/api/rep-codes", repCodeRoutes);
app.route("/api/quote-desk", quoteDeskRoutes);
app.route("/api/zendesk", zendeskWebhookRoutes);

// Anything not handled by a /api/* route falls through to the SPA assets
// (configured in wrangler.jsonc with not_found_handling: single-page-application).
app.all("*", async (c) => c.env.ASSETS.fetch(c.req.raw));

/**
 * Cron entrypoint (schedules in wrangler.jsonc). Schedules:
 *   - daily 07:00 UTC — Sales Layer product cache refresh
 *   - every 30 minutes — marketing-data Graph pull (Territory + Open Orders)
 *   - hourly — SAP -> HubSpot sync heartbeat (alert if the feed goes quiet)
 *   - daily 05:00 UTC — refresh cached HubSpot dropdown options (self-heal)
 *   - weekly Mon 06:30 UTC — recompute deal-stage probabilities (weighted pipeline)
 *   - every 30 minutes at :15/:45 — showroom PO orders sheets -> HubSpot deals
 *     (staggered off the :00/:30 Graph pull; gated on SHOWROOM_SYNC_ENABLED)
 *   - daily 08:45 UTC — Zendesk mirror reconcile (re-enqueue tickets updated
 *     in the last 48h; the net under webhook outages / circuit breaking), plus
 *     the Thom KB internal-ticket sweep (dark-launched behind THOM_ZENDESK_TICKETS)
 * Each branch is best-effort and logs rather than throwing so one blip doesn't
 * fail the invocation.
 */
async function scheduled(event: ScheduledController, env: Env): Promise<void> {
  if (event.cron === "0 7 * * *") {
    await runProductSync(env);
  }
  if (event.cron === "*/30 * * * *") {
    await runGraphPull(env);
  }
  if (event.cron === "0 * * * *") {
    await runHubspotHeartbeat(env);
  }
  if (event.cron === "0 5 * * *") {
    await refreshHubspotOptions(env, serviceSupabase(env));
    // Refresh the national-account domain mirror (fail-soft; national accounts
    // change rarely, so daily is plenty). Drives the lead-ownership Sara override.
    try {
      const r = await syncNationalAccountDomains(env, AbortSignal.timeout(120_000));
      console.log(`[cron] national-account domains: ${r.domains} domains, pruned ${r.pruned}`);
    } catch (e) {
      console.error("[cron] national-account domain sync failed", e);
    }
  }
  if (event.cron === "30 6 * * 1") {
    await refreshStageProbabilities(env);
  }
  if (event.cron === "15,45 * * * *") {
    if (env.SHOWROOM_SYNC_ENABLED !== "1" || !env.GOOGLE_SA_KEY || !env.HUBSPOT_TOKEN) return;
    try {
      await runShowroomOrdersSync(env, {}, AbortSignal.timeout(300_000));
    } catch (e) {
      console.error("[cron] showroom-orders sync failed", e);
    }
  }
  if (event.cron === "45 8 * * *") {
    try {
      await runZendeskReconcile(env, AbortSignal.timeout(300_000));
    } catch (e) {
      console.error("[cron] zendesk reconcile failed", e);
    }
    // Thom KB internal-ticket sweep (dark-launched behind THOM_ZENDESK_TICKETS):
    // catch webhook misses for ticket ingestion. Separate try so a failure here
    // never masks the mirror reconcile above.
    try {
      await runThomTicketSweep(env, AbortSignal.timeout(300_000));
    } catch (e) {
      console.error("[cron] thom ticket sweep failed", e);
    }
  }
}

async function runProductSync(env: Env): Promise<void> {
  const secret = env.SALES_LAYER_SECRET_KEY || env.SALES_LAYER_API_KEY;
  if (!env.SALES_LAYER_CONNECTOR_ID || !secret) {
    console.warn("[cron] Sales Layer credentials unset; skipping product sync");
    return;
  }
  try {
    const result = await makeProductAdapter(env).sync();
    console.log(
      `[cron] product sync: upserted ${result.upserted}, variants ${result.variants}, pruned ${result.pruned}`,
    );
  } catch (e) {
    console.error("[cron] product sync failed", e);
  }
}

/**
 * Generation queue consumer (Phase 2b). Orchestration only: route each job to a
 * generation Container instance and POST the payload to its HTTP handler. The
 * Container performs the running/succeeded/failed transitions and asset creation
 * itself. We only finalize a `failed` status here when the container is
 * unreachable/erroring after the queue's retries are exhausted.
 *
 * Container routing uses a small fixed POOL of stable keys (not the unique
 * jobId). Keying by jobId gave every job its own brand-new instance, so each
 * generation paid a full container cold start (10-30s). A small pool keeps a few
 * instances warm and reused while still allowing concurrent jobs to land on
 * different instances. See containerPool.ts (shared with the scenes routes).
 */
// 2d: hybrid/concept jobs add sequential AI calls (BFL Fill ~10-30s + an optional
// near-instant Gemini pass) on top of the 2c CDN fetch + sharp composite. The
// adapters enforce tighter per-provider timeouts (60s BFL / 30s Gemini) so a
// stuck provider surfaces an actionable error; this is the outer ceiling.
const CONTAINER_TIMEOUT_MS = 150_000;
// 3D app-shot (shot3d) finals run Blender Cycles over a full-quality layered
// export, which at the High/Max quality tiers (refractive caustics + high
// samples + hi-res) can take well over an hour on a CPU box. This is the
// outermost server ceiling, so it sits ABOVE the generator→worker fetch
// (RENDER_FINAL_TIMEOUT_MS) and the worker's Blender hard-cap (RENDER_TIMEOUT_MS)
// — letting their cleaner errors surface first — while still outlasting a
// legitimate hero render. Env-overridable via SHOT3D_CONTAINER_TIMEOUT_MS.
const SHOT3D_CONTAINER_TIMEOUT_MS_DEFAULT = 4_200_000;

async function queue(
  batch: MessageBatch<
    GenerationMessage | IngestMessage | EventLeadBody | ZendeskSyncMessage | ThomIngestMessage
  >,
  env: Env,
): Promise<void> {
  // Marketing data ingestion runs on its own queue with independent retry/DLQ
  // policy — dispatch by queue name so the generation path below is untouched.
  if (batch.queue === "wac-ingest") {
    await handleIngestBatch(batch as MessageBatch<IngestMessage>, env);
    return;
  }
  if (batch.queue === "wac-event-leads") {
    await handleEventLeadBatch(batch as MessageBatch<EventLeadBody>, env);
    return;
  }
  if (batch.queue === "wac-zendesk-sync") {
    await handleZendeskSyncBatch(batch as MessageBatch<ZendeskSyncMessage>, env);
    return;
  }
  if (batch.queue === "wac-thom-ingest") {
    await handleThomIngestBatch(batch as MessageBatch<ThomIngestMessage>, env);
    return;
  }

  const generationBatch = batch as MessageBatch<GenerationMessage>;
  for (const message of generationBatch.messages) {
    const job = message.body;
    const isShot3d =
      (job.params as { mode?: string } | undefined)?.mode === "shot3d";
    try {
      const timeoutMs = isShot3d
        ? Number(
            env.SHOT3D_CONTAINER_TIMEOUT_MS ??
              SHOT3D_CONTAINER_TIMEOUT_MS_DEFAULT,
          )
        : CONTAINER_TIMEOUT_MS;
      const res = await generatorFetch(env, job.jobId, "/generate", {
        method: "POST",
        body: JSON.stringify(job),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`container responded ${res.status}: ${await res.text()}`);
      }
      message.ack();
    } catch (e) {
      const errMessage = e instanceof Error ? e.message : String(e);
      console.error(
        `[queue] job ${job.jobId} attempt ${message.attempts} failed:`,
        errMessage,
      );
      // shot3d (3D app-shot / cam-solve) renders are expensive, deterministic,
      // and run one-at-a-time on the single-threaded render-worker. Retrying only
      // re-runs the whole render and double-books the worker behind the original
      // (which manifests as a cascading "fetch failed"), wasting time without
      // improving the odds. So a shot3d failure is terminal: mark failed + ack,
      // no retry. Cheap composite/hybrid jobs keep the normal retry budget.
      // FUTURE (email on completion — deferred): this is the "render failed"
      // hook that pairs with the success hook in the generator's markSucceeded
      // (apps/generator/src/server.ts). When email is added, send a best-effort
      // "render failed" notice to the job owner from here.
      if (isShot3d || message.attempts >= 3) {
        try {
          await updateJobStatus(serviceSupabase(env), job.jobId, {
            status: "failed",
            error: errMessage,
            attempts: message.attempts,
            finished_at: new Date().toISOString(),
          });
        } catch (updateErr) {
          console.error(
            `[queue] failed to finalize job ${job.jobId}:`,
            updateErr,
          );
        }
        message.ack();
      } else {
        message.retry();
      }
    }
  }
}

export { GenerationContainer };
export default { fetch: app.fetch, scheduled, queue };
