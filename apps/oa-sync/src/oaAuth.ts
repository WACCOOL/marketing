import { createHmac, randomUUID } from "node:crypto";

/**
 * OA API request auth (per the Order List/Detail API docs):
 *   token     = hex(HMAC-SHA256(msg = UTC date "yyyyMMdd", key = SECRET + nonce))
 *   timestamp = UTC ms since epoch (server allows ±5 minutes of skew)
 *   nonce     = UUIDv4, unique per request (server rejects reuse)
 *
 * Lives here (not @wac/shared) because shared must stay free of node:crypto
 * for its Workers consumers.
 */

/** "yyyyMMdd" for the UTC day of nowMs, optionally shifted by dayOffset days. */
export function oaDateString(nowMs: number, dayOffset = 0): string {
  const d = new Date(nowMs + dayOffset * 86_400_000);
  return (
    String(d.getUTCFullYear()) +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

/** The signature for a given secret/nonce/date-string. */
export function oaToken(secret: string, nonce: string, dateStr: string): string {
  return createHmac("sha256", secret + nonce).update(dateStr).digest("hex");
}

/**
 * Fresh headers for one request attempt. Callers MUST regenerate per attempt —
 * the server caches nonces, so a retry with reused headers is rejected.
 * `dayOffset` exists for the date-boundary fallback: the docs say the signed
 * date is UTC, but if OA actually signs China-local dates the two differ from
 * 16:00 UTC onward; the client retries once with +1 day before failing.
 */
export function oaHeaders(
  secret: string,
  nowMs = Date.now(),
  dayOffset = 0,
): Record<string, string> {
  const nonce = randomUUID();
  return {
    "content-type": "application/json",
    token: oaToken(secret, nonce, oaDateString(nowMs, dayOffset)),
    timestamp: String(nowMs),
    nonce,
  };
}
