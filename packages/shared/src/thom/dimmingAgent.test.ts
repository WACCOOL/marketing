// =============================================================================
// Dimming flag + guardrail-survival tests (plan §F, DC3):
//  - THOM_DIMMING composes the tools + prompt bullets on BOTH surfaces; off =>
//    not advertised AND the bullets absent (the R3 rule).
//  - PUBLIC allow-list carries both tools; dispatch flag-off routing works.
//  - A dimming answer that names Lutron SURVIVES the public filter.
//  - A MIXED dimming+web_search turn is NOT replaced by the competitor screen
//    (screenCompetitorsSync would otherwise nuke the whole chart answer).
//  - Prompt copy lints: the dimming bullets pass normalizeCopy unchanged.
// =============================================================================
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ThomEnv } from "./env.js";
import type { ClaudeStreamEvent } from "./transport.js";

// Script QUEUE (one entry per claudeMessagesStream call) so multi-step turns
// (tool dispatch -> second stream turn) can be scripted.
const h = vi.hoisted(() => ({ scripts: [] as ClaudeStreamEvent[][] }));

vi.mock("./transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transport.js")>();
  return {
    ...actual,
    claudeMessagesStream: async function* () {
      const events = h.scripts.shift() ?? [];
      for (const ev of events) yield ev;
    },
  };
});

const { composeTools, dimmingEnabled, runThomStream, usedDimmingTools } = await import("./agent.js");
const { compatibilityGuidance, systemFor } = await import("./prompts.js");
const { GUARDRAIL_TEMPLATE, hasBareWac, normalizeCopy, screenCompetitorsSync } = await import(
  "./publicFilter.js"
);
const { DIMMING_TOOL_NAMES } = await import("./dimmingTools.js");
const { dispatch, PUBLIC_TOOL_NAMES } = await import("./tools.js");

const OFF = {} as ThomEnv;
const ON = { THOM_DIMMING: "1" } as ThomEnv;

// A permissive fake sb: any query chain resolves to empty data. Tool calls in
// the agent tests only need to not throw — the survival property under test is
// about the SCREEN, not the tool output.
function emptySb(): SupabaseClient {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  for (const m of ["select", "eq", "neq", "in", "ilike", "contains", "limit", "order", "range"]) {
    q[m] = chain;
  }
  q.maybeSingle = () => Promise.resolve({ data: null, error: null });
  q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
  return { from: () => q } as unknown as SupabaseClient;
}

