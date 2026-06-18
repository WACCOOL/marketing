import { describe, expect, it } from "vitest";
import { parseSalesPivot, sumThroughMonth } from "./sales.js";

// Two-level header (Year over Month) with per-year Total + Grand Total columns,
// mirroring the real "WAC Sales" pivot.
const GRID: unknown[][] = [
  ["Date", "All", null, null, null, null, null, null, null],
  ["Sales", "Column Labels", null, null, null, null, null, null, null],
  [null, "2025", null, null, "2025 Total", "2026", null, "2026 Total", "Grand Total"],
  ["Row Labels", "1", "2", "3", null, "1", "2", null, null],
  ["0001234567", 10, 20, 30, 60, 5, 7, 12, 72],
  ["Lighting Showroom", 10, 20, 30, 60, 5, 7, 12, 72], // group child — skipped
  ["Grand Total", 1000, 2000, 3000, 6000, 500, 700, 1200, 7200],
];

describe("parseSalesPivot (month-aware)", () => {
  it("maps account sales by year + month, skipping Total and label rows", () => {
    const { accounts, years, monthsByYear } = parseSalesPivot(GRID);
    expect(years).toEqual(["2025", "2026"]);
    expect(monthsByYear).toEqual({ "2025": [1, 2, 3], "2026": [1, 2] });
    expect(accounts).toEqual([
      { account: "0001234567", byYear: { "2025": { 1: 10, 2: 20, 3: 30 }, "2026": { 1: 5, 2: 7 } } },
    ]);
  });

  it("sums months through a cutoff for same-period comparison", () => {
    const { accounts, monthsByYear } = parseSalesPivot(GRID);
    const a = accounts[0]!;
    const latest = Math.max(...monthsByYear["2026"]!); // 2
    expect(sumThroughMonth(a.byYear["2026"], latest)).toBe(12); // 5 + 7
    expect(sumThroughMonth(a.byYear["2025"], latest)).toBe(30); // 10 + 20 (same period)
    expect(sumThroughMonth(a.byYear["2025"], 12)).toBe(60); // full prior year
  });
});
