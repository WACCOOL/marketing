import { Hono } from "hono";
import type { AppBindings } from "../auth.js";
import { serviceSupabase } from "../supabase.js";
import { classifyProjectFocus, type ProjectFocusSource } from "../projectFocus.js";
import { webhookAuthorized } from "./webhookAuth.js";

/**
 * Interior-designer project-focus (residential vs commercial) auto-classification,
 * called by a HubSpot workflow webhook.
 *
 *   POST /api/hubspot/classify-project-focus        ack fast, classify in waitUntil (webhook)
 *   POST /api/hubspot/classify-project-focus/sync    classify inline, return outcome (backfill/testing)
 *
 * Secured by the shared HubSpot-workflow token (REP_LOOKUP_TOKEN). The "Send a
 * webhook" / custom-code action delivers the enrolled company's id as `objectId`.
 */
export const projectFocusRoutes = new Hono<AppBindings>();

const authorized = webhookAuthorized;

function companyIdFrom(body: Record<string, unknown>, queryId?: string): string | null {
  const raw = body.objectId ?? body.companyId ?? body.hs_object_id ?? body.vid ?? body.id ?? queryId ?? null;
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return /^\d+$/.test(s) ? s : null;
}

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
}

/** Webhook path: ack immediately, classify in the background. */
projectFocusRoutes.post("/classify-project-focus", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await readBody(c);
  const companyId = companyIdFrom(body, c.req.query("companyId"));
  if (!companyId) return c.json({ error: "missing company id" }, 400);

  c.executionCtx.waitUntil(
    classifyProjectFocus(c.env, serviceSupabase(c.env), {
      companyId,
      source: "webhook",
      signal: AbortSignal.timeout(40_000),
      write: true,
      scrapeWebsite: true,
    }).catch((e) => console.error(`[project-focus] webhook ${companyId} failed:`, e)),
  );

  return c.json({ accepted: true, companyId });
});

/** Sync path: classify inline and return the outcome (used by the backfill). */
projectFocusRoutes.post("/classify-project-focus/sync", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await readBody(c);
  const companyId = companyIdFrom(body, c.req.query("companyId"));
  if (!companyId) return c.json({ error: "missing company id" }, 400);

  const write = body.write !== false && c.req.query("write") !== "false";
  const scrapeWebsite = body.scrapeWebsite !== false;
  const properties =
    body.properties && typeof body.properties === "object"
      ? (body.properties as Record<string, unknown>)
      : undefined;
  const source: ProjectFocusSource = body.source === "manual" ? "manual" : "backfill";

  const res = await classifyProjectFocus(c.env, serviceSupabase(c.env), {
    companyId,
    source,
    signal: AbortSignal.timeout(45_000),
    write,
    scrapeWebsite,
    properties,
  });
  return c.json(res);
});
