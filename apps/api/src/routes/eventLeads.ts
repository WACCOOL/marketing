import { Hono } from "hono";
import type { AppBindings } from "../auth.js";
import { processEventLead, type EventLeadBody } from "../eventLead.js";
import { syncNationalAccountDomains } from "../nationalAccounts.js";

/**
 * Marketing-event lead-ownership webhook + the national-account domain sync.
 *
 *   POST /api/hubspot/event-lead         — webhook: ack fast, process in background
 *   POST /api/hubspot/event-lead/sync    — inline (testing / backfill): returns the outcome
 *   POST /api/hubspot/sync-national-domains — refresh the national-account domain mirror
 *
 * A HubSpot custom-code workflow action (event attendance) posts the enrolled
 * contact id plus the campaign's id/name/brand/channel. Secured by the shared
 * REP_LOOKUP_TOKEN (Bearer / x-api-key / ?key=), like the other HubSpot webhooks.
 */
export const eventLeadRoutes = new Hono<AppBindings>();

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
  if (!expected) return false;
  const bearer = (c.req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  const provided = bearer ?? c.req.header("x-api-key") ?? c.req.query("key");
  return !!provided && constantTimeEqual(provided, expected);
}

function contactIdFrom(body: Record<string, unknown>, queryId?: string): string | null {
  const raw =
    body.objectId ?? body.contactId ?? body.hs_object_id ?? body.vid ?? body.id ?? queryId ?? null;
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return /^\d+$/.test(s) ? s : null;
}

/** Build the orchestrator payload from a webhook/request body. */
function bodyToPayload(body: Record<string, unknown>, contactId: string): EventLeadBody {
  const str = (v: unknown): string | undefined => {
    if (v === null || v === undefined) return undefined;
    const s = String(v).trim();
    return s || undefined;
  };
  return {
    contactId,
    campaignId: str(body.campaignId ?? body.campaign_id),
    campaignName: str(body.campaignName ?? body.campaign_name),
    campaignBrand: str(body.campaignBrand ?? body.campaign_brand ?? body.brand),
    campaignChannel: str(body.campaignChannel ?? body.campaign_channel ?? body.channel),
    dryRun: body.dryRun === true || body.dryRun === "true" || body.dry_run === true,
  };
}

/** Webhook: ack immediately, resolve ownership + create the Lead in the background. */
eventLeadRoutes.post("/event-lead", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const contactId = contactIdFrom(body, c.req.query("contactId"));
  if (!contactId) return c.json({ error: "missing contact id" }, 400);

  c.executionCtx.waitUntil(
    processEventLead(c.env, bodyToPayload(body, contactId), AbortSignal.timeout(40_000)).catch((e) =>
      console.error(`[event-lead] ${contactId} failed:`, e),
    ),
  );
  return c.json({ accepted: true, contactId });
});

/** Inline variant: process and return the full outcome (testing / backfill). */
eventLeadRoutes.post("/event-lead/sync", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const contactId = contactIdFrom(body, c.req.query("contactId"));
  if (!contactId) return c.json({ error: "missing contact id" }, 400);

  const res = await processEventLead(c.env, bodyToPayload(body, contactId), AbortSignal.timeout(45_000));
  return c.json(res);
});

/** Refresh the national-account domain mirror from HubSpot (manual / cron). */
eventLeadRoutes.post("/sync-national-domains", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const res = await syncNationalAccountDomains(c.env, AbortSignal.timeout(120_000));
  return c.json(res);
});
