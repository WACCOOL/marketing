import { describe, expect, it } from "vitest";
import { parseTurnover, turnoverLineKey } from "./turnover.js";

// Shapes lifted (anonymized) from the live TURNOVER-20260707 sample.
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "Rep.": "ZBU",
    "Sold-to": "IR00067",
    "Billing Date": "2026-07-06",
    "Billing Document": "96516614",
    "Material number": "5011-30BZ",
    Currency: "USD",
    "YTD Total": "1381.86",
    "Discounted Sales": "1381.86",
    Quantity: "12.000",
    "Quotation Ref": null,
    ...overrides,
  };
}

describe("parseTurnover", () => {
  it("parses a happy-path line", () => {
    const { valid, errors } = parseTurnover([row()]);
    expect(errors).toEqual([]);
    expect(valid).toHaveLength(1);
    const r = valid[0]!;
    expect(r.billingDocument).toBe("96516614");
    expect(r.material).toBe("5011-30BZ");
    expect(r.repCode).toBe("ZBU");
    expect(r.soldTo).toBe("IR00067");
    expect(r.billingDate).toBe("2026-07-06");
    expect(r.ytdTotal).toBe(1381.86);
    expect(r.discountedSales).toBe(1381.86);
    expect(r.quantity).toBe(12);
    expect(r.quotationRef).toBeNull();
    expect(r.raw["Currency"]).toBe("USD");
  });

  it("collects an error for a row missing its billing document", () => {
    const { valid, errors } = parseTurnover([row({ "Billing Document": "" }), row()]);
    expect(valid).toHaveLength(1);
    expect(errors).toEqual([
      { rowIndex: 2, messages: ["missing Billing Document"] },
    ]);
  });

  it("keeps split-rep rows (same doc+material, different rep) as separate lines", () => {
    const { valid, errors, stats } = parseTurnover([
      row({ "Rep.": "BR", Quantity: "1.000" }),
      row({ "Rep.": "LLS", Quantity: "0.000" }),
    ]);
    expect(errors).toEqual([]);
    expect(stats.duplicates).toBe(0);
    expect(valid).toHaveLength(2);
    expect(new Set(valid.map(turnoverLineKey)).size).toBe(2);
  });

  it("dedupes an exact (doc, material, rep) repeat — last wins", () => {
    const { valid, stats } = parseTurnover([
      row({ Quantity: "1.000" }),
      row({ Quantity: "5.000" }),
    ]);
    expect(stats.duplicates).toBe(1);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.quantity).toBe(5);
  });

  it("preserves negative quantities/values (credits) and parses quote refs", () => {
    const { valid } = parseTurnover([
      row({ Quantity: "-12.000", "Discounted Sales": "-32.06", "Quotation Ref": "25100061" }),
    ]);
    expect(valid[0]!.quantity).toBe(-12);
    expect(valid[0]!.discountedSales).toBe(-32.06);
    expect(valid[0]!.quotationRef).toBe("25100061");
  });

  it("keeps leading zeros — identifiers stay strings", () => {
    const { valid } = parseTurnover([
      row({ "Billing Document": "00096516614", "Sold-to": "0002011239" }),
    ]);
    expect(valid[0]!.billingDocument).toBe("00096516614");
    expect(valid[0]!.soldTo).toBe("0002011239");
  });

  it("tolerates a BOM/whitespace-wrapped header (field lookup)", () => {
    const r = row();
    // Simulate a BOM'd first header as SheetJS can surface it.
    delete (r as Record<string, unknown>)["Rep."];
    (r as Record<string, unknown>)["﻿Rep. "] = "ELL";
    // ﻿ is not trimmed by field()'s trim? String.prototype.trim strips it (it's whitespace).
    const { valid } = parseTurnover([r]);
    expect(valid[0]!.repCode).toBe("ELL");
  });
});

describe("turnoverLineKey", () => {
  it("includes the rep when present, material alone otherwise", () => {
    expect(turnoverLineKey({ material: "WC20-WT", repCode: "KTI" })).toBe("WC20-WT~KTI");
    expect(turnoverLineKey({ material: "WC20-WT", repCode: "" })).toBe("WC20-WT");
  });
});
