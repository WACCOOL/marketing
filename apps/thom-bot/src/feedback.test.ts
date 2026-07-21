import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feedbackRoutes } from "./feedback.js";
import { mintSession } from "./session.js";
import type { KVLike } from "./limits.js";

/**
 * Public worker /api/feedback guard chain: THOM_FEEDBACK dark gate (F8),
 * origin, session, feedback-specific rate caps with ISOLATED KV keys, 503
 * when the log bridge is unconfigured, and payload caps enforced pre-forward.
 */

function fakeKV(): KVLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(k) {
      return store.has(k) ? (store.get(k) as string) : null;
    },
    async put(k, v) {
      store.set(k, v);
    },
  };
}

const IP = "9.9.9.9";
const ORIGIN = "https://ok.example";
const SECRET = "test-session-secret";

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    THOM_FEEDBACK: "1",
    SESSION_SECRET: SECRET,
    ALLOWED_ORIGINS: ORIGIN,
    THOM_KV: fakeKV(),
    THOM_LOG_URL: "https://api.example/api/thom/public-log",
    THOM_LOG_TOKEN: "bridge-token",
    ...overrides,
  } as never;
}

async function session(): Promise<string> {
  return mintSession({ SESSION_SECRET: SECRET }, { siteKey: "sk", ip: IP });
}

function post(
  env: never,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response | Promise<Response> {
  return feedbackRoutes.request(
    "/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: ORIGIN,
        "CF-Connecting-IP": IP,
        ...headers,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function validBody(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    session: await session(),
    turnId: "turn-1",
    rating: 1,
    question: "which downlight?",
    answer: "the aether one",
    ...extra,
  };
}

describe("POST /api/feedback (public worker)", () => {
  it("404s while THOM_FEEDBACK is not '1' — the SERVER-SIDE dark-launch gate (F8)", async () => {
    for (const flag of [undefined, "", "0", "true"]) {
      const env = makeEnv({ THOM_FEEDBACK: flag });
      const res = await post(env, await validBody());
      expect(res.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403s a disallowed origin", async () => {
    const res = await post(makeEnv(), await validBody(), { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("401s a missing or expired session", async () => {
    expect((await post(makeEnv(), { turnId: "t", rating: 1, question: "q", answer: "a" })).status).toBe(401);
    const expired = await mintSession(
      { SESSION_SECRET: SECRET },
      { siteKey: "sk", ip: IP, ttlMs: 1, now: Date.now() - 10_000 },
    );
    expect((await post(makeEnv(), await validBody({ session: expired }))).status).toBe(401);
  });

  it("429s past the feedback cap using ISOLATED KV keys (chat counters untouched)", async () => {
    const env = makeEnv({ THOM_FEEDBACK_PER_MIN: "1" });
    const kv = (env as { THOM_KV: ReturnType<typeof fakeKV> }).THOM_KV;
    expect((await post(env, await validBody())).status).toBe(200);
    expect((await post(env, await validBody())).status).toBe(429);
    const keys = [...kv.store.keys()];
    // Feedback counters live in their own "fb" namespace…
    expect(keys.some((k) => k.startsWith("rate:fb:min:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("rate:fb:day:"))).toBe(true);
    // …and the CHAT namespace was never touched.
    expect(keys.some((k) => k.startsWith("rate:min:"))).toBe(false);
    expect(keys.some((k) => k.startsWith("rate:day:"))).toBe(false);
  });

  it("400s bad payloads (rating, missing turnId, oversized turnId, empty text)", async () => {
    const env = makeEnv();
    expect((await post(env, await validBody({ rating: 0 }))).status).toBe(400);
    expect((await post(env, await validBody({ turnId: "" }))).status).toBe(400);
    expect((await post(env, await validBody({ turnId: "x".repeat(65) }))).status).toBe(400);
    expect((await post(env, await validBody({ question: "" }))).status).toBe(400);
    expect((await post(env, await validBody({ answer: "" }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("503s when the log bridge is unconfigured", async () => {
    for (const unset of [{ THOM_LOG_URL: undefined }, { THOM_LOG_TOKEN: undefined }]) {
      const res = await post(makeEnv(unset), await validBody());
      expect(res.status).toBe(503);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps question/answer/reason PRE-FORWARD and posts to the bridge /feedback subroute", async () => {
    const env = makeEnv();
    const res = await post(
      env,
      await validBody({
        question: "q".repeat(9000),
        answer: "a".repeat(20000),
        rating: -1,
        reason: "r".repeat(2000),
      }),
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/api/thom/public-log/feedback");
    expect((init.headers as Record<string, string>)["x-thom-log-token"]).toBe("bridge-token");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect((body.question as string).length).toBe(8000);
    expect((body.answer as string).length).toBe(16000);
    expect((body.reason as string).length).toBe(1000);
    expect(body.client_turn_id).toBe("turn-1");
    expect(body.rating).toBe(-1);
    // session_key = SHA-256(session token) truncated to 32 hex chars — same
    // derivation as turn logging.
    expect(body.session_key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("502s when the bridge rejects the forward", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const res = await post(makeEnv(), await validBody());
    expect(res.status).toBe(502);
  });
});
