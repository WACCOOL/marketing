import { describe, expect, it, beforeEach } from "vitest";
import { vi } from "vitest";

/**
 * Bridge feedback subroute (plan B.2.2): shared-secret gate, explicit zod
 * bounds (F12), match-hit snapshots FROM THE DB ROWS (F3), miss → client text
 * with message_id null (the unverified flag), upsert on dedup_key.
 */

interface Fixture {
  conversation: { id: string } | null;
  messages: { id: string; role: string; content: string | null; created_at: string; model?: string | null }[];
  upserts: { table: string; row: Record<string, unknown>; opts: Record<string, unknown> }[];
}

const fixture: Fixture = { conversation: null, messages: [], upserts: [] };

function fakeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  for (const m of ["select", "eq", "gte", "in", "order", "limit", "insert", "update"]) b[m] = chain;
  b.maybeSingle = async () => ({ data: fixture.conversation, error: null });
  b.single = async () => ({ data: { id: "created" }, error: null });
  b.upsert = async (row: Record<string, unknown>, opts: Record<string, unknown>) => {
    fixture.upserts.push({ table, row, opts });
    return { error: null };
  };
  b.then = (resolve: (r: unknown) => void) => {
    resolve({ data: fixture.messages, error: null });
  };
  return b;
}

vi.mock("../supabase.js", () => ({
  serviceSupabase: () => ({ from: (t: string) => fakeBuilder(t) }),
  userSupabase: () => ({ from: (t: string) => fakeBuilder(t) }),
}));

import { thomPublicLogRoutes, FeedbackInput } from "./thomPublicLog.js";

const ENV = { THOM_LOG_TOKEN: "sekret" } as never;

const VALID = {
  session_key: "abcdef0123456789abcdef0123456789",
  site_key: "https://ok.example",
  client_turn_id: "turn-1",
  rating: 1,
  question: "which downlight?",
  answer: "the aether one",
};

function post(body: unknown, token = "sekret"): Response | Promise<Response> {
  return thomPublicLogRoutes.request(
    "/feedback",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-thom-log-token": token },
      body: JSON.stringify(body),
    },
    ENV,
  );
}

beforeEach(() => {
  fixture.conversation = null;
  fixture.messages = [];
  fixture.upserts = [];
});

describe("FeedbackInput zod bounds (F12 — each enforced individually)", () => {
  it("accepts the valid payload", () => {
    expect(FeedbackInput.safeParse(VALID).success).toBe(true);
  });

  it("session_key must be 16–128 chars", () => {
    expect(FeedbackInput.safeParse({ ...VALID, session_key: "short" }).success).toBe(false);
    expect(FeedbackInput.safeParse({ ...VALID, session_key: "x".repeat(129) }).success).toBe(false);
    expect(FeedbackInput.safeParse({ ...VALID, session_key: "x".repeat(16) }).success).toBe(true);
  });

  it("client_turn_id must be 1–64 chars", () => {
    expect(FeedbackInput.safeParse({ ...VALID, client_turn_id: "" }).success).toBe(false);
    expect(FeedbackInput.safeParse({ ...VALID, client_turn_id: "x".repeat(65) }).success).toBe(false);
  });

  it("rating is the literal 1 | -1 only", () => {
    expect(FeedbackInput.safeParse({ ...VALID, rating: 0 }).success).toBe(false);
    expect(FeedbackInput.safeParse({ ...VALID, rating: 2 }).success).toBe(false);
    expect(FeedbackInput.safeParse({ ...VALID, rating: -1 }).success).toBe(true);
  });

  it("reason capped at 1000", () => {
    expect(FeedbackInput.safeParse({ ...VALID, reason: "x".repeat(1001) }).success).toBe(false);
    expect(FeedbackInput.safeParse({ ...VALID, reason: "x".repeat(1000) }).success).toBe(true);
  });

  it("question capped at 8000 and required", () => {
    expect(FeedbackInput.safeParse({ ...VALID, question: "" }).success).toBe(false);
    expect(FeedbackInput.safeParse({ ...VALID, question: "x".repeat(8001) }).success).toBe(false);
  });

  it("answer capped at 16000 (the unmatched-row cap, F3) and required", () => {
    expect(FeedbackInput.safeParse({ ...VALID, answer: "" }).success).toBe(false);
    expect(FeedbackInput.safeParse({ ...VALID, answer: "x".repeat(16001) }).success).toBe(false);
    expect(FeedbackInput.safeParse({ ...VALID, answer: "x".repeat(16000) }).success).toBe(true);
  });
});

describe("POST /feedback (bridge)", () => {
  it("403s a wrong shared secret and 503s when unconfigured", async () => {
    expect((await post(VALID, "wrong")).status).toBe(403);
    const res = await thomPublicLogRoutes.request(
      "/feedback",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(VALID) },
      {} as never,
    );
    expect(res.status).toBe(503);
    expect(fixture.upserts).toHaveLength(0);
  });

  it("400s an invalid payload", async () => {
    expect((await post({ ...VALID, rating: 5 })).status).toBe(400);
    expect(fixture.upserts).toHaveLength(0);
  });

  it("MISS: stores the client text with message_id null (the unverified flag)", async () => {
    fixture.conversation = null; // no session conversation yet (log raced)
    const res = await post({ ...VALID, rating: -1, reason: "meh" });
    expect(res.status).toBe(200);
    expect(fixture.upserts).toHaveLength(1);
    const { row, opts } = fixture.upserts[0]!;
    expect(opts).toEqual({ onConflict: "dedup_key" });
    expect(row).toMatchObject({
      dedup_key: `pub:${VALID.session_key}:turn-1`,
      surface: "public",
      conversation_id: null,
      message_id: null,
      public_session_key: VALID.session_key,
      client_turn_id: "turn-1",
      rating: -1,
      reason: "meh",
      question_text: VALID.question,
      answer_text: VALID.answer,
    });
  });

  it("HIT: snapshots come FROM THE MATCHED DB ROWS, not the client probe (F3)", async () => {
    fixture.conversation = { id: "conv-9" };
    fixture.messages = [
      { id: "m-a", role: "assistant", content: "the aether one", created_at: "2026-07-21T10:00:00Z", model: "claude-x" },
      { id: "m-u", role: "user", content: "DB question text", created_at: "2026-07-21T10:00:00Z" },
    ];
    // Client sends a DIFFERENT question probe than what was logged.
    const res = await post({ ...VALID, question: "client probe question" });
    expect(res.status).toBe(200);
    const { row } = fixture.upserts[0]!;
    expect(row).toMatchObject({
      conversation_id: "conv-9",
      message_id: "m-a",
      question_text: "DB question text", // from the DB, not the probe
      answer_text: "the aether one",
      model: "claude-x",
    });
  });

  it("drops the reason on a thumbs-up (F14)", async () => {
    const res = await post({ ...VALID, rating: 1, reason: "should vanish" });
    expect(res.status).toBe(200);
    expect(fixture.upserts[0]!.row.reason).toBeNull();
  });
});
