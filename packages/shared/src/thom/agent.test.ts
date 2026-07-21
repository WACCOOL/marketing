import { describe, expect, it } from "vitest";
import type { ThomEnv } from "./env.js";
import type { ClaudeStreamEvent, ClaudeUsage } from "./transport.js";
import {
  reconstructTurn,
  shouldEscalate,
  SUPERLATIVE_INTENT,
  tieringEnabled,
  type EscalationState,
} from "./agent.js";

const usage = (over: Partial<ClaudeUsage> = {}): ClaudeUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  ...over,
});

const state = (over: Partial<EscalationState> = {}): EscalationState => ({
  toolCallCount: 0,
  docPassageCount: 0,
  productCount: 0,
  userMessage: "",
  ...over,
});

describe("shouldEscalate", () => {
  it("stays on the router for a greeting with no tool activity", () => {
    expect(shouldEscalate(state({ userMessage: "hey there" }))).toBe(false);
  });

  it("stays on the router for a single simple lookup", () => {
    expect(
      shouldEscalate(
        state({ toolCallCount: 1, productCount: 1, userMessage: "specs for the 3011?" }),
      ),
    ).toBe(false);
  });

  it("escalates on multi-doc synthesis (2+ passages)", () => {
    expect(shouldEscalate(state({ docPassageCount: 2 }))).toBe(true);
  });

  it("escalates on multi-product work (2+ cards)", () => {
    expect(shouldEscalate(state({ productCount: 2 }))).toBe(true);
  });

  it("escalates on a long tool chain (3+ calls)", () => {
    expect(shouldEscalate(state({ toolCallCount: 3 }))).toBe(true);
  });

  it("escalates a comparison once there is a tool result to compare", () => {
    expect(
      shouldEscalate(
        state({ toolCallCount: 1, userMessage: "compare the 3011 vs 3021" }),
      ),
    ).toBe(true);
  });

  it("does NOT escalate comparison intent before any tool has run (gated)", () => {
    expect(
      shouldEscalate(state({ toolCallCount: 0, userMessage: "compare the 3011 vs 3021" })),
    ).toBe(false);
  });

  it("does NOT over-match a plain 'X or Y?' question", () => {
    expect(
      shouldEscalate(
        state({ toolCallCount: 1, userMessage: "Do you have downlights or track heads?" }),
      ),
    ).toBe(false);
  });

  it("escalates a superlative IMMEDIATELY, at zero tool calls", () => {
    // Unlike comparisons, superlatives must never let the router model field
    // the failing turn (the tape-as-runner-up failure).
    for (const msg of [
      "what's the highest lumen light you make?",
      "brightest downlight?",
      "most efficient track head",
      "which fixture has the maximum output?",
      "lowest wattage sconce for a hallway",
      "best efficacy in the catalog",
    ]) {
      expect(shouldEscalate(state({ toolCallCount: 0, userMessage: msg }))).toBe(true);
    }
  });

  it("SUPERLATIVE_INTENT stays tight: ordinary product questions don't match", () => {
    for (const msg of [
      "specs for the 3011?",
      "do you have outdoor track lighting?",
      "what's the best way to light a kitchen island?",
      "is the high output tape dimmable?",
    ]) {
      expect(SUPERLATIVE_INTENT.test(msg)).toBe(false);
    }
  });
});

describe("tieringEnabled", () => {
  it("is on when unset (default)", () => {
    expect(tieringEnabled({} as ThomEnv)).toBe(true);
  });
  it("is on when explicitly \"1\"", () => {
    expect(tieringEnabled({ THOM_TIERING: "1" } as ThomEnv)).toBe(true);
  });
  it("is off when explicitly \"0\" (safe rollback)", () => {
    expect(tieringEnabled({ THOM_TIERING: "0" } as ThomEnv)).toBe(false);
  });
});

describe("reconstructTurn", () => {
  it("interleaves text and a tool_use whose input_json_delta is split across chunks", () => {
    const events: ClaudeStreamEvent[] = [
      { type: "text", text: "Let me " },
      { type: "text", text: "look that up. " },
      { type: "block_stop", index: 0 }, // text block ends
      { type: "tool_use_start", index: 1, id: "toolu_1", name: "get_product" },
      { type: "tool_input_delta", index: 1, partial_json: '{"sku":' },
      { type: "tool_input_delta", index: 1, partial_json: '"2095"}' },
      { type: "block_stop", index: 1 },
      { type: "done", stopReason: "tool_use", usage: usage({ input_tokens: 10, output_tokens: 5 }) },
    ];
    const { content, text, stopReason, usage: u } = reconstructTurn(events);
    expect(text).toBe("Let me look that up. ");
    expect(stopReason).toBe("tool_use");
    expect(u).toEqual(usage({ input_tokens: 10, output_tokens: 5 }));
    expect(content).toEqual([
      { type: "text", text: "Let me look that up. " },
      { type: "tool_use", id: "toolu_1", name: "get_product", input: { sku: "2095" } },
    ]);
  });

  it("defaults a tool_use input to {} when no input_json_delta arrived", () => {
    const events: ClaudeStreamEvent[] = [
      { type: "tool_use_start", index: 0, id: "toolu_2", name: "list_families" },
      { type: "block_stop", index: 0 },
      { type: "done", stopReason: "tool_use", usage: null },
    ];
    const { content } = reconstructTurn(events);
    expect(content).toEqual([
      { type: "tool_use", id: "toolu_2", name: "list_families", input: {} },
    ]);
  });

  it("reconstructs a server_tool_use + web_search_tool_result into history", () => {
    const events: ClaudeStreamEvent[] = [
      { type: "server_tool_use_start", index: 0, id: "srvtoolu_1", name: "web_search" },
      { type: "tool_input_delta", index: 0, partial_json: '{"query":"WAC 2095"}' },
      { type: "block_stop", index: 0 },
      {
        type: "web_search_result",
        index: 1,
        content: {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [
            { type: "web_search_result", url: "https://a.example/spec", title: "A spec" },
          ],
        },
      },
      { type: "block_stop", index: 1 },
      { type: "text", text: "Based on the web…" },
      { type: "block_stop", index: 2 },
      { type: "done", stopReason: "end_turn", usage: usage({ output_tokens: 3 }) },
    ];
    const { content, text } = reconstructTurn(events);
    expect(text).toBe("Based on the web…");
    expect(content).toEqual([
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "WAC 2095" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [{ type: "web_search_result", url: "https://a.example/spec", title: "A spec" }],
      },
      { type: "text", text: "Based on the web…" },
    ]);
  });

  it("captures the pause_turn stop reason", () => {
    const events: ClaudeStreamEvent[] = [
      { type: "server_tool_use_start", index: 0, id: "srvtoolu_2", name: "web_search" },
      { type: "tool_input_delta", index: 0, partial_json: '{"query":"x"}' },
      { type: "block_stop", index: 0 },
      { type: "done", stopReason: "pause_turn", usage: null },
    ];
    const { stopReason, content } = reconstructTurn(events);
    expect(stopReason).toBe("pause_turn");
    expect(content).toEqual([
      { type: "server_tool_use", id: "srvtoolu_2", name: "web_search", input: { query: "x" } },
    ]);
  });

  it("concatenates plain text with no tool blocks", () => {
    const events: ClaudeStreamEvent[] = [
      { type: "text", text: "Hello" },
      { type: "text", text: ", world" },
      { type: "done", stopReason: "end_turn", usage: null },
    ];
    const { content, text } = reconstructTurn(events);
    expect(text).toBe("Hello, world");
    expect(content).toEqual([{ type: "text", text: "Hello, world" }]);
  });
});
