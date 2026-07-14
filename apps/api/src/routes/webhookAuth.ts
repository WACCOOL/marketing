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

export function webhookAuthorized(c: {
  req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined };
  env: AppBindings["Bindings"];
}): boolean {
  const expected = c.env.REP_LOOKUP_TOKEN;
  if (!expected) return false; // closed until configured
  const bearer = (c.req.header("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1];
  const provided = bearer ?? c.req.header("x-api-key") ?? c.req.query("key");
  return !!provided && constantTimeEqual(provided, expected);
}
