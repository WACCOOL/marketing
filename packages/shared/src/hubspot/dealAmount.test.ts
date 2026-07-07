import { describe, expect, it } from "vitest";
import { deriveDealAmount, sumLineAmounts } from "./dealAmount.js";

// Real shapes from the SAP feed: quantities like "12.000", prices like "481.95".
const UNION_COUNTY_LINES = [
  { quantity: "7.000", unitPrice: "500.00" },
  { quantity: "12.000", unitPrice: "481.95" },
  { quantity: "12.000", unitPrice: "185.95" },
  { quantity: "7.000", unitPrice: "500.00" },
  { quantity: "12.000", unitPrice: "481.95" },
  { quantity: "12.000", unitPrice: "185.95" },
  { quantity: "7.000", unitPrice: "500.00" },
  { quantity: "12.000", unitPrice: "481.95" },
  { quantity: "12.000", unitPrice: "185.95" },
  { quantity: "7.000", unitPrice: "500.00" },
  { quantity: "12.000", unitPrice: "481.95" },
  { quantity: "12.000", unitPrice: "185.95" },
];

describe("sumLineAmounts", () => {
  it("sums quantity × unit price, tolerating SAP decimal strings", () => {
    expect(sumLineAmounts(UNION_COUNTY_LINES)).toBe(46059.2);
  });

  it("counts qty-0 quote-text lines as $0 without discarding the sum", () => {
    expect(
      sumLineAmounts([
        { quantity: "0", unitPrice: "0.00" },
        { quantity: "2", unitPrice: "5.95" },
      ]),
    ).toBe(11.9);
  });

  it("returns null when no line has both a numeric qty and price", () => {
    expect(sumLineAmounts([])).toBeNull();
    expect(sumLineAmounts([{ quantity: "1", unitPrice: "" }])).toBeNull();
    expect(sumLineAmounts([{ quantity: undefined, unitPrice: "9.99" }])).toBeNull();
  });

  it("skips unparsable lines but keeps the rest", () => {
    expect(
      sumLineAmounts([
        { quantity: "N/A", unitPrice: "100" },
        { quantity: "3", unitPrice: "$1,000.50" },
      ]),
    ).toBe(3001.5);
  });
});

describe("deriveDealAmount — with line items", () => {
  it("overrides SAP's post-conversion 0.00 header with the line total", () => {
    const r = deriveDealAmount({
      headerAmount: "0.00",
      lines: UNION_COUNTY_LINES,
      existingAmount: 0,
    });
    expect(r.properties).toEqual({ amount: 46059.2 });
    expect(r.dropAmount).toBe(false);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!).toMatchObject({ property: "amount", action: "derived", to: "46059.2" });
  });

  it("overrides an understated (partially converted) nonzero header too", () => {
    const r = deriveDealAmount({
      headerAmount: "11.90",
      lines: [
        { quantity: "2", unitPrice: "5.95" },
        { quantity: "1", unitPrice: "56.95" },
      ],
      existingAmount: 11.9,
    });
    expect(r.properties).toEqual({ amount: 68.85 });
    expect(r.actions[0]!).toMatchObject({ from: "11.9", to: "68.85" });
  });

  it("is silent (no action) when the header already equals the line total", () => {
    const r = deriveDealAmount({
      headerAmount: "1197.35",
      lines: [
        { quantity: "5", unitPrice: "30.95" },
        { quantity: "1", unitPrice: "56.95" },
        { quantity: "1", unitPrice: "234.95" },
        { quantity: "1", unitPrice: "1.95" },
        { quantity: "1", unitPrice: "344.95" },
        { quantity: "1", unitPrice: "320.95" },
        { quantity: "1", unitPrice: "70.95" },
        { quantity: "2", unitPrice: "5.95" },
        { quantity: "0", unitPrice: "0" },
      ],
      existingAmount: null,
    });
    expect(r.properties).toEqual({ amount: 1197.35 });
    expect(r.actions).toHaveLength(0);
  });

  it("keeps a legitimately $0 deal at $0 when all lines are qty-0 text", () => {
    const r = deriveDealAmount({
      headerAmount: "0.00",
      lines: [
        { quantity: "0", unitPrice: "0" },
        { quantity: "0", unitPrice: "0" },
      ],
      existingAmount: null,
    });
    expect(r.properties).toEqual({ amount: 0 });
    expect(r.dropAmount).toBe(false);
  });
});

describe("deriveDealAmount — without line items", () => {
  it("passes a nonzero header through untouched (no properties, no drop)", () => {
    const r = deriveDealAmount({ headerAmount: "1500.00", lines: [], existingAmount: 900 });
    expect(r.properties).toEqual({});
    expect(r.dropAmount).toBe(false);
    expect(r.actions).toHaveLength(0);
  });

  it("drops a 0 header that would clobber an existing nonzero amount", () => {
    const r = deriveDealAmount({ headerAmount: "0.00", lines: [], existingAmount: 46059.2 });
    expect(r.properties).toEqual({});
    expect(r.dropAmount).toBe(true);
    expect(r.actions[0]!).toMatchObject({ property: "amount", action: "dropped" });
  });

  it("drops an ABSENT header the same way (missing quote_net_value)", () => {
    const r = deriveDealAmount({ headerAmount: undefined, lines: [], existingAmount: 250 });
    expect(r.dropAmount).toBe(true);
  });

  it("lets a 0 header through on the create path / when existing amount is 0", () => {
    expect(
      deriveDealAmount({ headerAmount: "0.00", lines: [], existingAmount: null }).dropAmount,
    ).toBe(false);
    expect(
      deriveDealAmount({ headerAmount: "0.00", lines: [], existingAmount: 0 }).dropAmount,
    ).toBe(false);
  });
});
