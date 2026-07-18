import { describe, it, expect } from "vitest";
import { mintSession, verifySession, verifySessionClaims } from "./session.js";

const env = { SESSION_SECRET: "test-secret-abc123" };
const NOW = 1_760_000_000_000;

describe("session tokens", () => {
  it("mint → verify round-trips for the same IP", async () => {
    const token = await mintSession(env, { siteKey: "sk1", ip: "1.2.3.4", now: NOW });
    const claims = await verifySessionClaims(env, token, { ip: "1.2.3.4", now: NOW + 1000 });
    expect(claims).not.toBeNull();
    expect(claims!.siteKey).toBe("sk1");
    expect(await verifySession(env, token, { ip: "1.2.3.4", now: NOW + 1000 })).toBe(true);
  });

  it("fails for a different IP (token is IP-bound)", async () => {
    const token = await mintSession(env, { siteKey: "sk1", ip: "1.2.3.4", now: NOW });
    expect(await verifySession(env, token, { ip: "9.9.9.9", now: NOW + 1000 })).toBe(false);
  });

  it("fails once expired", async () => {
    const token = await mintSession(env, { siteKey: "sk1", ip: "1.2.3.4", ttlMs: 1000, now: NOW });
    expect(await verifySession(env, token, { ip: "1.2.3.4", now: NOW + 500 })).toBe(true);
    expect(await verifySession(env, token, { ip: "1.2.3.4", now: NOW + 2000 })).toBe(false);
  });

  it("fails when the payload is tampered", async () => {
    const token = await mintSession(env, { siteKey: "sk1", ip: "1.2.3.4", now: NOW });
    const [payload, sig] = token.split(".") as [string, string];
    // Flip a character in the payload → signature no longer matches.
    const tampered = payload.slice(0, -1) + (payload.endsWith("A") ? "B" : "A") + "." + sig;
    expect(await verifySession(env, tampered, { ip: "1.2.3.4", now: NOW + 1000 })).toBe(false);
  });

  it("fails when the signature is tampered", async () => {
    const token = await mintSession(env, { siteKey: "sk1", ip: "1.2.3.4", now: NOW });
    const [payload] = token.split(".") as [string, string];
    expect(await verifySession(env, `${payload}.deadbeef`, { ip: "1.2.3.4", now: NOW + 1000 })).toBe(false);
  });

  it("fails under a different signing secret", async () => {
    const token = await mintSession(env, { siteKey: "sk1", ip: "1.2.3.4", now: NOW });
    const other = { SESSION_SECRET: "a-different-secret" };
    expect(await verifySession(other, token, { ip: "1.2.3.4", now: NOW + 1000 })).toBe(false);
  });

  it("rejects malformed tokens", async () => {
    for (const bad of ["", "no-dot", ".", "abc.", ".abc"]) {
      expect(await verifySession(env, bad, { ip: "1.2.3.4", now: NOW })).toBe(false);
    }
  });
});
