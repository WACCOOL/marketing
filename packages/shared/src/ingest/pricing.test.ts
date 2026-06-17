import { describe, expect, it } from "vitest";
import { parsePricing } from "./pricing.js";

// Mirrors the real SAP export header keys.
function row(material: string, amount: unknown, type = "C1", extra: Record<string, unknown> = {}) {
  return {
    "Sales org.": "2000",
    "Price list type": type,
    Material: material,
    Amount: amount,
    Unit: "USD",
    "Valid From": new Date(Date.UTC(2019, 11, 1)),
    "Valid to": new Date(Date.UTC(9999, 11, 31)),
    ...extra,
  };
}

describe("parsePricing", () => {
  it("maps the SAP price-list columns to PricingRow", () => {
    const res = parsePricing([row("PD-42719-PN", 171.5)], "c1");
    expect(res.errors).toEqual([]);
    expect(res.valid).toEqual([
      {
        variant: "c1",
        sku: "PD-42719-PN",
        price: 171.5,
        currency: "USD",
        validFrom: "2019-12-01",
        validTo: "9999-12-31",
        salesOrg: "2000",
      },
    ]);
    expect(res.stats.valid).toBe(1);
  });

  it("is tolerant of header case/whitespace and accepts the variant case-insensitively", () => {
    const raw = { "  material ": "ABC-1", AMOUNT: 10, "price list type": "D6" };
    const res = parsePricing([raw], "D6");
    expect(res.valid[0]?.sku).toBe("ABC-1");
    expect(res.valid[0]?.variant).toBe("d6");
    expect(res.valid[0]?.price).toBe(10);
  });

  it("collects errors for missing SKU / non-numeric price without throwing", () => {
    const res = parsePricing([row("", 10), row("X", "n/a"), row("Y", 5)], "c1");
    expect(res.valid.map((v) => v.sku)).toEqual(["Y"]);
    expect(res.errors).toHaveLength(2);
    expect(res.errors[0]?.rowIndex).toBe(2); // header is row 1
  });

  it("flags a price-list-type that doesn't match the variant", () => {
    const res = parsePricing([row("X", 1, "D1")], "c1");
    expect(res.valid).toHaveLength(0);
    expect(res.errors[0]?.messages[0]).toContain("does not match variant");
    expect(res.stats.mismatchedType).toBe(1);
  });

  it("keeps the latest valid_from price when a SKU appears twice", () => {
    // Mirrors the real D1 case: an older 2023 price and a newer 2025 price.
    const older = row("DISPLAY-LOTOS-FWT", 49.95, "c1", {
      "Valid From": new Date(Date.UTC(2023, 0, 1)),
    });
    const newer = row("DISPLAY-LOTOS-FWT", 58.95, "c1", {
      "Valid From": new Date(Date.UTC(2025, 4, 19)),
    });
    const res = parsePricing([older, newer], "c1"); // file order: old then new
    expect(res.valid).toHaveLength(1);
    expect(res.valid[0]?.price).toBe(58.95);
    expect(res.valid[0]?.validFrom).toBe("2025-05-19");
    expect(res.stats.superseded).toBe(1);
    expect(res.errors).toEqual([]); // a price update is not an error
  });

  it("treats a trailing non-breaking space as the same SKU", () => {
    const a = row("ABC ", 10, "c1", { "Valid From": new Date(Date.UTC(2020, 0, 1)) });
    const b = row("ABC", 20, "c1", { "Valid From": new Date(Date.UTC(2024, 0, 1)) });
    const res = parsePricing([a, b], "c1");
    expect(res.valid).toHaveLength(1);
    expect(res.valid[0]?.sku).toBe("ABC");
    expect(res.valid[0]?.price).toBe(20);
  });
});
