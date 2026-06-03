import { Hono } from "hono";
import { cors } from "hono/cors";
import { getContainer } from "@cloudflare/containers";
import type { AppBindings } from "./auth.js";
import type { Env } from "./env.js";
import { utmRoutes } from "./routes/utm.js";
import { vocabRoutes } from "./routes/vocab.js";
import { shortLinkRoutes } from "./routes/shortlinks.js";
import { qrRoutes } from "./routes/qr.js";
import { socialRoutes } from "./routes/social.js";
import { bulkRoutes } from "./routes/bulk.js";
import { assetRoutes } from "./routes/assets.js";
import { meRoutes } from "./routes/me.js";
import { productRoutes } from "./routes/products.js";
import { jobRoutes } from "./routes/jobs.js";
import { makeProductAdapter } from "./saleslayer.js";
import { serviceSupabase } from "./supabase.js";
import { updateJobStatus, type GenerationMessage } from "./generation.js";
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

app.route("/api/me", meRoutes);
app.route("/api/utm", utmRoutes);
app.route("/api/vocab", vocabRoutes);
app.route("/api/short-links", shortLinkRoutes);
app.route("/api/qr", qrRoutes);
app.route("/api/social", socialRoutes);
app.route("/api/bulk", bulkRoutes);
app.route("/api/assets", assetRoutes);
app.route("/api/products", productRoutes);
app.route("/api/jobs", jobRoutes);

// Anything not handled by a /api/* route falls through to the SPA assets
// (configured in wrangler.jsonc with not_found_handling: single-page-application).
app.all("*", async (c) => c.env.ASSETS.fetch(c.req.raw));

/**
 * Daily Sales Layer product cache refresh (cron configured in wrangler.jsonc).
 * Errors are logged but never thrown out of the handler so a Sales Layer blip
 * doesn't fail the scheduled invocation.
 */
async function scheduled(_event: ScheduledController, env: Env): Promise<void> {
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
 * generation Container instance (keyed by jobId) and POST the payload to its
 * HTTP handler. The Container performs the running/succeeded/failed transitions
 * and asset creation itself. We only finalize a `failed` status here when the
 * container is unreachable/erroring after the queue's retries are exhausted.
 */
const CONTAINER_TIMEOUT_MS = 30_000;

async function queue(
  batch: MessageBatch<GenerationMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    try {
      const container = getContainer(env.GENERATION_CONTAINER, job.jobId);
      const res = await container.fetch(
        new Request("http://generation-container/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(job),
          signal: AbortSignal.timeout(CONTAINER_TIMEOUT_MS),
        }),
      );
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
      // `attempts` counts deliveries including this one; once we've used up the
      // configured retries, finalize the job as failed so the poller terminates.
      if (message.attempts >= 3) {
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
