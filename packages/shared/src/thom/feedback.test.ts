import { describe, expect, it } from "vitest";
import {
  internalFeedbackDedupKey,
  isUnverifiedFeedback,
  matchFeedbackTurn,
  pickQuestionText,
  publicFeedbackDedupKey,
  showFeedbackRow,
} from "./feedback.js";

describe("dedup_key derivation", () => {
  it("internal rows use the msg: prefix", () => {
    expect(internalFeedbackDedupKey("abc-123")).toBe("msg:abc-123");
  });

  it("public rows use pub:<sessionKey>:<clientTurnId>", () => {
    expect(publicFeedbackDedupKey("deadbeef", "turn-1")).toBe("pub:deadbeef:turn-1");
  });

  it("keys never collide across prefixes", () => {
    expect(internalFeedbackDedupKey("x")).not.toBe(publicFeedbackDedupKey("x", "x"));
  });
});

describe("showFeedbackRow (vote-state rule)", () => {
  it("shows for a completed, id'd, non-error assistant turn", () => {
    expect(showFeedbackRow({ role: "assistant", id: "m1" })).toBe(true);
  });

  it("hides for user turns", () => {
    expect(showFeedbackRow({ role: "user", id: "m1" })).toBe(false);
  });

  it("hides while streaming", () => {
    expect(showFeedbackRow({ role: "assistant", id: "m1", streaming: true })).toBe(false);
  });

  it("hides on error turns", () => {
    expect(showFeedbackRow({ role: "assistant", id: "m1", error: true })).toBe(false);
  });

  it("hides when there is no rating key (old transcripts)", () => {
    expect(showFeedbackRow({ role: "assistant" })).toBe(false);
    expect(showFeedbackRow({ role: "assistant", id: null })).toBe(false);
    expect(showFeedbackRow({ role: "assistant", id: "" })).toBe(false);
  });
});

describe("isUnverifiedFeedback (analytics badge rule)", () => {
  it("is unverified iff public AND message_id null", () => {
    expect(isUnverifiedFeedback({ surface: "public", message_id: null })).toBe(true);
    expect(isUnverifiedFeedback({ surface: "public", message_id: "m1" })).toBe(false);
    // Internal rows stay verified even if message_id was nulled by a delete.
    expect(isUnverifiedFeedback({ surface: "internal", message_id: null })).toBe(false);
    expect(isUnverifiedFeedback({ surface: "internal", message_id: "m1" })).toBe(false);
  });
});

describe("pickQuestionText", () => {
  const T0 = "2026-07-21T12:00:00.000Z";
  const T1 = "2026-07-21T12:01:00.000Z";
  const T2 = "2026-07-21T12:02:00.000Z";

  it("picks the nearest prior user row", () => {
    const rows = [
      { content: "first q", created_at: T0 },
      { content: "second q", created_at: T1 },
    ];
    expect(pickQuestionText(rows, T2)).toBe("second q");
  });

  it("EQUAL timestamps still resolve (the `<=`, F10)", () => {
    // logTurn inserts user + assistant in one statement, so the user row's
    // created_at can equal the assistant row's — a strict `<` would miss it.
    const rows = [{ content: "same-instant q", created_at: T1 }];
    expect(pickQuestionText(rows, T1)).toBe("same-instant q");
  });

  it("ignores user rows AFTER the assistant row", () => {
    const rows = [
      { content: "before", created_at: T0 },
      { content: "after", created_at: T2 },
    ];
    expect(pickQuestionText(rows, T1)).toBe("before");
  });

  it("returns null when nothing qualifies", () => {
    expect(pickQuestionText([], T1)).toBeNull();
    expect(pickQuestionText([{ content: null, created_at: T0 }], T1)).toBeNull();
  });
});

describe("matchFeedbackTurn", () => {
  const msgs = [
    { id: "u1", role: "user", content: "q1", created_at: "2026-07-21T10:00:00Z" },
    { id: "a1", role: "assistant", content: "answer one", created_at: "2026-07-21T10:00:00Z", model: "claude-x" },
    { id: "u2", role: "user", content: "q2", created_at: "2026-07-21T10:05:00Z" },
    { id: "a2", role: "assistant", content: "answer two", created_at: "2026-07-21T10:05:00Z" },
  ];

  it("matches the assistant row by exact content and snapshots FROM THE DB ROWS", () => {
    const match = matchFeedbackTurn(msgs, "answer one");
    expect(match).not.toBeNull();
    expect(match?.messageId).toBe("a1");
    expect(match?.answerText).toBe("answer one");
    // Equal-timestamp user row resolves (the `<=` again).
    expect(match?.questionText).toBe("q1");
    expect(match?.model).toBe("claude-x");
  });

  it("prefers the MOST RECENT assistant row on duplicate content", () => {
    const dup = [
      ...msgs,
      { id: "a3", role: "assistant", content: "answer one", created_at: "2026-07-21T10:10:00Z" },
    ];
    expect(matchFeedbackTurn(dup, "answer one")?.messageId).toBe("a3");
  });

  it("returns null on a miss (feedback raced the turn log)", () => {
    expect(matchFeedbackTurn(msgs, "never logged")).toBeNull();
    expect(matchFeedbackTurn([], "answer one")).toBeNull();
  });
});
