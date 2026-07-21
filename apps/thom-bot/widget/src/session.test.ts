import { describe, it, expect } from "vitest";
import {
  boundTurns,
  clearHistory,
  getSessionId,
  historyKey,
  loadHistory,
  randomId,
  saveHistory,
  toRequestHistory,
  MAX_HISTORY_TURNS,
  type StorageLike,
} from "./session.js";
import type { Turn } from "./types.js";

/** In-memory Storage mock so these stay pure (no jsdom / localStorage). */
function mockStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("session history", () => {
  it("round-trips a transcript through storage", () => {
    const s = mockStorage();
    const turns: Turn[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ];
    saveHistory("site1", "sess1", turns, s);
    expect(loadHistory("site1", "sess1", s)).toEqual(turns);
  });

  it("clears / removes the key on empty save and clearHistory", () => {
    const s = mockStorage();
    saveHistory("site1", "sess1", [{ role: "user", text: "x" }], s);
    saveHistory("site1", "sess1", [], s);
    expect(loadHistory("site1", "sess1", s)).toEqual([]);
    saveHistory("site1", "sess1", [{ role: "user", text: "y" }], s);
    clearHistory("site1", "sess1", s);
    expect(s.map.has(historyKey("site1", "sess1"))).toBe(false);
  });

  it("returns [] for missing or corrupt data", () => {
    const s = mockStorage();
    expect(loadHistory("nope", "nope", s)).toEqual([]);
    s.setItem(historyKey("site1", "sess1"), "{not json");
    expect(loadHistory("site1", "sess1", s)).toEqual([]);
  });

  it("bounds to the most recent MAX_HISTORY_TURNS*2 messages", () => {
    const many: Turn[] = Array.from({ length: MAX_HISTORY_TURNS * 2 + 6 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `m${i}`,
    }));
    expect(boundTurns(many)).toHaveLength(MAX_HISTORY_TURNS * 2);
    expect(boundTurns(many)[0]?.text).toBe("m6");
  });

  it("toRequestHistory drops empty + errored turns and keeps {role,content}", () => {
    const turns: Turn[] = [
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "q2" },
      { role: "assistant", text: "", }, // in-progress, dropped
      { role: "assistant", text: "boom", error: true }, // errored, dropped
    ];
    expect(toRequestHistory(turns)).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
  });

  it("getSessionId mints once then persists", () => {
    const s = mockStorage();
    const a = getSessionId("site1", s);
    const b = getSessionId("site1", s);
    expect(a).toBe(b);
    expect(a).toBeTruthy();
  });

  it("round-trips turnId + feedback through storage (votes survive reopen)", () => {
    const s = mockStorage();
    const turns: Turn[] = [
      { role: "user", text: "q" },
      { role: "assistant", text: "a", turnId: "turn-xyz", feedback: -1 },
    ];
    saveHistory("site1", "sess1", turns, s);
    const loaded = loadHistory("site1", "sess1", s);
    expect(loaded[1]).toMatchObject({ role: "assistant", turnId: "turn-xyz", feedback: -1 });
  });

  it("toRequestHistory strips turnId/feedback down to {role, content}", () => {
    const turns: Turn[] = [
      { role: "user", text: "q" },
      { role: "assistant", text: "a", turnId: "turn-xyz", feedback: 1 },
    ];
    expect(toRequestHistory(turns)).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
  });

  it("randomId mints non-empty, distinct ids (the client_turn_id source)", () => {
    const a = randomId();
    const b = randomId();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(64); // bridge zod cap on client_turn_id
  });
});
