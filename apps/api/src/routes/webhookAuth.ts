import type { AppBindings } from "../auth.js";

/**
 * Shared-token auth for automation webhooks (HubSpot workflows, sync CLIs).
 *
 * All automation callers present the same shared token (REP_LOOKUP_TOKEN) as
 * `Authorization: Bearer <token>`, `x-api-key: <token>`, or `?key=<token>` —
 * whichever the caller can send. Extracted from the identical copies that lived
 * in routes/repCodes.ts, routes/companyClassify.ts, and routes/eventLeads.ts.
 */

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type WebhookCtx = {
  req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined };
  env: AppBindings["Bindings"];
};

/** The caller-provided token, from whichever transport the caller can send. */
function providedToken(c: WebhookCtx): string | undefined {
  const bearer = (c.req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer ?? c.req.header("x-api-key") ?? c.req.query("key");
}

export function webhookAuthorized(c: WebhookCtx): boolean {
  const expected = c.env.REP_LOOKUP_TOKEN;
  if (!expected) return false; // closed until configured
  const provided = providedToken(c);
  return !!provided && constantTimeEqual(provided, expected);
}

/**
 * Material Bank endpoints accept the shared REP_LOOKUP_TOKEN or the
 * MATERIAL_BANK_TOKEN (see env.ts for why two exist).
 */
export function materialBankAuthorized(c: WebhookCtx): boolean {
  if (webhookAuthorized(c)) return true;
  const alt = c.env.MATERIAL_BANK_TOKEN;
  if (!alt) return false;
  const provided = providedToken(c);
  return !!provided && constantTimeEqual(provided, alt);
}
