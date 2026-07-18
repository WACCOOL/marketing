/**
 * KV-backed abuse limits for the public bot.
 *
 * Two independent guards:
 *   - checkAndIncrRate:  per-minute + per-day REQUEST caps, keyed by IP+siteKey.
 *   - checkAndAddTokens: per-IP + a GLOBAL per-day TOKEN cap, to bound the
 *                        Anthropic bill no matter how the requests are spread.
 *
 * SOFT CAPS: KV reads are eventually consistent across regions, so two
 * near-simultaneous requests can each read a stale counter and both pass. That
 * is acceptable here — these caps exist to bound abuse/spend to an order of
 * magnitude, not to enforce an exact quota. Every counter is written with a TTL
 * so the keyspace self-expires (no cleanup job).
 */

/** Minimal KV surface used here — lets tests pass a plain fake. */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface RateCaps {
  /** Requests per minute, per IP+siteKey. */
  perMin: number;
  /** Requests per day, per IP+siteKey. */
  perDay: number;
}

export interface TokenCaps {
  /** Tokens per day, per IP. */
  perIpDay: number;
  /** Tokens per day, GLOBAL (all IPs) — the hard ceiling on Anthropic spend. */
  globalDay: number;
}

/** Documented defaults. Override via env (see src/env.ts / src/index.ts). */
export const DEFAULT_RATE_CAPS: RateCaps = { perMin: 20, perDay: 300 };
export const DEFAULT_TOKEN_CAPS: TokenCaps = { perIpDay: 200_000, globalDay: 5_000_000 };

// TTLs: minute window lives 2 min (slop for clock skew), day windows live 25 h.
const MIN_TTL_S = 120;
const DAY_TTL_S = 25 * 60 * 60;

export interface LimitResult {
  ok: boolean;
  reason?: "rate_minute" | "rate_day" | "tokens_ip" | "tokens_global";
}

function dayStr(now: number): string {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}
function minuteEpoch(now: number): number {
  return Math.floor(now / 60_000);
}

async function readInt(kv: KVLike, key: string): Promise<number> {
  const raw = await kv.get(key);
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pre-request REQUEST cap. Reads the per-minute and per-day counters for this
 * IP+siteKey; if either is already at its cap, returns { ok:false } WITHOUT
 * incrementing. Otherwise increments both (compare-then-increment → exactly
 * `cap` requests allowed per window) and returns { ok:true }.
 */
export async function checkAndIncrRate(
  kv: KVLike,
  opts: { ip: string; siteKey: string; caps?: RateCaps; now?: number },
): Promise<LimitResult> {
  const caps = opts.caps ?? DEFAULT_RATE_CAPS;
  const now = opts.now ?? Date.now();
  const minKey = `rate:min:${opts.siteKey}:${opts.ip}:${minuteEpoch(now)}`;
  const dayKey = `rate:day:${opts.siteKey}:${opts.ip}:${dayStr(now)}`;

  const [minCount, dayCount] = await Promise.all([readInt(kv, minKey), readInt(kv, dayKey)]);
  if (minCount >= caps.perMin) return { ok: false, reason: "rate_minute" };
  if (dayCount >= caps.perDay) return { ok: false, reason: "rate_day" };

  await Promise.all([
    kv.put(minKey, String(minCount + 1), { expirationTtl: MIN_TTL_S }),
    kv.put(dayKey, String(dayCount + 1), { expirationTtl: DAY_TTL_S }),
  ]);
  return { ok: true };
}

/**
 * TOKEN cap. Two roles:
 *   - PRE-CHECK: call with dayTokens = 0 at the start of a turn — reads the
 *     per-IP and global day counters and returns { ok:false } if either is
 *     already over cap (nothing is written).
 *   - RECORD: call with dayTokens = <usage> after the turn — adds to both
 *     counters. The return value then reports whether the NEW total is within
 *     cap (callers may ignore it on the record call; the next pre-check enforces).
 */
export async function checkAndAddTokens(
  kv: KVLike,
  opts: { ip: string; dayTokens: number; caps?: TokenCaps; now?: number },
): Promise<LimitResult> {
  const caps = opts.caps ?? DEFAULT_TOKEN_CAPS;
  const now = opts.now ?? Date.now();
  const add = Math.max(0, Math.floor(opts.dayTokens || 0));
  const ipKey = `tok:ip:${opts.ip}:${dayStr(now)}`;
  const globalKey = `tok:global:${dayStr(now)}`;

  const [ipCount, globalCount] = await Promise.all([readInt(kv, ipKey), readInt(kv, globalKey)]);

  // Pre-check (add === 0): block if already at/over cap.
  if (add === 0) {
    if (ipCount >= caps.perIpDay) return { ok: false, reason: "tokens_ip" };
    if (globalCount >= caps.globalDay) return { ok: false, reason: "tokens_global" };
    return { ok: true };
  }

  const newIp = ipCount + add;
  const newGlobal = globalCount + add;
  await Promise.all([
    kv.put(ipKey, String(newIp), { expirationTtl: DAY_TTL_S }),
    kv.put(globalKey, String(newGlobal), { expirationTtl: DAY_TTL_S }),
  ]);
  if (newGlobal > caps.globalDay) return { ok: false, reason: "tokens_global" };
  if (newIp > caps.perIpDay) return { ok: false, reason: "tokens_ip" };
  return { ok: true };
}

/** Build RateCaps from env overrides, falling back to the documented defaults. */
export function rateCapsFromEnv(env: {
  THOM_RATE_PER_MIN?: string;
  THOM_RATE_PER_DAY?: string;
}): RateCaps {
  return {
    perMin: intOr(env.THOM_RATE_PER_MIN, DEFAULT_RATE_CAPS.perMin),
    perDay: intOr(env.THOM_RATE_PER_DAY, DEFAULT_RATE_CAPS.perDay),
  };
}

/** Build TokenCaps from env overrides, falling back to the documented defaults. */
export function tokenCapsFromEnv(env: {
  THOM_TOKENS_PER_IP_DAY?: string;
  THOM_TOKENS_GLOBAL_DAY?: string;
}): TokenCaps {
  return {
    perIpDay: intOr(env.THOM_TOKENS_PER_IP_DAY, DEFAULT_TOKEN_CAPS.perIpDay),
    globalDay: intOr(env.THOM_TOKENS_GLOBAL_DAY, DEFAULT_TOKEN_CAPS.globalDay),
  };
}

function intOr(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
