import { describe, it, expect } from "vitest";
import {
  checkAndIncrRate,
  checkAndAddTokens,
  rateCapsFromEnv,
  tokenCapsFromEnv,
  DEFAULT_RATE_CAPS,
  DEFAULT_TOKEN_CAPS,
  type KVLike,
} from "./limits.js";

/** In-memory KV double (no TTL enforcement — TTLs are checked via recorded opts). */
function fakeKV(): KVLike & { store: Map<string, string>; ttls: Map<string, number | undefined> } {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  return {
    store,
    ttls,
    async get(k) {
      return store.has(k) ? (store.get(k) as string) : null;
    },
    async put(k, v, opts) {
      store.set(k, v);
      ttls.set(k, opts?.expirationTtl);
    },
  };
}

const NOW = Date.UTC(2026, 6, 18, 12, 30, 0); // fixed instant

describe("checkAndIncrRate", () => {
  it("allows exactly perMin requests then trips rate_minute", async () => {
    const kv = fakeKV();
    const caps = { perMin: 3, perDay: 1000 };
    const args = { ip: "1.1.1.1", siteKey: "sk", caps, now: NOW };
    for (let i = 0; i < 3; i++) expect((await checkAndIncrRate(kv, args)).ok).toBe(true);
    const over = await checkAndIncrRate(kv, args);
    expect(over.ok).toBe(false);
    expect(over.reason).toBe("rate_minute");
  });

  it("trips rate_day independently of the minute window", async () => {
    const kv = fakeKV();
    const caps = { perMin: 100, perDay: 2 };
    // Spread across separate minutes so the minute cap never trips.
    expect((await checkAndIncrRate(kv, { ip: "2.2.2.2", siteKey: "s", caps, now: NOW })).ok).toBe(true);
    expect((await checkAndIncrRate(kv, { ip: "2.2.2.2", siteKey: "s", caps, now: NOW + 60_000 })).ok).toBe(true);
    const over = await checkAndIncrRate(kv, { ip: "2.2.2.2", siteKey: "s", caps, now: NOW + 120_000 });
    expect(over.ok).toBe(false);
    expect(over.reason).toBe("rate_day");
  });

  it("keys windows by minute/day + ip + siteKey and sets TTLs", async () => {
    const kv = fakeKV();
    await checkAndIncrRate(kv, { ip: "3.3.3.3", siteKey: "SK", caps: DEFAULT_RATE_CAPS, now: NOW });
    const minKey = [...kv.store.keys()].find((k) => k.startsWith("rate:min:"));
    const dayKey = [...kv.store.keys()].find((k) => k.startsWith("rate:day:"));
    expect(minKey).toBe(`rate:min:SK:3.3.3.3:${Math.floor(NOW / 60_000)}`);
    expect(dayKey).toBe("rate:day:SK:3.3.3.3:2026-07-18");
    expect(kv.ttls.get(minKey as string)).toBe(120);
    expect(kv.ttls.get(dayKey as string)).toBe(25 * 60 * 60);
  });

  it("separates counters per ip and per siteKey", async () => {
    const kv = fakeKV();
    const caps = { perMin: 1, perDay: 1000 };
    expect((await checkAndIncrRate(kv, { ip: "a", siteKey: "s1", caps, now: NOW })).ok).toBe(true);
    // Different siteKey → its own bucket, still allowed.
    expect((await checkAndIncrRate(kv, { ip: "a", siteKey: "s2", caps, now: NOW })).ok).toBe(true);
    // Different ip → its own bucket, still allowed.
    expect((await checkAndIncrRate(kv, { ip: "b", siteKey: "s1", caps, now: NOW })).ok).toBe(true);
    // Same ip+siteKey again within the minute → over.
    expect((await checkAndIncrRate(kv, { ip: "a", siteKey: "s1", caps, now: NOW })).ok).toBe(false);
  });
});

describe("checkAndAddTokens", () => {
  it("pre-check (add=0) passes below cap and does not write", async () => {
    const kv = fakeKV();
    const res = await checkAndAddTokens(kv, { ip: "9.9.9.9", dayTokens: 0, now: NOW });
    expect(res.ok).toBe(true);
    expect(kv.store.size).toBe(0);
  });

  it("trips the per-IP token cap", async () => {
    const kv = fakeKV();
    const caps = { perIpDay: 1000, globalDay: 1_000_000 };
    await checkAndAddTokens(kv, { ip: "ip1", dayTokens: 1000, caps, now: NOW });
    const pre = await checkAndAddTokens(kv, { ip: "ip1", dayTokens: 0, caps, now: NOW });
    expect(pre.ok).toBe(false);
    expect(pre.reason).toBe("tokens_ip");
    // A different IP is unaffected (per-IP scoping).
    expect((await checkAndAddTokens(kv, { ip: "ip2", dayTokens: 0, caps, now: NOW })).ok).toBe(true);
  });

  it("trips the GLOBAL token cap across IPs", async () => {
    const kv = fakeKV();
    const caps = { perIpDay: 1_000_000, globalDay: 1500 };
    await checkAndAddTokens(kv, { ip: "ipA", dayTokens: 1000, caps, now: NOW });
    await checkAndAddTokens(kv, { ip: "ipB", dayTokens: 600, caps, now: NOW });
    // Global now 1600 > 1500 — even a brand-new IP is blocked.
    const pre = await checkAndAddTokens(kv, { ip: "ipC", dayTokens: 0, caps, now: NOW });
    expect(pre.ok).toBe(false);
    expect(pre.reason).toBe("tokens_global");
  });

  it("writes per-ip + global day keys with a 25h TTL", async () => {
    const kv = fakeKV();
    await checkAndAddTokens(kv, { ip: "ipX", dayTokens: 50, caps: DEFAULT_TOKEN_CAPS, now: NOW });
    expect(kv.store.get("tok:ip:ipX:2026-07-18")).toBe("50");
    expect(kv.store.get("tok:global:2026-07-18")).toBe("50");
    expect(kv.ttls.get("tok:global:2026-07-18")).toBe(25 * 60 * 60);
  });
});

describe("caps from env", () => {
  it("uses defaults when unset or invalid", () => {
    expect(rateCapsFromEnv({})).toEqual(DEFAULT_RATE_CAPS);
    expect(rateCapsFromEnv({ THOM_RATE_PER_MIN: "abc", THOM_RATE_PER_DAY: "-4" })).toEqual(DEFAULT_RATE_CAPS);
    expect(tokenCapsFromEnv({})).toEqual(DEFAULT_TOKEN_CAPS);
  });

  it("honors valid overrides", () => {
    expect(rateCapsFromEnv({ THOM_RATE_PER_MIN: "5", THOM_RATE_PER_DAY: "50" })).toEqual({
      perMin: 5,
      perDay: 50,
    });
    expect(
      tokenCapsFromEnv({ THOM_TOKENS_PER_IP_DAY: "1000", THOM_TOKENS_GLOBAL_DAY: "9999" }),
    ).toEqual({ perIpDay: 1000, globalDay: 9999 });
  });
});
