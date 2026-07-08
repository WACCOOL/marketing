import { describe, expect, it } from "vitest";
import { computeSalesMetrics, lastFullMonth, parseSalesPivot, parseYtdFlat, parseYtdReport, sumThroughMonth } from "./sales.js";

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

// Year row (Sales | Sales PYTD per year, then grand totals) over a measure row,
// mirroring the real "YTD.xlsx" report.
const YTD_GRID: unknown[][] = [
  [null, "Column Labels"],
  [null, "2025", null, "2026", null, "Total Sales", "Total Sales PYTD"],
  ["Row Labels", "Sales", "Sales PYTD", "Sales", "Sales PYTD"],
  ["0002000005", 1460, 25339.13, 119.7, 600, 1579.7, 25939.13],
  ["0002000004", null, null, null, null, 401, null], // empty cells = real $0
  ["0002000002", -104423.35, 77154.47, -41244.93, -53488.61, -145668.28, 23665.86], // credits
  ["Lighting Showroom", 9, 9, 9, 9, 9, 9], // group label — skipped
  ["Grand Total", 1, 2, 3, 4, 5, 6],
];

describe("parseYtdReport (exact same-period numbers)", () => {
  it("maps Sales / Sales PYTD per account for the latest year, ignoring grand totals", () => {
    const { accounts, year, priorYear } = parseYtdReport(YTD_GRID);
    expect(year).toBe("2026");
    expect(priorYear).toBe("2025");
    expect(accounts).toEqual([
      { account: "0002000005", ytd: 119.7, priorYtd: 600, priorFull: 1460 },
      { account: "0002000004", ytd: 0, priorYtd: 0, priorFull: 0 },
      { account: "0002000002", ytd: -41244.93, priorYtd: -53488.61, priorFull: -104423.35 },
    ]);
  });

  it("returns empty on a sheet without the Sales/Sales PYTD header", () => {
    expect(parseYtdReport(GRID)).toEqual({ accounts: [], year: null, priorYear: null });
  });
});

describe("parseYtdFlat (dataset-query CSV export)", () => {
  it("maps DAX-style headers (table prefixes, brackets) and treats blanks as $0", () => {
    const grid: unknown[][] = [
      ["Customer[Account]", "[ytd]", "[pytd]", "[prior_full]"],
      ["0002000005", 119.7, 600, 1460],
      ["0002000004", null, null, null],
      ["THAI MING", 25, "", 100], // named account — captured (no pivot-label ambiguity in a flat export)
      ["0002000005", 999, 999, 999], // duplicate — first wins
    ];
    expect(parseYtdFlat(grid)).toEqual({
      accounts: [
        { account: "0002000005", ytd: 119.7, priorYtd: 600, priorFull: 1460 },
        { account: "0002000004", ytd: 0, priorYtd: 0, priorFull: 0 },
        { account: "THAI MING", ytd: 25, priorYtd: 0, priorFull: 100 },
      ],
      year: null,
      priorYear: null,
    });
  });

  it("accepts plain headers and marks missing optional columns as null", () => {
    const grid: unknown[][] = [
      ["account", "ytd"],
      ["0002000005", "119.7"],
    ];
    expect(parseYtdFlat(grid)).toEqual({
      accounts: [{ account: "0002000005", ytd: 119.7, priorYtd: null, priorFull: null }],
      year: null,
      priorYear: null,
    });
  });

  it("returns null for non-flat shapes (pivot grids fall through)", () => {
    expect(parseYtdFlat(YTD_GRID)).toBeNull();
    expect(parseYtdFlat(GRID)).toBeNull();
  });
});

describe("lastFullMonth", () => {
  it("drops the bucket the as-of date is inside", () => {
    expect(lastFullMonth(7, "2026", { year: 2026, month: 7 })).toBe(6); // partial July
    expect(lastFullMonth(6, "2026", { year: 2026, month: 7 })).toBe(6); // June complete
    expect(lastFullMonth(8, "2026", { year: 2026, month: 7 })).toBe(6); // future bucket — clamp
    expect(lastFullMonth(1, "2026", { year: 2026, month: 1 })).toBe(0); // partial January
    expect(lastFullMonth(12, "2026", { year: 2027, month: 1 })).toBe(12); // year rolled over
    expect(lastFullMonth(12, "2026", { year: 2026, month: 12 })).toBe(11); // partial December
  });
});

describe("computeSalesMetrics (growth on full months only)", () => {
  const byYear = { "2025": { 1: 1000, 2: 2000, 3: 3000 }, "2026": { 1: 500, 2: 700 } };

  it("keeps true YTD but windows the comparison to complete months", () => {
    // Latest bucket (M2) is partial: YTD includes it, growth does not.
    expect(computeSalesMetrics(byYear, "2026", "2025", 2, 1)).toEqual({
      ytd: 1200, // 500 + 700 (true YTD)
      priorFull: 6000,
      priorYtd: 1000, // 2025 M1 only
      yoyPct: -50, // (500 − 1000) / 1000
    });
  });

  it("uses the whole window when the latest month is complete", () => {
    expect(computeSalesMetrics(byYear, "2026", "2025", 2, 2)).toEqual({
      ytd: 1200,
      priorFull: 6000,
      priorYtd: 3000,
      yoyPct: -60,
    });
  });

  it("skips the comparison when no month is complete yet (partial January)", () => {
    expect(computeSalesMetrics(byYear, "2026", "2025", 1, 0)).toEqual({ ytd: 500, priorFull: 6000 });
  });

  it("is YTD-only without a prior year", () => {
    expect(computeSalesMetrics(byYear, "2026", undefined, 2, 1)).toEqual({ ytd: 1200 });
  });
});
