import { describe, expect, it } from "vitest";
import { matchOption, parseForwardedPayload, sha256Hex } from "./hubspotSync.js";

describe("parseForwardedPayload", () => {
  it("uses the envelope's idempotencyKey and the inner payload", async () => {
    const raw = JSON.stringify({ idempotencyKey: "abc123", payload: { sap_quote_number: "25103226" } });
    const res = await parseForwardedPayload(raw);
    expect(res).not.toBeNull();
    expect(res!.idempotencyKey).toBe("abc123");
    expect(res!.payload).toEqual({ sap_quote_number: "25103226" });
    expect(res!.payloadText).toBe(JSON.stringify({ sap_quote_number: "25103226" }));
  });

  it("hashes the inner payload when the envelope omits a key", async () => {
    const payload = { account_number_: "MF1234" };
    const raw = JSON.stringify({ payload });
    const res = await parseForwardedPayload(raw);
    expect(res!.idempotencyKey).toBe(await sha256Hex(JSON.stringify(payload)));
    expect(res!.payload).toEqual(payload);
  });

  it("treats a bare payload as the body and hashes the raw bytes", async () => {
    const raw = JSON.stringify({ sap_quote_number: "999" });
    const res = await parseForwardedPayload(raw);
    expect(res!.payloadText).toBe(raw);
    expect(res!.idempotencyKey).toBe(await sha256Hex(raw));
    expect(res!.payload).toEqual({ sap_quote_number: "999" });
  });

  it("matches the live and backup keys for the same bare payload", async () => {
    // A replayed raw-backup object and the original live forward share bytes, so
    // they must resolve to the SAME idempotency key (dedupe, not duplicate).
    const raw = JSON.stringify({ sap_quote_number: "777", requested_by: "x@y.com" });
    const live = await parseForwardedPayload(raw);
    const replayed = await parseForwardedPayload(raw);
    expect(live!.idempotencyKey).toBe(replayed!.idempotencyKey);
  });

  it("returns null on invalid JSON", async () => {
    expect(await parseForwardedPayload("not json")).toBeNull();
    expect(await parseForwardedPayload("")).toBeNull();
  });
});

describe("matchOption (single-property re-push validation)", () => {
  const opts = [
    { label: "PPPD", value: "PPPD" },
    { label: "PPPE", value: "PPPE" },
    { label: "Commercial / Military", value: "COMMERCIAL_MILITARY" },
  ];

  it("returns the canonical value for a now-allowed value (exact, case/space-insensitive)", () => {
    expect(matchOption("PPPD", opts)).toBe("PPPD");
    expect(matchOption(" pppe ", opts)).toBe("PPPE");
  });

  it("matches on the option label and returns its value", () => {
    expect(matchOption("Commercial / Military", opts)).toBe("COMMERCIAL_MILITARY");
  });

  it("returns null for a value that still matches no option, blank, or null", () => {
    expect(matchOption("PPPZ", opts)).toBeNull();
    expect(matchOption("", opts)).toBeNull();
    expect(matchOption(null, opts)).toBeNull();
  });
});
