import { Hono } from "hono";
import type { AppBindings } from "../auth.js";
import { processEventLead, type EventLeadBody } from "../eventLead.js";
import { syncNationalAccountDomains } from "../nationalAccounts.js";
import { webhookAuthorized } from "./webhookAuth.js";

/**
 * Marketing-event lead-ownership webhook + the national-account domain sync.
 *
 *   POST /api/hubspot/event-lead         — webhook: enqueue onto wac-event-leads, ack
 *   POST /api/hubspot/event-lead/sync    — inline (testing / backfill): returns the outcome
 *   POST /api/hubspot/sync-national-domains — refresh the national-account domain mirror
 *
 * A HubSpot custom-code workflow action (event attendance) posts the enrolled
 * contact id plus the campaign's id/name/brand/channel. Secured by the shared
 * REP_LOOKUP_TOKEN (Bearer / x-api-key / ?key=), like the other HubSpot webhooks.
 */
export const eventLeadRoutes = new Hono<AppBindings>();

const authorized = webhookAuthorized;

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

/**
 * Webhook: enqueue and ack. Processing happens on the wac-event-leads queue —
 * SERIAL (max_concurrency 1) with retries — so a whole-list enrollment (hundreds of
 * near-simultaneous calls) drains at a pace HubSpot's API rate limit can absorb,
 * instead of parallel invocations starving each other into timeouts (2026-07-02
 * Lightovation: 217 enrollments → only 62 leads).
 */
eventLeadRoutes.post("/event-lead", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const contactId = contactIdFrom(body, c.req.query("contactId"));
  if (!contactId) return c.json({ error: "missing contact id" }, 400);

  const payload = bodyToPayload(body, contactId);
  if (payload.dryRun) {
    // Dry runs answer inline — nothing to queue, no writes happen.
    const res = await processEventLead(c.env, payload, AbortSignal.timeout(45_000));
    return c.json(res);
  }
  await c.env.EVENT_LEAD_QUEUE.send(payload);
  return c.json({ queued: true, contactId });
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
