import { describe, expect, it } from "vitest";
import { deriveTitle, mapMessagesToTurns } from "./thom.js";

describe("deriveTitle", () => {
  it("collapses runs of whitespace to single spaces and trims", () => {
    expect(deriveTitle("  hello   world\n\tthere  ")).toBe("hello world there");
  });

  it("truncates to 80 characters", () => {
    const long = "a".repeat(200);
    const title = deriveTitle(long);
    expect(title).toHaveLength(80);
    expect(title).toBe("a".repeat(80));
  });

  it("truncates AFTER collapsing whitespace", () => {
    // 40 words of "ab " → collapsed length 119, truncated to 80.
    const title = deriveTitle("ab ".repeat(40));
    expect(title).toHaveLength(80);
    expect(title.startsWith("ab ab")).toBe(true);
  });

  it("returns empty string for whitespace-only input", () => {
    expect(deriveTitle("   \n\t  ")).toBe("");
  });
});

describe("mapMessagesToTurns", () => {
  it("maps a user row to a user turn (text only)", () => {
    const turns = mapMessagesToTurns([{ role: "user", content: "hi there" }]);
    expect(turns).toEqual([{ role: "user", text: "hi there" }]);
  });

  it("passes assistant product_cards through as cards and citations through", () => {
    const cards = [
      {
        kind: "product" as const,
        sku: "2095",
        name: "Aether",
        brand: "WAC",
        image_url: null,
        key_specs: [{ label: "CRI", value: "90" }],
        pdp_url: null,
        downloads: [],
      },
    ];
    const citations = [
      {
        kind: "web" as const,
        document_id: "d1",
        title: "Spec",
        doc_type: "spec_sheet",
        page: 3,
        url: "https://x",
      },
    ];
    const turns = mapMessagesToTurns([
      { role: "assistant", content: "answer", product_cards: cards, citations },
    ]);
    expect(turns).toEqual([
      { role: "assistant", text: "answer", cards, citations },
    ]);
  });

  it("skips tool rows and preserves order of the rest", () => {
    const turns = mapMessagesToTurns([
      { role: "user", content: "q1" },
      { role: "tool", content: "tool_result blob" },
      { role: "assistant", content: "a1" },
    ]);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[0]).toEqual({ role: "user", text: "q1" });
    expect(turns[1]).toEqual({ role: "assistant", text: "a1", cards: [], citations: [] });
  });

  it("survives a legacy card without a `kind` field", () => {
    // Cards logged before the family feature have no `kind` — they must still
    // pass through untouched.
    const legacy = [{ sku: "1000", name: "Old", image_url: null } as never];
    const turns = mapMessagesToTurns([
      { role: "assistant", content: "x", product_cards: legacy },
    ]);
    expect(turns[0]?.cards).toBe(legacy);
  });

  it("passes a kind:'web' citation through unchanged", () => {
    const citations = [
      { kind: "web" as const, document_id: "w1", title: null, doc_type: "web", page: null, url: "https://y" },
    ];
    const turns = mapMessagesToTurns([
      { role: "assistant", content: "z", citations },
    ]);
    expect(turns[0]?.citations).toEqual(citations);
  });

  it("defaults empty cards/citations to [] on an assistant turn", () => {
    const turns = mapMessagesToTurns([{ role: "assistant", content: null }]);
    expect(turns).toEqual([{ role: "assistant", text: "", cards: [], citations: [] }]);
  });
});
