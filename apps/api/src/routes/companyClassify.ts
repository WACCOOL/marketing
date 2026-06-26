import { Hono } from "hono";
import type { AppBindings } from "../auth.js";
import { serviceSupabase } from "../supabase.js";
import { classifySubType, type ClassifySource } from "../companyClassify.js";

export const companyClassifyRoutes = new Hono<AppBindings>();

/**
 * Company sub-type auto-classification, called by a HubSpot workflow webhook.
 *
 *   POST /api/hubspot/classify-company        ack fast, classify in waitUntil (webhook)
 *   POST /api/hubspot/classify-company/sync    classify inline, return outcome (backfill/testing)
 *
 * Secured by the shared HubSpot-workflow token (REP_LOOKUP_TOKEN — reused from
 * the rep-codes lookup) presented as `Authorization: Bearer <token>`,
 * `x-api-key: <token>`, or `?key=<token>`. The HubSpot "Send a webhook" action
 * delivers the enrolled company's id as `objectId`.
 */

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(c: {
  req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined };
  env: AppBindings["Bindings"];
}): boolean {
  const expected = c.env.REP_LOOKUP_TOKEN;
  if (!expected) return false; // closed until configured
  const bearer = (c.req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  const provided = bearer ?? c.req.header("x-api-key") ?? c.req.query("key");
  return !!provided && constantTimeEqual(provided, expected);
}

/** Pull the HubSpot company record id out of a webhook / request body. */
function companyIdFrom(body: Record<string, unknown>, queryId?: string): string | null {
  const raw =
    body.objectId ??
    body.companyId ??
    body.hs_object_id ??
    body.vid ??
    body.id ??
    queryId ??
    null;
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return /^\d+$/.test(s) ? s : null;
}

async function readBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
}

/** Webhook path: ack immediately, classify in the background. */
companyClassifyRoutes.post("/classify-company", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await readBody(c);
  const companyId = companyIdFrom(body, c.req.query("companyId"));
  if (!companyId) return c.json({ error: "missing company id" }, 400);

  c.executionCtx.waitUntil(
    classifySubType(c.env, serviceSupabase(c.env), {
      companyId,
      source: "webhook",
      signal: AbortSignal.timeout(40_000),
      write: true,
      scrapeWebsite: true,
    }).catch((e) => console.error(`[classify] webhook ${companyId} failed:`, e)),
  );

  return c.json({ accepted: true, companyId });
});

/** Sync path: classify inline and return the outcome (used by the backfill CLI). */
companyClassifyRoutes.post("/classify-company/sync", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await readBody(c);
  const companyId = companyIdFrom(body, c.req.query("companyId"));
  if (!companyId) return c.json({ error: "missing company id" }, 400);

  const write = body.write !== false && c.req.query("write") !== "false";
  // Fallback scrape on by default (only the low-confidence ~30% actually fetch a
  // site); pass scrapeWebsite:false to force a pure fields-only run.
  const scrapeWebsite = body.scrapeWebsite !== false;
  const properties =
    body.properties && typeof body.properties === "object"
      ? (body.properties as Record<string, unknown>)
      : undefined;
  const source: ClassifySource = body.source === "manual" ? "manual" : "backfill";

  const res = await classifySubType(c.env, serviceSupabase(c.env), {
    companyId,
    source,
    signal: AbortSignal.timeout(45_000),
    write,
    scrapeWebsite,
    properties,
  });
  return c.json(res);
});
