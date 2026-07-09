import { describe, expect, it } from "vitest";
import { groupOrders, lineValue, type TurnoverDbRow } from "./hubspot.js";

const row = (over: Partial<TurnoverDbRow>): TurnoverDbRow => ({
  billing_document: "1",
  material: "M",
  rep_code: "R",
  sold_to: "A",
  billing_date: "2026-01-01",
  currency: "USD",
  quotation_ref: null,
  brand: "WAC",
  quantity: 1,
  ytd_total: 0,
  discounted_sales: 0,
  ...over,
});

describe("lineValue", () => {
  it("uses Discounted Sales when nonzero", () => {
    expect(lineValue({ discounted_sales: 62.25, ytd_total: 622.2 })).toBe(62.25);
  });

  it("falls back to YTD Total when Discounted Sales is zero (Home Depot / drop-ship channels)", () => {
    expect(lineValue({ discounted_sales: 0, ytd_total: 203 })).toBe(203);
    expect(lineValue({ discounted_sales: null, ytd_total: 203 })).toBe(203);
  });

  it("is zero when both are empty", () => {
    expect(lineValue({ discounted_sales: 0, ytd_total: null })).toBe(0);
  });
});

describe("groupOrders with channel-dependent value columns", () => {
  it("totals YTD-only lines and still excludes qty-0 split-rep repeats", () => {
    const orders = groupOrders([
      row({ material: "M1", discounted_sales: 0, ytd_total: 203 }),
      row({ material: "M2", discounted_sales: 100, ytd_total: 0 }),
      // split-rep repeat: qty 0, must not double-count
      row({ material: "M2", rep_code: "R2", quantity: 0, discounted_sales: 100, ytd_total: 0 }),
    ]);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.total).toBe(303);
    expect(orders[0]!.primaryRep).toBe("R");
    expect(orders[0]!.secondaryReps).toEqual(["R2"]);
  });

  it("weights the primary rep by the hybrid line value", () => {
    const orders = groupOrders([
      row({ material: "M1", rep_code: "SMALL", discounted_sales: 50, ytd_total: 0 }),
      row({ material: "M2", rep_code: "BIG", discounted_sales: 0, ytd_total: 500 }),
    ]);
    expect(orders[0]!.primaryRep).toBe("BIG");
  });
});
