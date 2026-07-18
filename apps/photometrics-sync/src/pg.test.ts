import { describe, expect, it } from "vitest";
import { dedupeLinks, stripNul } from "./pg.js";

const NUL = String.fromCharCode(0);

describe("stripNul", () => {
  it("removes U+0000 from a plain string", () => {
    expect(stripNul(`a${NUL}b${NUL}`)).toBe("ab");
  });

  it("returns strings without NUL unchanged (same reference)", () => {
    const s = "clean";
    expect(stripNul(s)).toBe(s);
  });

  it("recurses through nested objects and arrays", () => {
    const input = {
      inner_filename: `R2RAT${NUL}.IES`,
      warnings: [
        { code: "W_PHOT_TYPE", message: `bad${NUL} type` },
        { code: "I_SYMMETRIC", message: "ok" },
      ],
      metrics: { format: `LM-63${NUL}`, lumens: 442.46, bug: null },
    };
    expect(stripNul(input)).toEqual({
      inner_filename: "R2RAT.IES",
      warnings: [
        { code: "W_PHOT_TYPE", message: "bad type" },
        { code: "I_SYMMETRIC", message: "ok" },
      ],
      metrics: { format: "LM-63", lumens: 442.46, bug: null },
    });
  });

  it("leaves numbers, null, and booleans intact", () => {
    expect(stripNul(42)).toBe(42);
    expect(stripNul(null)).toBe(null);
    expect(stripNul(false)).toBe(false);
  });

  it("produces JSON with no NUL escape (Postgres-safe)", () => {
    const out = stripNul({ a: `x${NUL}y`, b: [`${NUL}z`] });
    expect(JSON.stringify(out)).not.toContain("\\u0000");
  });
});

describe("dedupeLinks", () => {
  it("collapses duplicate (product_sku, ies_metrics_id) rows", () => {
    const out = dedupeLinks([
      { product_sku: "A", ies_metrics_id: "m1", is_representative: false, match_confidence: 0.2 },
      { product_sku: "A", ies_metrics_id: "m1", is_representative: true, match_confidence: 0.9 },
      { product_sku: "A", ies_metrics_id: "m2", is_representative: false, match_confidence: 0.1 },
    ]);
    expect(out).toHaveLength(2);
    const m1 = out.find((l) => l.ies_metrics_id === "m1")!;
    expect(m1.is_representative).toBe(true); // OR of duplicates
    expect(m1.match_confidence).toBe(0.9); // max of duplicates
  });

  it("keeps rows for different SKUs sharing an ies_metrics_id", () => {
    const out = dedupeLinks([
      { product_sku: "A", ies_metrics_id: "m1" },
      { product_sku: "B", ies_metrics_id: "m1" },
    ]);
    expect(out).toHaveLength(2);
  });

  it("returns each unique row unchanged when there are no duplicates", () => {
    const input = [
      { product_sku: "A", ies_metrics_id: "m1", is_representative: true, match_confidence: 1 },
      { product_sku: "A", ies_metrics_id: "m2", is_representative: false, match_confidence: 0 },
    ];
    expect(dedupeLinks(input)).toEqual(input);
  });
});
