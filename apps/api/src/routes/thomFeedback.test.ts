import { describe, expect, it, vi } from "vitest";
import {
  applyInternalFeedback,
  loadConversationTurns,
  type InternalFeedbackDb,
} from "./thom.js";

/**
 * Internal feedback route logic (plan B.1.3) against an in-memory
 * InternalFeedbackDb: owner-scoping, non-assistant reject, server-side
 * snapshots (incl. the F10 equal-timestamp case), and upsert-flip semantics
 * keyed by dedup_key.
 */

interface Msg {
  id: string;
  conversation_id: string;
  role: string;
  content: string | null;
  created_at: string;
  model: string | null;
}

function memoryDb(opts: {
  messages: Msg[];
  owners: Record<string, { user_id: string | null }>;
  upsertError?: string;
}) {
  // dedup_key → row: mirrors the 0062 UNIQUE(dedup_key) upsert semantics.
  const store = new Map<string, Record<string, unknown>>();
  const db: InternalFeedbackDb = {
    getMessage: async (id) => {
      const m = opts.messages.find((x) => x.id === id);
      return m ? { ...m } : null;
    },
    getConversationOwner: async (cid) => opts.owners[cid] ?? null,
    getUserRows: async (cid) =>
      opts.messages
        .filter((m) => m.conversation_id === cid && m.role === "user")
        .map((m) => ({ content: m.content, created_at: m.created_at })),
    upsertFeedback: async (row) => {
      if (opts.upsertError) return { error: { message: opts.upsertError } };
      const key = row.dedup_key as string;
      store.set(key, { ...(store.get(key) ?? {}), ...row });
      return { error: null };
    },
  };
  return { db, store };
}

const T = "2026-07-21T12:00:00.000Z";
const BASE: Msg[] = [
  { id: "u1", conversation_id: "c1", role: "user", content: "the question", created_at: T, model: null },
  { id: "a1", conversation_id: "c1", role: "assistant", content: "the answer", created_at: T, model: "claude-x" },
];
const OWNERS = { c1: { user_id: "me" } };

describe("applyInternalFeedback", () => {
  it("404s when the message belongs to someone else's conversation (owner-scoping)", async () => {
    const { db, store } = memoryDb({ messages: BASE, owners: { c1: { user_id: "someone-else" } } });
    const res = await applyInternalFeedback(db, "me", { messageId: "a1", rating: 1 });
    expect(res.status).toBe(404);
    expect(store.size).toBe(0);
  });

  it("404s on a missing message or missing conversation", async () => {
    const { db } = memoryDb({ messages: BASE, owners: {} });
    expect((await applyInternalFeedback(db, "me", { messageId: "nope", rating: 1 })).status).toBe(404);
    expect((await applyInternalFeedback(db, "me", { messageId: "a1", rating: 1 })).status).toBe(404);
  });

  it("rejects non-assistant rows", async () => {
    const { db, store } = memoryDb({ messages: BASE, owners: OWNERS });
    const res = await applyInternalFeedback(db, "me", { messageId: "u1", rating: 1 });
    expect(res.status).toBe(400);
    expect(store.size).toBe(0);
  });

  it("snapshots server-side: answer = message content, question = nearest prior user row", async () => {
    const msgs: Msg[] = [
      { id: "u0", conversation_id: "c1", role: "user", content: "old question", created_at: "2026-07-21T11:00:00.000Z", model: null },
      { id: "a0", conversation_id: "c1", role: "assistant", content: "old answer", created_at: "2026-07-21T11:00:01.000Z", model: null },
      ...BASE,
    ];
    const { db, store } = memoryDb({ messages: msgs, owners: OWNERS });
    const res = await applyInternalFeedback(db, "me", { messageId: "a1", rating: 1 });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    const row = store.get("msg:a1");
    expect(row).toMatchObject({
      dedup_key: "msg:a1",
      surface: "internal",
      message_id: "a1",
      conversation_id: "c1",
      user_id: "me",
      rating: 1,
      reason: null,
      question_text: "the question",
      answer_text: "the answer",
      model: "claude-x",
    });
  });

  it("resolves the question when user and assistant rows share ONE created_at (the `<=`, F10)", async () => {
    // logTurn inserts both rows in a single statement → identical timestamps.
    const { db, store } = memoryDb({ messages: BASE, owners: OWNERS });
    await applyInternalFeedback(db, "me", { messageId: "a1", rating: -1 });
    expect(store.get("msg:a1")?.question_text).toBe("the question");
  });

  it("upsert flip up→down→up keeps ONE row via dedup_key and nulls the reason on flip-to-up", async () => {
    const { db, store } = memoryDb({ messages: BASE, owners: OWNERS });
    await applyInternalFeedback(db, "me", { messageId: "a1", rating: 1 });
    await applyInternalFeedback(db, "me", { messageId: "a1", rating: -1, reason: "missed the CRI" });
    expect(store.size).toBe(1);
    expect(store.get("msg:a1")).toMatchObject({ rating: -1, reason: "missed the CRI" });
    await applyInternalFeedback(db, "me", { messageId: "a1", rating: 1 });
    expect(store.size).toBe(1);
    // Reason nulled on the flip (also DB-enforced by the 0062 F14 check).
    expect(store.get("msg:a1")).toMatchObject({ rating: 1, reason: null });
  });

  it("ignores a reason sent WITH a thumbs-up (F14 posture)", async () => {
    const { db, store } = memoryDb({ messages: BASE, owners: OWNERS });
    await applyInternalFeedback(db, "me", { messageId: "a1", rating: 1, reason: "should vanish" });
    expect(store.get("msg:a1")?.reason).toBeNull();
  });

  it("surfaces upsert failures as 500", async () => {
    const { db } = memoryDb({ messages: BASE, owners: OWNERS, upsertError: "boom" });
    const res = await applyInternalFeedback(db, "me", { messageId: "a1", rating: 1 });
    expect(res.status).toBe(500);
  });
});

describe("loadConversationTurns (reload path)", () => {
  const rows = [
    { id: "u1", role: "user", content: "q" },
    { id: "a1", role: "assistant", content: "a" },
  ];

  it("runs the owner check FIRST — a failed check issues NO feedback query (F6)", async () => {
    const getFeedback = vi.fn(async () => new Map<string, 1 | -1>());
    const getMessages = vi.fn(async () => rows);
    const res = await loadConversationTurns({
      getOwned: async () => false,
      getMessages,
      getFeedback,
    });
    expect(res).toEqual({ notFound: true });
    expect(getFeedback).not.toHaveBeenCalled();
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("swallows a failing feedback join and still returns the conversation (F11)", async () => {
    const res = await loadConversationTurns({
      getOwned: async () => true,
      getMessages: async () => rows,
      getFeedback: async () => {
        throw new Error("relation thom_feedback does not exist");
      },
    });
    expect("turns" in res && res.turns).toHaveLength(2);
    if ("turns" in res) {
      expect(res.turns[1]).toMatchObject({ role: "assistant", messageId: "a1" });
      expect(res.turns[1]?.feedback).toBeUndefined();
    }
  });

  it("attaches existing votes to their assistant turns", async () => {
    const res = await loadConversationTurns({
      getOwned: async () => true,
      getMessages: async () => rows,
      getFeedback: async () => new Map<string, 1 | -1>([["a1", -1]]),
    });
    if ("turns" in res) {
      expect(res.turns[1]).toMatchObject({ role: "assistant", messageId: "a1", feedback: -1 });
    } else {
      throw new Error("expected turns");
    }
  });
});
