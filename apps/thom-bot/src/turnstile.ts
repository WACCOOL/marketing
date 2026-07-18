/**
 * Cloudflare Turnstile server-side verification.
 *
 * The widget solves a Turnstile challenge in the browser and posts the token to
 * POST /api/turnstile; we verify it here against the siteverify endpoint before
 * minting a session. This is the human/bot gate in front of the (billed) chat
 * stream — no valid Turnstile token, no session, no chat.
 */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

/**
 * Verify a Turnstile token. Returns the `success` boolean from siteverify.
 * `ip` (CF-Connecting-IP) is passed as `remoteip` when present. Any network /
 * parse failure returns false (fail closed).
 */
export async function verifyTurnstile(
  token: string,
  ip: string | null,
  secret: string,
): Promise<boolean> {
  if (!token || !secret) return false;
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);

  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body });
    if (!res.ok) return false;
    const data = (await res.json()) as SiteverifyResponse;
    return data.success === true;
  } catch {
    return false;
  }
}
