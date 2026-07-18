import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ThomEnv } from "./env.js";
import type { ClaudeStreamEvent } from "./transport.js";
import { GUARDRAIL_TEMPLATE } from "./publicFilter.js";

// Mutable script for the mocked stream (vi.hoisted so the mock factory can see it).
const h = vi.hoisted(() => ({ events: [] as ClaudeStreamEvent[] }));

// Mock ONLY claudeMessagesStream; keep every other transport export real (model
// helpers, claudeMessages, wire types). runThomStream drives this generator.
vi.mock("./transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transport.js")>();
  return {
    ...actual,
    claudeMessagesStream: async function* () {
      for (const ev of h.events) yield ev;
    },
  };
});

// Imported AFTER the mock is registered.
const { runThomStream } = await import("./agent.js");

// ANTHROPIC unset → makeHaikuJudge returns undefined → screen is denylist-only
// (no judge network call). AI unused: no client-tool dispatch in these scripts.
const env = {} as ThomEnv;
const sb = {} as SupabaseClient;

async function drain(gen: AsyncGenerator<{ type: string; text?: string }>) {
  const out: { type: string; text?: string }[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}
const textsOf = (out: { type: string; text?: string }[]) =>
  out.filter((e) => e.type === "text").map((e) => e.text ?? "");
const finalOf = (out: { type: string; text?: string }[]) => out.find((e) => e.type === "final");

const done = (stopReason = "end_turn"): ClaudeStreamEvent => ({ type: "done", stopReason, usage: null });

describe("runThomStream — PUBLIC guardrails", () => {
  it("REPLACES a web_search turn that names a competitor with the guardrail template", async () => {
    h.events = [
      { type: "server_tool_use_start", index: 0, id: "s1", name: "web_search" },
      { type: "tool_input_delta", index: 0, partial_json: '{"query":"600W dimmer"}' },
      { type: "block_stop", index: 0 },
      {
        type: "web_search_result",
        index: 1,
        content: {
          type: "web_search_tool_result",
          tool_use_id: "s1",
          content: [{ type: "web_search_result", url: "https://x.example/d", title: "Dimmer" }],
        },
      },
      { type: "block_stop", index: 1 },
      { type: "text", text: "Based on the web, a Lutron Diva rated 600W would work here." },
      { type: "block_stop", index: 2 },
      done(),
    ];

    const out = await drain(
      runThomStream(env, sb, { userMessage: "something like a Lutron Diva?", history: [], surface: "public" }),
    );

    // Raw competitor text is NEVER emitted; the answer is the template only.
    expect(textsOf(out)).toEqual([GUARDRAIL_TEMPLATE]);
    expect(finalOf(out)?.text).toBe(GUARDRAIL_TEMPLATE);
    expect(out.some((e) => (e.text ?? "").includes("Lutron"))).toBe(false);
  });

  it("streams a NON-web public turn buffered + copy-normalized (em dash + bare WAC fixed)", async () => {
    h.events = [
      { type: "text", text: "Made by WAC — a great choice." },
      { type: "block_stop", index: 0 },
      done(),
    ];

    const out = await drain(
      runThomStream(env, sb, { userMessage: "who makes it?", history: [], surface: "public" }),
    );

    expect(textsOf(out)).toEqual(["Made by WAC Group, a great choice."]);
    expect(finalOf(out)?.text).toBe("Made by WAC Group, a great choice.");
    // No raw em dash or bare-WAC token ever reached the client.
    expect(out.every((e) => !(e.text ?? "").includes("—"))).toBe(true);
    expect(out.every((e) => !/\bWAC\b(?! Group)/.test(e.text ?? ""))).toBe(true);
  });
});

describe("runThomStream — INTERNAL is unaffected (parity)", () => {
  it("streams raw tokens live and does NOT normalize or screen", async () => {
    h.events = [
      { type: "text", text: "Raw — WAC text, Lutron included." },
      { type: "block_stop", index: 0 },
      done(),
    ];

    // default surface is internal
    const out = await drain(runThomStream(env, sb, { userMessage: "hi", history: [] }));

    const texts = textsOf(out);
    // The live token is forwarded verbatim (un-normalized, un-screened).
    expect(texts).toContain("Raw — WAC text, Lutron included.");
    expect(finalOf(out)?.text).toBe("Raw — WAC text, Lutron included.");
  });
});
