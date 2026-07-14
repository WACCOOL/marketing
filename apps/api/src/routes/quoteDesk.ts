import { Hono } from "hono";
import { QUOTE_REQUEST_FIELDS, QUOTE_REQUEST_TYPE_SPECS } from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { constantTimeEqual } from "./webhookAuth.js";
import {
  createQuoteRequest,
  listDealContacts,
  listDealTickets,
  type QuoteRequestPayload,
} from "../quoteDesk.js";

/**
 * Quote Desk card endpoints (called via hubspot.fetch from the UI extension in
 * apps/quote-desk):
 *
 *   POST /api/quote-desk/requests          — submit a quote request
 *   GET  /api/quote-desk/tickets?dealId=   — the deal's mirrored tickets
 *   GET  /api/quote-desk/contacts?dealId=  — deal contacts (recipient picker)
 *
 * Auth: HubSpot signs every hubspot.fetch request with X-HubSpot-Signature-v3
 * (HMAC-SHA256 with the quote-desk app's client secret over method + uri +
 * body + timestamp) and appends userId/userEmail/portalId/appId query params
 * SERVER-SIDE — the extension bundle cannot forge them, so after the signature
 * verifies, the userEmail param IS the submitting user. Closed until
 * QUOTE_DESK_CLIENT_SECRET is configured.
 */
export const quoteDeskRoutes = new Hono<AppBindings>();

const HS_PORTAL_ID = "46455872";
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/**
 * HubSpot's v3 scheme hashes the uri with these URL-encoded characters decoded
 * (per the validating-requests doc) — the proxy normalizes them before signing.
 * Exported for tests.
 */
export function decodeHubspotUri(uri: string): string {
  const map: Record<string, string> = {
    "%3A": ":",
    "%2F": "/",
    "%3F": "?",
    "%40": "@",
    "%21": "!",
    "%24": "$",
    "%27": "'",
    "%28": "(",
    "%29": ")",
    "%2A": "*",
    "%2C": ",",
    "%3B": ";",
  };
  return uri.replace(/%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi, (m) => map[m.toUpperCase()] ?? m);
}

/** Exported for tests. */
export async function hubspotSignatureValid(
  c: { req: { header: (n: string) => string | undefined; method: string; url: string }; env: AppBindings["Bindings"] },
  rawBody: string,
): Promise<boolean> {
  const secret = c.env.QUOTE_DESK_CLIENT_SECRET;
  if (!secret) return false; // closed until configured
  const signature = c.req.header("x-hubspot-signature-v3");
  const timestamp = c.req.header("x-hubspot-request-timestamp");
  if (!signature || !timestamp) return false;
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || age > MAX_TIMESTAMP_SKEW_MS || age < -MAX_TIMESTAMP_SKEW_MS) return false;

  const base = c.req.method + decodeHubspotUri(c.req.url) + rawBody + timestamp;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return constantTimeEqual(expected, signature);
}

/**
 * The server-appended caller identity. Only meaningful AFTER the signature
 * check — these params are part of the signed URI, so they can't be forged.
 */
function callerFrom(c: {
  req: { query: (n: string) => string | undefined };
}): { email: string | null; portalOk: boolean } {
  const portalId = c.req.query("portalId");
  return {
    email: c.req.query("userEmail")?.trim().toLowerCase() || null,
    portalOk: !portalId || portalId === HS_PORTAL_ID,
  };
}

quoteDeskRoutes.post("/requests", async (c) => {
  const raw = await c.req.text();
  if (!(await hubspotSignatureValid(c, raw))) return c.json({ error: "unauthorized" }, 401);
  const caller = callerFrom(c);
  if (!caller.portalOk) return c.json({ error: "wrong portal" }, 401);
  if (!caller.email) return c.json({ error: "missing userEmail" }, 400);

  let body: Record<string, unknown> = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  const dealId = String(body.dealId ?? "").trim();
  const requestId = String(body.requestId ?? "").trim();
  if (!/^\d+$/.test(dealId)) return c.json({ error: "missing dealId" }, 400);
  if (!requestId) return c.json({ error: "missing requestId" }, 400);

  const payload: QuoteRequestPayload = {
    requestId,
    dealId,
    requestType: String(body.requestType ?? "new") as QuoteRequestPayload["requestType"],
    requesterEmail: caller.email,
    requesterName: typeof body.requesterName === "string" ? body.requesterName : undefined,
    recipientContactId:
      typeof body.recipientContactId === "string" ? body.recipientContactId : undefined,
    fields:
      body.fields && typeof body.fields === "object"
        ? Object.fromEntries(
            Object.entries(body.fields as Record<string, unknown>).map(([k, v]) => [
              k,
              v === null || v === undefined ? "" : String(v),
            ]),
          )
        : {},
  };

  const res = await createQuoteRequest(c.env, payload, AbortSignal.timeout(40_000));
  if (!res.ok) return c.json(res, res.status);
  return c.json(res);
});

quoteDeskRoutes.get("/tickets", async (c) => {
  if (!(await hubspotSignatureValid(c, ""))) return c.json({ error: "unauthorized" }, 401);
  const dealId = c.req.query("dealId")?.trim() ?? "";
  if (!/^\d+$/.test(dealId)) return c.json({ error: "missing dealId" }, 400);
  const tickets = await listDealTickets(c.env, dealId, AbortSignal.timeout(15_000));
  return c.json({ tickets });
});

/**
 * The field contract, served to the card so the required-vs-optional split has
 * exactly one source of truth (@wac/shared quoteDesk.ts) — the extension
 * bundle can't import workspace packages, so it fetches this on mount.
 */
quoteDeskRoutes.get("/spec", async (c) => {
  if (!(await hubspotSignatureValid(c, ""))) return c.json({ error: "unauthorized" }, 401);
  return c.json({ fields: QUOTE_REQUEST_FIELDS, types: QUOTE_REQUEST_TYPE_SPECS });
});

quoteDeskRoutes.get("/contacts", async (c) => {
  if (!(await hubspotSignatureValid(c, ""))) return c.json({ error: "unauthorized" }, 401);
  const dealId = c.req.query("dealId")?.trim() ?? "";
  if (!/^\d+$/.test(dealId)) return c.json({ error: "missing dealId" }, 400);
  const contacts = await listDealContacts(c.env, dealId, AbortSignal.timeout(15_000));
  return c.json({ contacts });
});
