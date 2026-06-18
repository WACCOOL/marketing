import { describe, expect, it } from "vitest";
import { parseSalesPivot } from "./sales.js";

describe("parseSalesPivot", () => {
  it("extracts per-account sales for a single-year pivot, skipping label rows", () => {
    const grid: unknown[][] = [
      ["Date", "All", null],
      ["Row Labels", "2026", "Grand Total"],
      ["0002000002", -41244.93, -41244.93],
      ["Lighting Showroom", -41244.93, -41244.93], // customer group child
      ["US", -41244.93, -41244.93], // country child
      ["0002000005", 119.7, 119.7],
      ["Grand Total", 98663963.61, 98663963.61],
    ];
    const { accounts, years } = parseSalesPivot(grid);
    expect(years).toEqual(["2026"]);
    expect(accounts).toEqual([
      { account: "0002000002", byYear: { "2026": -41244.93 } },
      { account: "0002000005", byYear: { "2026": 119.7 } },
    ]);
  });

  it("captures every year column for a multi-year pivot", () => {
    const grid: unknown[][] = [
      ["Row Labels", "2025", "2026", "Grand Total"],
      ["0001234567", 1000, 250, 1250],
      ["2026", 5, 5, 10], // a 4-digit value is not an account (needs 6+ digits)
      ["0009999999", "2,000", "1,234.50", "3,234.50"],
    ];
    const { accounts, years } = parseSalesPivot(grid);
    expect(years).toEqual(["2025", "2026"]);
    expect(accounts).toEqual([
      { account: "0001234567", byYear: { "2025": 1000, "2026": 250 } },
      { account: "0009999999", byYear: { "2025": 2000, "2026": 1234.5 } },
    ]);
  });
});