async function drain(gen: AsyncGenerator<{ type: string; text?: string }>) {
  const out: { type: string; text?: string }[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}
const finalOf = (out: { type: string; text?: string }[]) => out.find((e) => e.type === "final");
const done = (stopReason = "end_turn"): ClaudeStreamEvent => ({ type: "done", stopReason, usage: null });

// --- flag composition (both surfaces) ----------------------------------------

describe("THOM_DIMMING composition", () => {
  it("flag off: tools not advertised, prompt bullets absent, search_docs bullet present", () => {
    expect(dimmingEnabled(OFF)).toBe(false);
    for (const surface of ["internal", "public"] as const) {
      const names = composeTools(surface, OFF).map((t) => t.name);
      expect(names).not.toContain("check_dimmer_compatibility");
      expect(names).not.toContain("find_products_for_dimmer");
      // (surface, specRank, specFilter, categorySales, dimming)
      const sys = systemFor(surface, false, false, false, false)
        .map((b) => b.text)
        .join("\n");
      expect(sys).not.toContain("check_dimmer_compatibility");
      expect(sys).toMatch(/Dimmer compatibility:.*search_docs/);
    }
  });

  it("flag on: tools advertised on BOTH surfaces + bullets composed, search_docs dimmer bullet superseded", () => {
    expect(dimmingEnabled(ON)).toBe(true);
    for (const surface of ["internal", "public"] as const) {
      const names = composeTools(surface, ON).map((t) => t.name);
      expect(names).toContain("check_dimmer_compatibility");
      expect(names).toContain("find_products_for_dimmer");
      // (surface, specRank, specFilter, categorySales, dimming)
      const sys = systemFor(surface, false, false, false, true)
        .map((b) => b.text)
        .join("\n");
      expect(sys).toContain("check_dimmer_compatibility");
      expect(sys).toContain("tested references, not competitors");
      expect(sys).not.toMatch(/Dimmer compatibility:.*search_docs and cite/);
    }
  });

  it("keeps the tail cache breakpoint on the last tool", () => {
    const tools = composeTools("public", ON);
    const cached = tools.filter((t) => t.cache_control);
    expect(cached).toHaveLength(1);
    expect(tools[tools.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("both names are on the PUBLIC allow-list", () => {
    expect(PUBLIC_TOOL_NAMES.has("check_dimmer_compatibility")).toBe(true);
    expect(PUBLIC_TOOL_NAMES.has("find_products_for_dimmer")).toBe(true);
  });

  it("dispatch routes the dimming tools (and the public hard-reject still guards unknown names)", async () => {
    const ctx = { env: ON, sb: emptySb() };
    const out = await dispatch(ctx, "check_dimmer_compatibility", { product: "X" }, { surface: "public" });
    expect(out.content).toBeTruthy();
    const rejected = await dispatch(ctx, "crm_search_companies", {}, { surface: "public" });
    expect(rejected.content).toContain("not available");
  });

  it("usedDimmingTools keys on the tool names", () => {
    expect(usedDimmingTools([{ name: "check_dimmer_compatibility" }])).toBe(true);
    expect(usedDimmingTools([{ name: "search_products" }])).toBe(false);
    expect([...DIMMING_TOOL_NAMES]).toHaveLength(2);
  });
});

// --- prompt copy lints --------------------------------------------------------

describe("dimming prompt copy lints", () => {
  it("passes normalizeCopy unchanged on both surfaces (public copy rules)", () => {
    for (const surface of ["internal", "public"] as const) {
      for (const hasDimming of [false, true]) {
        const text = compatibilityGuidance(surface, hasDimming);
        expect(normalizeCopy(text)).toBe(text);
        expect(text).not.toContain("—");
        expect(hasBareWac(text)).toBe(false);
      }
    }
  });

  it("carries the load-bearing dimming anchors when composed", () => {
    const text = compatibilityGuidance("public", true);
    expect(text).toContain("NEVER answer dimmer compatibility from memory");
    expect(text).toContain("phase mode");
    expect(text).toContain("tested references, not competitors");
    expect(text).toContain("single-fixture test");
    expect(text).toMatch(/Absence of a chart row is never "not compatible"/);
  });
});

// --- DC3: guardrail survival --------------------------------------------------

describe("DC3 — competitor guardrail carve-out", () => {
  it("sanity: the raw sync screen WOULD nuke a Lutron-naming answer (why the carve-out exists)", () => {
    const screened = screenCompetitorsSync("Lutron DVCL-153PD: Not Recommended per the chart.");
    expect(screened.flagged).toBe(true);
    expect(screened.text).toBe(GUARDRAIL_TEMPLATE);
  });

  it("a PUBLIC dimming answer naming Lutron SURVIVES (no web_search, no screen)", async () => {
    h.scripts = [
      [
        { type: "tool_use_start", index: 0, id: "t1", name: "check_dimmer_compatibility" },
        { type: "tool_input_delta", index: 0, partial_json: '{"product":"2718","dimmer":"DVCL-153P"}' },
        { type: "block_stop", index: 0 },
        done("tool_use"),
      ],
      [
        {
          type: "text",
          text: "Per the tested chart, the Lutron Diva DVCL-153PD measured a 10% low end and is marked Not Recommended.",
        },
        { type: "block_stop", index: 0 },
        done(),
      ],
    ];
    const out = await drain(
      runThomStream(ON, emptySb(), {
        userMessage: "Is the 5in tube compatible with a Lutron DVCL-153P?",
        history: [],
        surface: "public",
      }),
    );
    const final = finalOf(out);
    expect(final?.text).toContain("Lutron");
    expect(final?.text).toContain("Not Recommended");
    expect(final?.text).not.toBe(GUARDRAIL_TEMPLATE);
  });

  it("a MIXED dimming + web_search turn is NOT replaced by the screen", async () => {
    h.scripts = [
      [
        { type: "tool_use_start", index: 0, id: "t1", name: "check_dimmer_compatibility" },
        { type: "tool_input_delta", index: 0, partial_json: '{"product":"2718"}' },
        { type: "block_stop", index: 0 },
        done("tool_use"),
      ],
      [
        { type: "server_tool_use_start", index: 0, id: "s1", name: "web_search" },
        { type: "tool_input_delta", index: 0, partial_json: '{"query":"DVCL-153P specs"}' },
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
        {
          type: "text",
          text: "WAC Group's chart lists the Lutron DVCL-153PD as Not Recommended at a 10% measured low end.",
        },
        { type: "block_stop", index: 2 },
        done(),
      ],
    ];
    const out = await drain(
      runThomStream(ON, emptySb(), {
        userMessage: "check the chart and the web for DVCL-153P",
        history: [],
        surface: "public",
      }),
    );
    const final = finalOf(out);
    expect(final?.text).toContain("Lutron DVCL-153PD");
    expect(final?.text).not.toBe(GUARDRAIL_TEMPLATE);
  });

  it("a web_search turn WITHOUT a dimming tool call is still screened (guardrail intact)", async () => {
    h.scripts = [
      [
        { type: "server_tool_use_start", index: 0, id: "s1", name: "web_search" },
        { type: "tool_input_delta", index: 0, partial_json: '{"query":"dimmer"}' },
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
        { type: "text", text: "A Lutron Diva rated 600W would work here." },
        { type: "block_stop", index: 2 },
        done(),
      ],
    ];
    const out = await drain(
      runThomStream(ON, emptySb(), {
        userMessage: "something like a Lutron Diva?",
        history: [],
        surface: "public",
      }),
    );
    expect(finalOf(out)?.text).toBe(GUARDRAIL_TEMPLATE);
  });
});
