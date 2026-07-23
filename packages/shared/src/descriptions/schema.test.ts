import { describe, expect, it } from "vitest";
import { ImportPayloadSchema, type ParsedProduct } from "./schema.js";

const product = (key: string): ParsedProduct => ({
  content_key: key,
  brand: "WAC Lighting",
  collection: "Dweled",
  year: 2027,
  name: "ZALTA",
  family: null,
  product_type: "Sconce",
  diffuser_type: null,
  finishes: ["BK"],
  sizes: [{ length: "26", width: "5", height: "7" }],
  cct: ["3000K"],
  model_numbers: ["WSW990726-BK"],
  model_bases: ["WSW990726"],
  features: ["Hammered Texture"],
  attributes: { variants: [], sheet: {} },
  source_rows: 1,
  sort_order: 0,
});

describe("ImportPayloadSchema", () => {
  it("accepts a valid payload", () => {
    const res = ImportPayloadSchema.safeParse({
      slot: "dweled_master",
      products: [product("dweled:zalta")],
      warnings: [],
      sheets: [{ sheet: "Master Sheet", rows: 1, groups: 1 }],
    });
    expect(res.success).toBe(true);
  });

  it("rejects duplicate content_keys", () => {
    const res = ImportPayloadSchema.safeParse({
      slot: "dweled_master",
      products: [product("dweled:zalta"), product("dweled:zalta")],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(JSON.stringify(res.error.issues)).toContain("duplicate content_key");
    }
  });

  it("rejects unknown slots and empty product lists", () => {
    expect(
      ImportPayloadSchema.safeParse({ slot: "nope", products: [product("k")] })
        .success,
    ).toBe(false);
    expect(
      ImportPayloadSchema.safeParse({ slot: "dweled_master", products: [] })
        .success,
    ).toBe(false);
  });

  it("rejects oversized attributes blobs", () => {
    const big = product("dweled:big");
    big.attributes = { variants: [], sheet: { blob: "x".repeat(490) } };
    // Inflate via many keys to cross the 24k serialized cap.
    for (let i = 0; i < 60; i++) {
      (big.attributes.sheet as Record<string, string>)[`k${i}`] = "y".repeat(450);
    }
    const res = ImportPayloadSchema.safeParse({
      slot: "dweled_master",
      products: [big],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(JSON.stringify(res.error.issues)).toContain("attributes too large");
    }
  });
});
