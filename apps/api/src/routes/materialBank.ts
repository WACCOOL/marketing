import { Hono } from "hono";
import type { MaterialBankOrder } from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { processMaterialBankOrder } from "../materialBank.js";
import { webhookAuthorized } from "./webhookAuth.js";

/**
 * Material Bank order intake, called by the apps/material-bank-sync CLI (which
 * owns the SFTP pull + XML parse and POSTs one typed order at a time).
 *
 *   POST /api/hubspot/material-bank/sync   — process inline, return the outcome
 *   POST /api/hubspot/material-bank/file   — file relay drop-off (see below)
 *
 * Body: { order: MaterialBankOrder, dryRun?: boolean }. Secured by the shared
 * automation token (REP_LOOKUP_TOKEN — Bearer / x-api-key / ?key=), like the
 * other HubSpot automation endpoints. Inline (not queued) on purpose: the CLI
 * paces orders serially and needs each outcome before marking a file done, and
 * processing is idempotent so retries are safe.
 *
 * The /file endpoint exists because Material Bank whitelists source IPs on its
 * SFTP and GitHub-hosted runners have no stable egress IP. Until the whitelist
 * is lifted (or a static-IP runner takes over), an already-whitelisted relay
 * (the old Make.com connection, reduced to pure transport) reads each new file
 * and POSTs its RAW bytes here (?name=<filename>, body = file, untranscoded —
 * the CLI owns the ISO-8859-1 decode); it lands in R2 under
 * ingest/material-bank/inbox/ and the CLI processes it via --inbox exactly as
 * if it had pulled it from SFTP.
 */
export const materialBankRoutes = new Hono<AppBindings>();

const authorized = webhookAuthorized;

/** R2 prefix the relay drops raw files into; the CLI's --inbox mode scans it. */
export const MATERIAL_BANK_INBOX_PREFIX = "ingest/material-bank/inbox/";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

materialBankRoutes.post("/material-bank/file", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const rawName = c.req.query("name") ?? "";
  // basename only, conservative charset, must be .xml
  const name = rawName.split(/[\\/]/).pop()?.trim() ?? "";
  if (!name || !/^[\w .()-]+\.xml$/i.test(name)) {
    return c.json({ error: "missing or invalid ?name= (expected a .xml filename)" }, 400);
  }
  const bytes = await c.req.arrayBuffer();
  if (!bytes.byteLength) return c.json({ error: "empty body" }, 400);
  if (bytes.byteLength > MAX_FILE_BYTES) return c.json({ error: "file too large" }, 413);

  const key = `${MATERIAL_BANK_INBOX_PREFIX}${name}`;
  await c.env.ASSETS_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: "text/xml" },
  });
  return c.json({ stored: key, bytes: bytes.byteLength });
});

materialBankRoutes.post("/material-bank/sync", async (c) => {
  if (!authorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => null)) as {
    order?: MaterialBankOrder;
    dryRun?: boolean;
  } | null;
  const order = body?.order;
  if (!order || typeof order !== "object" || !order.orderId) {
    return c.json({ error: "missing order (expected { order: MaterialBankOrder, dryRun? })" }, 400);
  }
  const outcome = await processMaterialBankOrder(
    c.env,
    order,
    { dryRun: !!body?.dryRun },
    AbortSignal.timeout(60_000),
  );
  return c.json(outcome, outcome.status === "error" ? 500 : 200);
});
