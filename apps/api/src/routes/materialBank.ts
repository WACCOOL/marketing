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
 *
 * Body: { order: MaterialBankOrder, dryRun?: boolean }. Secured by the shared
 * automation token (REP_LOOKUP_TOKEN — Bearer / x-api-key / ?key=), like the
 * other HubSpot automation endpoints. Inline (not queued) on purpose: the CLI
 * paces orders serially and needs each outcome before marking a file done, and
 * processing is idempotent so retries are safe.
 */
export const materialBankRoutes = new Hono<AppBindings>();

const authorized = webhookAuthorized;

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
