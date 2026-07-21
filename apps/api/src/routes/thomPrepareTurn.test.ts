import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * prepareTurn ownership gate (F5, shipped in #224 — these tests pin it): a
 * client-supplied conversationId is loaded with the SERVICE client (bypasses
 * RLS), so the conversation must be verified as the caller's own BEFORE any
 * history is read. Foreign conversation → 404, own → history loads.
 */

// --- fake supabase -------------------------------------------------------------

interface Fixture {
  /** thom_conversations ownership probe result (null = not owned/absent). */
  owned: { id: string } | null;
  /** thom_messages history rows. */
  messages: { role: string; content: string | null }[];
  /** Recorded reads so we can assert "no history load on a foreign id". */
  reads: string[];
}

const fixture: Fixture = { owned: null, messages: [], reads: [] };

function fakeBuilder(table: string) {
  const b: Record<string, unknown> = {};
  const chain = () => b;
  for (const m of ["select", "eq", "gte", "in", "order", "limit", "insert", "single"]) {
    b[m] = table === "thom_conversations" && m === "single"
      ? async () => ({ data: { id: "new-conv" }, error: null })
      : chain;
  }
  b.maybeSingle = async () => {
    fixture.reads.push(`${table}.maybeSingle`);
    return { data: fixture.owned, error: null };
  };
  // Thenable: `await builder` resolves the list query (history read).
  b.then = (resolve: (r: unknown) => void) => {
    fixture.reads.push(`${table}.list`);
    resolve({ data: fixture.messages, error: null });
  };
  return b;
}

vi.mock("../supabase.js", () => ({
  serviceSupabase: () => ({ from: (t: string) => fakeBuilder(t) }),
  userSupabase: () => ({ from: (t: string) => fakeBuilder(t) }),
}));

import { prepareTurn } from "./thom.js";

// --- fake hono context ----------------------------------------------------------

function fakeCtx(body: Record<string, unknown>) {
  return {
    get: (key: string) =>
      key === "user" ? { id: "me", role: "internal" } : key === "jwt" ? "jwt" : undefined,
    env: { ANTHROPIC_API_KEY: "test-key", SUPABASE_URL: "http://x", SUPABASE_SERVICE_ROLE_KEY: "y" },
    req: { json: async () => body },
    json: (payload: unknown, status?: number) => ({ payload, status: status ?? 200 }),
  } as never;
}

beforeEach(() => {
  fixture.owned = null;
  fixture.messages = [];
  fixture.reads = [];
});

describe("prepareTurn ownership gate (F5)", () => {
  it("404s a conversationId the caller does not own — BEFORE any history load", async () => {
    fixture.owned = null; // ownership probe misses (foreign or absent id)
    const res = await prepareTurn(fakeCtx({ message: "hi", conversationId: "foreign-conv" }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect((res.res as unknown as { status: number }).status).toBe(404);
    }
    // The ownership probe ran; the history list read did NOT.
    expect(fixture.reads).toContain("thom_conversations.maybeSingle");
    expect(fixture.reads).not.toContain("thom_messages.list");
  });

  it("loads history for the caller's own conversation", async () => {
    fixture.owned = { id: "my-conv" };
    fixture.messages = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ];
    const res = await prepareTurn(fakeCtx({ message: "hi", conversationId: "my-conv" }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.conversationId).toBe("my-conv");
      // History rows arrive newest-first from the query and are reversed.
      expect(res.history).toEqual([
        { role: "assistant", content: "a1" },
        { role: "user", content: "q1" },
      ]);
    }
  });
});
