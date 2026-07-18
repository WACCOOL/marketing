/**
 * Embed-origin allowlist.
 *
 * The public bot is meant to be framed on approved WAC Group sites only.
 * ALLOWED_ORIGINS is a comma-separated list of exact origins
 * (e.g. "https://www.waclighting.com,https://www.modernforms.com"). It gates the
 * /api/turnstile + /api/chat/stream requests AND drives the CSP
 * `frame-ancestors` header.
 *
 * When ALLOWED_ORIGINS is unset/empty: allow NOTHING in prod, but allow
 * localhost / 127.0.0.1 (any port, http/https) so local widget dev works
 * without configuration.
 */

function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

/** True if `origin` is permitted to embed / call the bot. */
export function originAllowed(env: { ALLOWED_ORIGINS?: string }, origin: string | null): boolean {
  if (!origin) return false;
  const list = parseList(env.ALLOWED_ORIGINS);
  if (list.includes(origin)) return true;
  // Dev fallback ONLY when no allowlist is configured.
  if (list.length === 0 && isLocalhostOrigin(origin)) return true;
  return false;
}

/**
 * The `frame-ancestors` source list for the CSP header: the configured origins
 * (plus localhost when none are configured, matching originAllowed). Returns
 * "'none'" when there is nothing to allow.
 */
export function frameAncestors(env: { ALLOWED_ORIGINS?: string }): string {
  const list = parseList(env.ALLOWED_ORIGINS);
  if (list.length > 0) return list.join(" ");
  return "http://localhost:* http://127.0.0.1:*";
}
