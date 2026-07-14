import { describe, expect, it } from "vitest";
import { decodeHubspotUri, hubspotSignatureValid } from "./quoteDesk.js";

const SECRET = "test-client-secret";

async function sign(method: string, uri: string, body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(method + decodeHubspotUri(uri) + body + timestamp),
  );
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

function ctx(opts: {
  method: string;
  url: string;
  signature?: string;
  timestamp?: string;
  secret?: string | undefined;
}) {
  const headers: Record<string, string | undefined> = {
    "x-hubspot-signature-v3": opts.signature,
    "x-hubspot-request-timestamp": opts.timestamp,
  };
  return {
    req: {
      header: (n: string) => headers[n.toLowerCase()],
      method: opts.method,
      url: opts.url,
    },
    env: { QUOTE_DESK_CLIENT_SECRET: opts.secret } as never,
  };
}

describe("decodeHubspotUri", () => {
  it("decodes the documented character set only", () => {
    expect(decodeHubspotUri("https://x.dev/a%3Ab%2Fc%3Fd%40e%2Cf")).toBe("https://x.dev/a:b/c?d@e,f");
    expect(decodeHubspotUri("%21%24%27%28%29%2A%3B")).toBe("!$'()*;");
    // %20 (space) and other encodings stay encoded
    expect(decodeHubspotUri("a%20b%3Dc")).toBe("a%20b%3Dc");
  });
});

describe("hubspotSignatureValid", () => {
  const url = "https://marketing.gowac.cc/api/quote-desk/requests?portalId=46455872&userEmail=x%40y.com";
  const body = '{"dealId":"123"}';

  it("accepts a correctly signed request", async () => {
    const ts = String(Date.now());
    const sig = await sign("POST", url, body, ts);
    const c = ctx({ method: "POST", url, signature: sig, timestamp: ts, secret: SECRET });
    expect(await hubspotSignatureValid(c, body)).toBe(true);
  });

  it("rejects a tampered query param (identity forgery)", async () => {
    const ts = String(Date.now());
    const sig = await sign("POST", url, body, ts);
    const forged = url.replace("x%40y.com", "attacker%40evil.com");
    const c = ctx({ method: "POST", url: forged, signature: sig, timestamp: ts, secret: SECRET });
    expect(await hubspotSignatureValid(c, body)).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const ts = String(Date.now());
    const sig = await sign("POST", url, body, ts);
    const c = ctx({ method: "POST", url, signature: sig, timestamp: ts, secret: SECRET });
    expect(await hubspotSignatureValid(c, '{"dealId":"999"}')).toBe(false);
  });

  it("rejects stale timestamps (>5 min)", async () => {
    const ts = String(Date.now() - 6 * 60 * 1000);
    const sig = await sign("POST", url, body, ts);
    const c = ctx({ method: "POST", url, signature: sig, timestamp: ts, secret: SECRET });
    expect(await hubspotSignatureValid(c, body)).toBe(false);
  });

  it("is closed until the secret is configured", async () => {
    const ts = String(Date.now());
    const sig = await sign("POST", url, body, ts);
    const c = ctx({ method: "POST", url, signature: sig, timestamp: ts, secret: undefined });
    expect(await hubspotSignatureValid(c, body)).toBe(false);
  });

  it("rejects missing headers", async () => {
    const c = ctx({ method: "POST", url, secret: SECRET });
    expect(await hubspotSignatureValid(c, body)).toBe(false);
  });
});
