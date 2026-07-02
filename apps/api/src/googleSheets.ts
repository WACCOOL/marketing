import type { Env } from "./env.js";

/**
 * Minimal Google Sheets API v4 reader for the Worker — no npm deps. Auth is a
 * Google Cloud service account (the full JSON key in the GOOGLE_SA_KEY secret):
 * we mint a short-lived access token by signing an RS256 JWT with WebCrypto and
 * exchanging it at the OAuth token endpoint (the standard service-account
 * "two-legged" flow). Read-only scope; each source sheet must be shared with
 * the service account's client_email.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

/** PEM PKCS#8 private key -> raw DER bytes for crypto.subtle.importKey. */
function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}

export function googleSheetsConfigured(env: Env): boolean {
  return !!env.GOOGLE_SA_KEY;
}

/** RS256-signed OAuth JWT assertion for the service-account token exchange. */
export async function buildServiceAccountAssertion(
  key: ServiceAccountKey,
  iat: number,
): Promise<string> {
  const unsigned =
    b64urlJson({ alg: "RS256", typ: "JWT" }) +
    "." +
    b64urlJson({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 });
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(key.private_key).buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

// Access tokens last 1h; cache for 50min so a long sync never straddles expiry.
let tokenCache: { token: string; expiresAt: number } | null = null;
const TOKEN_TTL_MS = 50 * 60 * 1000;

export async function getGoogleSheetsToken(env: Env, signal: AbortSignal): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  if (!env.GOOGLE_SA_KEY) throw new Error("GOOGLE_SA_KEY is not configured");

  let key: ServiceAccountKey;
  try {
    key = JSON.parse(env.GOOGLE_SA_KEY) as ServiceAccountKey;
  } catch {
    throw new Error("GOOGLE_SA_KEY is not valid JSON (expected the full service-account key file)");
  }
  if (!key.client_email || !key.private_key) {
    throw new Error("GOOGLE_SA_KEY is missing client_email/private_key");
  }

  const assertion = await buildServiceAccountAssertion(key, Math.floor(Date.now() / 1000));

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal,
  });
  const data = (await res.json().catch(() => null)) as
    | { access_token?: string; error?: string; error_description?: string }
    | null;
  if (!res.ok || !data?.access_token) {
    throw new Error(
      `Google token exchange failed (${res.status}): ${data?.error ?? ""} ${data?.error_description ?? ""}`.trim(),
    );
  }
  tokenCache = { token: data.access_token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return data.access_token;
}

/**
 * Fetch a values grid. UNFORMATTED_VALUE + SERIAL_NUMBER so amounts arrive as
 * numbers (not "$5,065.42") and timestamps as locale-independent serials —
 * the contract packages/shared/showroom/parse.ts is written against.
 */
export async function fetchSheetValues(
  token: string,
  spreadsheetId: string,
  range: string,
  signal: AbortSignal,
): Promise<unknown[][]> {
  const url =
    `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}` +
    `?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal });
  const data = (await res.json().catch(() => null)) as
    | { values?: unknown[][]; error?: { message?: string; status?: string } }
    | null;
  if (!res.ok) {
    const hint =
      res.status === 403 || res.status === 404
        ? " (is the sheet shared with the service account?)"
        : "";
    throw new Error(
      `Sheets fetch ${spreadsheetId} failed (${res.status}): ${data?.error?.message ?? "unknown"}${hint}`,
    );
  }
  return data?.values ?? [];
}
