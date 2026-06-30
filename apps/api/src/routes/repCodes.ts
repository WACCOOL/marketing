import { Hono } from "hono";
import { normalizeZip, buildContactRepCodeProps } from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { serviceSupabase } from "../supabase.js";
import { hs, PATHS } from "../hubspotPush.js";

export const repCodeRoutes = new Hono<AppBindings>();

/**
 * Zip -> rep codes lookup for HubSpot workflows (Send-a-webhook action).
 *
 *   GET  /api/rep-codes/by-zip/:zip
 *   POST /api/rep-codes/by-zip        (zip from JSON body { zip } or ?zip=)
 *
 * Returns the rep code for each channel covering the zip. Secured by a shared
 * token (REP_LOOKUP_TOKEN) presented as `Authorization: Bearer <token>`, an
 * `x-api-key: <token>` header, or a `?key=<token>` query param (whichever a
 * HubSpot workflow can send). Reads rep_code_zips via the service role.
 */

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined }; env: AppBindings["Bindings"] }): boolean {
  const expected = c.env.REP_LOOKUP_TOKEN;
  if (!expected) return false; // closed until configured
  const bearer = (c.req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  const provided = bearer ?? c.req.header("x-api-key") ?? c.req.query("key");
  return !!provided && constantTimeEqual(provided, expected);
}

async function lookup(env: AppBindings["Bindings"], rawZip: string) {
  const zip = normalizeZip(rawZip);
  if (!zip) return { zip: rawZip, found: false, count: 0, repCodes: [], repCodesText: "", byChannel: {} };
  const sb = serviceSupabase(env);
  const { data, error } = await sb
    .from("rep_code_zips")
    .select("rep_code, channel")
    .eq("zip", zip);
  if (error) throw new Error(`rep_code_zips lookup failed: ${error.message}`);
  const rows = (data ?? []) as { rep_code: string; channel: string }[];
  const byChannel: Record<string, string> = {};
  for (const r of rows) byChannel[r.channel] = r.rep_code;
  const repCodes = [...new Set(rows.map((r) => r.rep_code))].sort();
  return {
    zip,
    found: repCodes.length > 0,
    count: repCodes.length,
    repCodes,
    repCodesText: repCodes.join(", "),
    byChannel,
  };
}

repCodeRoutes.get("/by-zip/:zip", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  return c.json(await lookup(c.env, c.req.param("zip")));
});

repCodeRoutes.post("/by-zip", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { zip?: unknown };
  const zip = String(body.zip ?? c.req.query("zip") ?? "").trim();
  if (!zip) return c.json({ error: "missing zip" }, 400);
  return c.json(await lookup(c.env, zip));
});

// ---------------------------------------------------------------------------
// Contact write-back: a HubSpot workflow ("US contact, ZIP known") sends the
// enrolled contact's id; we look the ZIP's rep codes up and write each channel's
// code onto its `rep_code_*` contact property. The Worker does the writing (not
// the workflow), so these properties stay automation-only. Every owned property
// is set on each run — channels not covering the ZIP are cleared — so a ZIP
// change never leaves a stale code behind.
// ---------------------------------------------------------------------------

/**
 * Reduce a raw ZIP to a 5-digit US ZIP, or "" if it isn't one. HubSpot workflow
 * enrollment can't regex-match a ZIP, so this is the US-only gate: a ZIP+4 keeps
 * its first 5 digits; anything non-US / non-5-digit (e.g. Canadian "K1A 0B1")
 * returns "" → an empty lookup → the rep-code properties are cleared.
 */
function usZip5(raw: string): string {
  const z = normalizeZip(raw); // pads pure-numeric 1-4 digit zips to 5 (501 -> 00501)
  return z.match(/^(\d{5})(?:-\d{4})?$/)?.[1] ?? "";
}

/** Pull the HubSpot contact record id out of a webhook / request body. */
function contactIdFrom(body: Record<string, unknown>, queryId?: string): string | null {
  const raw =
    body.objectId ?? body.contactId ?? body.hs_object_id ?? body.vid ?? body.id ?? queryId ?? null;
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return /^\d+$/.test(s) ? s : null;
}

interface SyncContactResult {
  contactId: string;
  zip: string;
  found: boolean;
  count: number;
  byChannel: Record<string, string>;
  written: boolean;
}

/**
 * Resolve a contact's ZIP (from the request when the workflow forwards it, else
 * fetch it from HubSpot), look up its rep codes, and PATCH the full set of
 * `rep_code_*` properties onto the contact. Skips the write only when the
 * HubSpot token is unconfigured.
 */
async function syncContact(
  env: AppBindings["Bindings"],
  contactId: string,
  zipFromBody: string | undefined,
  signal: AbortSignal,
): Promise<SyncContactResult> {
  const token = env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN not configured");

  let zip = (zipFromBody ?? "").trim();
  if (!zip) {
    const res = await hs(
      token,
      "GET",
      `${PATHS.contactLookup}${encodeURIComponent(contactId)}?properties=zip`,
      undefined,
      signal,
    );
    if (!res.ok) {
      throw new Error(`contact ${contactId} fetch ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    }
    zip = String(res.data?.properties?.zip ?? "").trim();
  }

  // US-only gate: only a 5-digit US ZIP looks codes up; everything else clears.
  const result = await lookup(env, usZip5(zip));
  const properties = buildContactRepCodeProps(result.byChannel);

  const patch = await hs(
    token,
    "PATCH",
    `${PATHS.contactLookup}${encodeURIComponent(contactId)}`,
    { properties },
    signal,
  );
  if (!patch.ok) {
    throw new Error(`contact ${contactId} patch ${patch.status}: ${JSON.stringify(patch.data).slice(0, 200)}`);
  }

  return {
    contactId,
    zip: result.zip,
    found: result.found,
    count: result.count,
    byChannel: result.byChannel,
    written: true,
  };
}

/** Webhook path: ack immediately, write the rep codes back in the background. */
repCodeRoutes.post("/sync-contact", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const contactId = contactIdFrom(body, c.req.query("contactId"));
  if (!contactId) return c.json({ error: "missing contact id" }, 400);
  const zip = body.zip !== undefined ? String(body.zip) : c.req.query("zip") ?? undefined;

  c.executionCtx.waitUntil(
    syncContact(c.env, contactId, zip, AbortSignal.timeout(20_000)).catch((e) =>
      console.error(`[rep-codes] sync-contact ${contactId} failed:`, e),
    ),
  );

  return c.json({ accepted: true, contactId });
});

/** Sync path: write inline and return the outcome (for testing / backfill). */
repCodeRoutes.post("/sync-contact/sync", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const contactId = contactIdFrom(body, c.req.query("contactId"));
  if (!contactId) return c.json({ error: "missing contact id" }, 400);
  const zip = body.zip !== undefined ? String(body.zip) : c.req.query("zip") ?? undefined;

  const res = await syncContact(c.env, contactId, zip, AbortSignal.timeout(25_000));
  return c.json(res);
});
