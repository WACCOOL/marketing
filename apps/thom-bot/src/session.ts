/**
 * HMAC-signed, short-lived session tokens.
 *
 * After a browser passes Turnstile we mint a stateless token bound to the
 * caller's IP (hashed) and the embedding siteKey, expiring in ~30 min. The chat
 * stream requires a valid, unexpired token whose IP-hash matches the live
 * CF-Connecting-IP — so a token can't be lifted and replayed from another host,
 * and can't be used long after the human check.
 *
 * Format: `${payloadB64url}.${sigB64url}` where payload is JSON
 * { siteKey, ipHash, exp } and sig = HMAC-SHA256(SESSION_SECRET, payloadB64url).
 * Pure-ish (only Web Crypto) so it unit-tests with a fake secret.
 */

export interface SessionClaims {
  siteKey: string;
  /** SHA-256(ip) hex — the token is bound to the caller IP without storing it. */
  ipHash: string;
  /** Expiry, epoch ms. */
  exp: number;
}

interface SessionSecretEnv {
  SESSION_SECRET: string;
}

/** Default token lifetime: 30 minutes. */
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

const enc = new TextEncoder();

function b64urlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlEncodeString(str: string): string {
  return b64urlFromBytes(enc.encode(str));
}

function b64urlDecodeToString(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmacB64url(secret: string, data: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64urlFromBytes(new Uint8Array(sig));
}

/** SHA-256(input) as lowercase hex. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare (equal length → no early-out on content). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a signed session token bound to {siteKey, ip}. `ttlMs`/`now` are
 * injectable for tests; defaults are 30 min from Date.now().
 */
export async function mintSession(
  env: SessionSecretEnv,
  opts: { siteKey: string; ip: string; ttlMs?: number; now?: number },
): Promise<string> {
  const now = opts.now ?? Date.now();
  const claims: SessionClaims = {
    siteKey: opts.siteKey,
    ipHash: await sha256Hex(opts.ip),
    exp: now + (opts.ttlMs ?? DEFAULT_SESSION_TTL_MS),
  };
  const payload = b64urlEncodeString(JSON.stringify(claims));
  const sig = await hmacB64url(env.SESSION_SECRET, payload);
  return `${payload}.${sig}`;
}

/**
 * Verify a token: signature valid (constant-time), not expired, and its ipHash
 * matches the caller IP. Returns the claims on success, else null.
 */
export async function verifySessionClaims(
  env: SessionSecretEnv,
  token: string,
  opts: { ip: string; now?: number },
): Promise<SessionClaims | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = await hmacB64url(env.SESSION_SECRET, payload);
  if (!timingSafeEqual(sig, expected)) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(b64urlDecodeToString(payload)) as SessionClaims;
  } catch {
    return null;
  }
  const now = opts.now ?? Date.now();
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  const ipHash = await sha256Hex(opts.ip);
  if (!timingSafeEqual(claims.ipHash ?? "", ipHash)) return null;
  return claims;
}

/** Boolean convenience wrapper over verifySessionClaims. */
export async function verifySession(
  env: SessionSecretEnv,
  token: string,
  opts: { ip: string; now?: number },
): Promise<boolean> {
  return (await verifySessionClaims(env, token, opts)) !== null;
}
