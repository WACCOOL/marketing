import { describe, expect, it } from "vitest";
import { parseSalesPivot, sumThroughMonth } from "./sales.js";

// Two-level header (Year over Month) with per-year Total + Grand Total columns,
// mirroring the real "WAC Sales" pivot.
const GRID: unknown[][] = [
  ["Date", "All", null, null, null, null, null, null, null],
  ["Sales", "Column Labels", null, null, null, null, null, null, null],
  [null, "2025", null, null, "2025 Total", "2026", null, "2026 Total", "Grand Total"],
  ["Row Labels", "1", "2", "3", null, "1", "2", null, null],
  ["0001234567", 1000, 2000, 3000, 6000, 500, 700, 1200, 7200],
  ["Lighting Showroom", 1000, 2000, 3000, 6000, 500, 700, 1200, 7200], // group — skipped (space)
  ["MF14921", 100, 200, 300, 600, 400, 0, 400, 1000], // brand-prefixed account — captured
  ["EN3", 100, 200, 300, 600, 400, 0, 400, 1000], // country code — skipped (<4 digits)
  ["Grand Total", 100000, 200000, 300000, 600000, 50000, 70000, 120000, 720000],
];

describe("parseSalesPivot (month-aware)", () => {
  it("maps digit + alphanumeric accounts by year/month, skipping groups/countries/totals", () => {
    const { accounts, years, monthsByYear } = parseSalesPivot(GRID);
    expect(years).toEqual(["2025", "2026"]);
    expect(monthsByYear).toEqual({ "2025": [1, 2, 3], "2026": [1, 2] });
    expect(accounts).toEqual([
      { account: "0001234567", byYear: { "2025": { 1: 1000, 2: 2000, 3: 3000 }, "2026": { 1: 500, 2: 700 } } },
      { account: "MF14921", byYear: { "2025": { 1: 100, 2: 200, 3: 300 }, "2026": { 1: 400, 2: 0 } } },
    ]);
  });

  it("sums months through a cutoff for same-period comparison", () => {
    const { accounts, monthsByYear } = parseSalesPivot(GRID);
    const a = accounts[0]!;
    const latest = Math.max(...monthsByYear["2026"]!); // 2
    expect(sumThroughMonth(a.byYear["2026"], latest)).toBe(1200); // 500 + 700
    expect(sumThroughMonth(a.byYear["2025"], latest)).toBe(3000); // 1000 + 2000 (same period)
    expect(sumThroughMonth(a.byYear["2025"], 12)).toBe(6000); // full prior year
  });
});
