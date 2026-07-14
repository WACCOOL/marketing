import { describe, expect, it } from "vitest";
import { zendeskSignatureValid } from "./zendeskWebhook.js";

// Zendesk's documented pre-creation TEST signing secret — real webhooks get a
// per-webhook secret, but the scheme (base64(HMAC-SHA256(secret, ts + body)))
// is identical.
const SECRET = "dGhpc19zZWNyZXRfaXNfZm9yX3Rlc3Rpbmdfb25seQ==";

async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp + body));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

describe("zendeskSignatureValid", () => {
  const timestamp = "2026-07-14T12:00:00Z";
  const body = '{"ticket_id": 12345, "status": "open"}';

  it("accepts a correctly signed payload", async () => {
    const sig = await sign(SECRET, timestamp, body);
    expect(await zendeskSignatureValid(SECRET, timestamp, body, sig)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const sig = await sign(SECRET, timestamp, body);
    const tampered = '{"ticket_id": 99999, "status": "open"}';
    expect(await zendeskSignatureValid(SECRET, timestamp, tampered, sig)).toBe(false);
  });

  it("rejects a shifted timestamp (replay with different ts)", async () => {
    const sig = await sign(SECRET, timestamp, body);
    expect(await zendeskSignatureValid(SECRET, "2026-07-14T12:00:01Z", body, sig)).toBe(false);
  });

  it("rejects a signature minted with the wrong secret", async () => {
    const sig = await sign("some-other-secret", timestamp, body);
    expect(await zendeskSignatureValid(SECRET, timestamp, body, sig)).toBe(false);
  });

  it("rejects garbage signatures", async () => {
    expect(await zendeskSignatureValid(SECRET, timestamp, body, "not-a-signature")).toBe(false);
    expect(await zendeskSignatureValid(SECRET, timestamp, body, "")).toBe(false);
  });
});
