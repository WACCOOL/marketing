import { Hono } from "hono";
import { normalizeZip } from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { serviceSupabase } from "../supabase.js";

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
