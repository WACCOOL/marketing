import { describe, expect, it } from "vitest";
import type { ThomEnv } from "./env.js";
import type { ClaudeContentBlock, ClaudeResponse } from "./transport.js";
import {
  buildWebSearchTools,
  collectWebCitations,
  loopAction,
  webSearchEnabled,
  webSearchMaxUses,
} from "./agent.js";

const env = (over: Partial<ThomEnv> = {}): ThomEnv => over as ThomEnv;

describe("webSearchEnabled", () => {
  it("is off when unset", () => {
    expect(webSearchEnabled(env())).toBe(false);
  });
  it('is off when explicitly "0"', () => {
    expect(webSearchEnabled(env({ THOM_WEB_SEARCH: "0" }))).toBe(false);
  });
  it('is on only when explicitly "1"', () => {
    expect(webSearchEnabled(env({ THOM_WEB_SEARCH: "1" }))).toBe(true);
  });
});

describe("webSearchMaxUses", () => {
  it("defaults to 3 when unset", () => {
    expect(webSearchMaxUses(env())).toBe(3);
  });
  it("defaults to 3 when non-numeric", () => {
    expect(webSearchMaxUses(env({ THOM_WEB_SEARCH_MAX_USES: "abc" }))).toBe(3);
  });
  it("parses a valid value", () => {
    expect(webSearchMaxUses(env({ THOM_WEB_SEARCH_MAX_USES: "4" }))).toBe(4);
  });
  it("clamps below 1 up to 1", () => {
    expect(webSearchMaxUses(env({ THOM_WEB_SEARCH_MAX_USES: "0" }))).toBe(1);
  });
  it("clamps above 5 down to 5", () => {
    expect(webSearchMaxUses(env({ THOM_WEB_SEARCH_MAX_USES: "99" }))).toBe(5);
  });
});

describe("buildWebSearchTools", () => {
  it("returns [] when disabled", () => {
    expect(buildWebSearchTools(env())).toEqual([]);
  });
  it("returns one basic (Haiku-tier) entry with a clamped max_uses when enabled", () => {
    const tools = buildWebSearchTools(env({ THOM_WEB_SEARCH: "1", THOM_WEB_SEARCH_MAX_USES: "9" }));
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool).toBeDefined();
    expect(tool?.type).toBe("web_search_20250305");
    expect(tool?.name).toBe("web_search");
    expect(tool?.max_uses).toBe(5);
  });
});

describe("collectWebCitations", () => {
  it("prefers cited web_search_result_location entries on text blocks", () => {
    const content: ClaudeContentBlock[] = [
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [
          { type: "web_search_result", url: "https://a.example/spec", title: "A spec" },
          { type: "web_search_result", url: "https://b.example/spec", title: "B spec" },
        ],
      },
      {
        type: "text",
        text: "Based on publicly available info…",
        citations: [
          { type: "web_search_result_location", url: "https://a.example/spec", title: "A spec", cited_text: "…" },
        ],
      },
    ];
    const cites = collectWebCitations(content);
    // Prefers the CITED source, not every raw result.
    expect(cites).toHaveLength(1);
    expect(cites[0]).toMatchObject({
      kind: "web",
      doc_type: "web",
      page: null,
      url: "https://a.example/spec",
      document_id: "https://a.example/spec",
      title: "A spec",
    });
  });

  it("falls back to the raw result array when nothing was cited", () => {
    const content: ClaudeContentBlock[] = [
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_2",
        content: [
          { type: "web_search_result", url: "https://a.example/spec", title: "A spec" },
          { type: "web_search_result", url: "https://b.example/spec", title: "B spec" },
        ],
      },
    ];
    const cites = collectWebCitations(content);
    expect(cites.map((c) => c.url)).toEqual(["https://a.example/spec", "https://b.example/spec"]);
    expect(cites.every((c) => c.kind === "web" && c.document_id === c.url)).toBe(true);
  });

  it("guards the error shape (single object with error_code) and returns []", () => {
    const content: ClaudeContentBlock[] = [
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_3",
        content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
      },
    ];
    expect(collectWebCitations(content)).toEqual([]);
  });

  it("returns [] when there are no web blocks", () => {
    const content: ClaudeContentBlock[] = [{ type: "text", text: "hi" }];
    expect(collectWebCitations(content)).toEqual([]);
  });
});

describe("loopAction", () => {
  const res = (over: Partial<Pick<ClaudeResponse, "stop_reason" | "content">>): Pick<ClaudeResponse, "stop_reason" | "content"> => ({
    stop_reason: "end_turn",
    content: [],
    ...over,
  });

  it("returns 'pause' for pause_turn", () => {
    expect(loopAction(res({ stop_reason: "pause_turn" }))).toBe("pause");
  });
  it("returns 'dispatch' for a tool_use turn with a client tool_use block", () => {
    expect(
      loopAction(
        res({
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "toolu_1", name: "get_product", input: {} }],
        }),
      ),
    ).toBe("dispatch");
  });
  it("returns 'final' for end_turn", () => {
    expect(loopAction(res({ stop_reason: "end_turn" }))).toBe("final");
  });
  it("returns 'final' when stop_reason is tool_use but there is no client tool_use block (server-only)", () => {
    expect(
      loopAction(
        res({
          stop_reason: "tool_use",
          content: [{ type: "text", text: "…" }],
        }),
      ),
    ).toBe("final");
  });
});
