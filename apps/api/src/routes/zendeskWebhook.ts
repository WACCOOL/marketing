import { Hono } from "hono";
import type { AppBindings } from "../auth.js";
import { constantTimeEqual } from "./webhookAuth.js";
import { syncZendeskTicket } from "../zendeskSync.js";
import { runZendeskBackfill, runZendeskReconcile } from "../zendeskReconcile.js";

/**
 * Zendesk -> HubSpot mirror endpoints.
 *
 *   POST /api/zendesk/webhook       — Zendesk trigger webhook: verify HMAC,
 *                                     enqueue onto wac-zendesk-sync, ack fast
 *                                     (Zendesk times webhooks out at 12s).
 *   POST /api/zendesk/webhook/sync  — inline variant (testing / spot repair):
 *                                     processes the ticket and returns the outcome.
 *   POST /api/zendesk/backfill      — admin: sweep a group's tickets into the queue.
 *   POST /api/zendesk/reconcile     — admin: the nightly drift sweep, callable manually.
 *
 * Webhook auth is Zendesk's signing scheme: X-Zendesk-Webhook-Signature =
 * base64(HMAC-SHA256(signing secret, timestamp + raw body)). The admin routes
 * accept ADMIN_API_TOKEN (Bearer) like the other server-to-server endpoints.
 */
export const zendeskWebhookRoutes = new Hono<AppBindings>();

/** Exported for tests. */
export async function zendeskSignatureValid(
  secret: string,
  timestamp: string,
  rawBody: string,
  provided: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp + rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return constantTimeEqual(expected, provided);
}

/** Verify the Zendesk webhook signature over the raw body. Closed until configured. */
async function zendeskAuthorized(
  c: { req: { header: (n: string) => string | undefined }; env: AppBindings["Bindings"] },
  rawBody: string,
): Promise<boolean> {
  const secret = c.env.ZENDESK_WEBHOOK_SECRET;
  if (!secret) return false;
  const provided = c.req.header("x-zendesk-webhook-signature");
  const timestamp = c.req.header("x-zendesk-webhook-signature-timestamp");
  if (!provided || !timestamp) return false;
  return zendeskSignatureValid(secret, timestamp, rawBody, provided);
}

function adminAuthorized(c: {
  req: { header: (n: string) => string | undefined };
  env: AppBindings["Bindings"];
}): boolean {
  const expected = c.env.ADMIN_API_TOKEN;
  if (!expected) return false;
  const bearer = (c.req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  return !!bearer && constantTimeEqual(bearer, expected);
}

function ticketIdFrom(raw: string, queryId?: string): number | null {
  let body: Record<string, unknown> = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    /* signature already validated the sender; a mangled body just falls through */
  }
  const candidate = body.ticket_id ?? body.ticketId ?? queryId;
  const id = Number(candidate);
  return Number.isFinite(id) && id > 0 ? id : null;
}

zendeskWebhookRoutes.post("/webhook", async (c) => {
  const raw = await c.req.text();
  if (!(await zendeskAuthorized(c, raw))) return c.json({ error: "unauthorized" }, 401);
  const ticketId = ticketIdFrom(raw, c.req.query("ticketId"));
  if (!ticketId) return c.json({ error: "missing ticket_id" }, 400);
  await c.env.ZENDESK_SYNC_QUEUE.send({ ticketId });
  return c.json({ queued: true, ticketId });
});

/** Inline variant: sync now and return the full outcome (testing / spot repair). */
zendeskWebhookRoutes.post("/webhook/sync", async (c) => {
  const raw = await c.req.text();
  const authed = (await zendeskAuthorized(c, raw)) || adminAuthorized(c);
  if (!authed) return c.json({ error: "unauthorized" }, 401);
  const ticketId = ticketIdFrom(raw, c.req.query("ticketId"));
  if (!ticketId) return c.json({ error: "missing ticket_id" }, 400);
  const res = await syncZendeskTicket(c.env, ticketId, AbortSignal.timeout(60_000));
  return c.json(res);
});

/**
 * Sweep one group's tickets into the sync queue. ?group=<zendesk group id>
 * (must be allowlisted in ZD_SYNC_GROUPS), optional ?days=N to include
 * solved/closed tickets updated in the last N days (default: open-ish only).
 */
zendeskWebhookRoutes.post("/backfill", async (c) => {
  if (!adminAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const groupId = Number(c.req.query("group"));
  if (!Number.isFinite(groupId)) return c.json({ error: "missing ?group=<zendesk group id>" }, 400);
  const days = c.req.query("days") ? Number(c.req.query("days")) : undefined;
  const res = await runZendeskBackfill(c.env, groupId, days, AbortSignal.timeout(300_000));
  return c.json(res, res.error ? 500 : 200);
});

/** The nightly drift sweep, callable manually. */
zendeskWebhookRoutes.post("/reconcile", async (c) => {
  if (!adminAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const res = await runZendeskReconcile(c.env, AbortSignal.timeout(300_000));
  return c.json(res);
});
