/**
 * Slug generation for short links.
 *
 * Uses a URL-safe base62 alphabet (no lookalikes 0/O/1/l/I) to keep auto slugs
 * short, scan-friendly on printed QRs, and human-readable when shared verbally.
 */

const ALPHABET =
  "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ"; // 54 chars, no 0OoIl1
const DEFAULT_LEN = 7;

export function generateSlug(length: number = DEFAULT_LEN): string {
  const out = new Array<string>(length);
  const buf = new Uint32Array(length);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < length; i++) buf[i] = Math.floor(Math.random() * 0xffffffff);
  }
  for (let i = 0; i < length; i++) {
    out[i] = ALPHABET[buf[i]! % ALPHABET.length]!;
  }
  return out.join("");
}

const VANITY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

export function isValidVanitySlug(slug: string): boolean {
  if (!VANITY_RE.test(slug)) return false;
  // Reserve a handful of paths the redirect Worker uses for itself.
  const reserved = new Set([
    "favicon.ico",
    "robots.txt",
    "_health",
    "api",
    "admin",
  ]);
  return !reserved.has(slug.toLowerCase());
}
