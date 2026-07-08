/**
 * Sales pivot parser — the "WAC/Schonbek Sales" workbooks are Excel PivotTables
 * over a Power BI dataset (Sales $ by Customer Account × month). The displayed
 * pivot has a TWO-LEVEL column header — a Year row (2025 … "2025 Total", 2026 …)
 * over a Month row (1..12) — with rows nested Account → Customer Group → Country.
 *
 * We extract per-account sales by (year, month) so the caller can compute a
 * same-period YTD-vs-prior-year comparison. A data row's first cell is an
 * account number (group/country child rows are text labels). The caller supplies
 * the sheet as array-of-arrays (sheet_to_json header:1). Destination: HubSpot
 * Company sales properties, matched by account number.
 */

export interface SalesAccount {
  /** Customer account number (SAP, e.g. "0002000005"). */
  account: string;
  /** Sales by year → month (1-12) → $. Only months present in the pivot. */
  byYear: Record<string, Record<number, number>>;
}

export interface SalesParseResult {
  accounts: SalesAccount[];
  /** Year columns found, ascending — the last is the current year. */
  years: string[];
  /** Months present per year, ascending (the current year's max = YTD month). */
  monthsByYear: Record<string, number[]>;
}

// Account numbers: digit accounts ("0002008036") AND brand/region-prefixed ones
// ("MF14921", "MX…", "HM00002"). A short letter prefix + 4+ digits, no spaces —
// this excludes customer-group names (spaces) and country codes (few/no digits).
// (A handful of purely-alphabetic special accounts like "THAI MING"/"UPS" are
// indistinguishable from groups/countries without the pivot indent, which
// SheetJS doesn't expose, so they're not matched — ~0.7% of sales.)
const ACCOUNT_RE = /^[A-Za-z]{0,4}\d{4,}$/;
const YEAR_RE = /^(19|20)\d{2}$/;
const MONTH_RE = /^([1-9]|1[0-2])$/;

function asNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").replace(/[$,]/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseSalesPivot(grid: unknown[][]): SalesParseResult {
  const empty: SalesParseResult = { accounts: [], years: [], monthsByYear: {} };

  // The month-header row is the one (in the header band) with the most 1-12
  // cells; the year-header row sits directly above it.
  let monthRowIdx = -1;
  let best = 0;
  for (let i = 0; i < Math.min(grid.length, 12); i++) {
    let cnt = 0;
    for (const v of grid[i]!) if (MONTH_RE.test(String(v ?? "").trim())) cnt++;
    if (cnt > best) {
      best = cnt;
      monthRowIdx = i;
    }
  }
  if (monthRowIdx < 1 || best < 2) return empty;
  const monthRow = grid[monthRowIdx]!;
  const yearRow = grid[monthRowIdx - 1]!;

  // Forward-fill the (merged) year header across its columns.
  const yearAt: (string | null)[] = [];
  let cur: string | null = null;
  for (let c = 0; c < Math.max(yearRow.length, monthRow.length); c++) {
    const s = String(yearRow[c] ?? "").trim();
    if (YEAR_RE.test(s)) cur = s;
    yearAt[c] = cur;
  }

  // Data columns = a month cell with a resolved year (skips Total/Grand Total).
  const cols: { c: number; year: string; month: number }[] = [];
  for (let c = 1; c < monthRow.length; c++) {
    const m = String(monthRow[c] ?? "").trim();
    if (MONTH_RE.test(m) && yearAt[c]) cols.push({ c, year: yearAt[c]!, month: Number(m) });
  }
  if (cols.length === 0) return empty;

  const years = [...new Set(cols.map((d) => d.year))].sort();
  const monthsByYear: Record<string, number[]> = {};
  for (const d of cols) (monthsByYear[d.year] ??= []).push(d.month);
  for (const y of Object.keys(monthsByYear)) monthsByYear[y] = [...new Set(monthsByYear[y])].sort((a, b) => a - b);

  const byAccount = new Map<string, Record<string, Record<number, number>>>();
  for (const row of grid) {
    const acct = String(row[0] ?? "").trim();
    if (!ACCOUNT_RE.test(acct)) continue;
    const byYear: Record<string, Record<number, number>> = {};
    for (const d of cols) {
      const n = asNum(row[d.c]);
      if (n != null) (byYear[d.year] ??= {})[d.month] = n;
    }
    byAccount.set(acct, byYear);
  }

  return {
    accounts: [...byAccount.entries()].map(([account, byYear]) => ({ account, byYear })),
    years,
    monthsByYear,
  };
}

/**
 * "YTD" report parser — a flat pivot with exact same-period numbers, replacing
 * the month-bucket comparison where available. TWO-LEVEL column header: a Year
 * row (2022 … 2026, then "Total Sales"/"Total Sales PYTD" grand totals) over a
 * measure row ("Sales" | "Sales PYTD" per year). Per account row:
 *   Sales[latest year]      = exact YTD through the data's refresh date
 *   Sales PYTD[latest year] = prior year through the SAME calendar date
 *   Sales[latest − 1]       = full prior year
 * A present row with an empty cell means $0 (unlike the month pivot, absence
 * here is a real zero — the account row wouldn't exist without any sales).
 */

export interface YtdAccount {
  account: string;
  /** Exact current-year-to-date $ (through the report's refresh date). */
  ytd: number;
  /** Prior year through the same calendar date; null if the report has no PYTD column. */
  priorYtd: number | null;
  /** Full prior year $; null if the report has no prior-year column. */
  priorFull: number | null;
}

export interface YtdReportResult {
  accounts: YtdAccount[];
  /** Latest year column (the current year), null if the sheet didn't parse. */
  year: string | null;
  priorYear: string | null;
}

export function parseYtdReport(grid: unknown[][]): YtdReportResult {
  const empty: YtdReportResult = { accounts: [], year: null, priorYear: null };

  // The measure row is the one (in the header band) with the most Sales /
  // Sales PYTD cells; the year row sits directly above it.
  let measureRowIdx = -1;
  let best = 0;
  for (let i = 0; i < Math.min(grid.length, 12); i++) {
    let cnt = 0;
    for (const v of grid[i]!) {
      const s = String(v ?? "").trim();
      if (s === "Sales" || s === "Sales PYTD") cnt++;
    }
    if (cnt > best) {
      best = cnt;
      measureRowIdx = i;
    }
  }
  if (measureRowIdx < 1 || best < 2) return empty;
  const measureRow = grid[measureRowIdx]!;
  const yearRow = grid[measureRowIdx - 1]!;

  // Forward-fill the (merged) year header; any non-year label ("Total Sales")
  // ends the span so grand-total columns never inherit a year.
  const yearAt: (string | null)[] = [];
  let cur: string | null = null;
  for (let c = 0; c < Math.max(yearRow.length, measureRow.length); c++) {
    const s = String(yearRow[c] ?? "").trim();
    if (YEAR_RE.test(s)) cur = s;
    else if (s) cur = null;
    yearAt[c] = cur;
  }

  const salesCol = new Map<string, number>();
  const pytdCol = new Map<string, number>();
  for (let c = 1; c < measureRow.length; c++) {
    const y = yearAt[c];
    if (!y) continue;
    const m = String(measureRow[c] ?? "").trim();
    if (m === "Sales") salesCol.set(y, c);
    else if (m === "Sales PYTD") pytdCol.set(y, c);
  }
  const years = [...salesCol.keys()].sort();
  const year = years[years.length - 1];
  if (!year) return empty;
  const prior = String(Number(year) - 1);
  const priorYear = salesCol.has(prior) ? prior : null;
  const curSalesC = salesCol.get(year)!;
  const curPytdC = pytdCol.get(year);
  const priorSalesC = priorYear ? salesCol.get(priorYear) : undefined;

  const accounts: YtdAccount[] = [];
  const seen = new Set<string>();
  for (const row of grid) {
    const acct = String(row[0] ?? "").trim();
    if (!ACCOUNT_RE.test(acct) || seen.has(acct)) continue;
    seen.add(acct);
    accounts.push({
      account: acct,
      ytd: asNum(row[curSalesC]) ?? 0,
      priorYtd: curPytdC != null ? (asNum(row[curPytdC]) ?? 0) : null,
      priorFull: priorSalesC != null ? (asNum(row[priorSalesC]) ?? 0) : null,
    });
  }
  return { accounts, year, priorYear };
}

/**
 * Last COMPLETE month of the pivot's current year, given the data's as-of date
 * (the workbook's last-refresh date). The latest month bucket is partial while
 * the as-of date is still inside it, so growth comparisons must stop before it.
 */
export function lastFullMonth(latestMonth: number, curYear: string, asOf: { year: number; month: number }): number {
  if (Number(curYear) < asOf.year) return latestMonth; // that year is over — every bucket is complete
  return latestMonth >= asOf.month ? asOf.month - 1 : latestMonth;
}

export interface SalesMetrics {
  /** Current year through the latest month bucket (true YTD, partial month included). */
  ytd?: number;
  /** Full prior year. */
  priorFull?: number;
  /** Prior year through `fullMonths` — the comparable window. */
  priorYtd?: number;
  /** Growth %, both years through `fullMonths` (apples-to-apples; excludes the partial bucket). */
  yoyPct?: number;
}

/** Month-pivot metrics: true YTD, but growth measured on complete months only. */
export function computeSalesMetrics(
  byYear: Record<string, Record<number, number>>,
  cur: string,
  prev: string | undefined,
  latestMonth: number,
  fullMonths: number,
): SalesMetrics {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const m: SalesMetrics = {};
  const ytd = sumThroughMonth(byYear[cur], latestMonth);
  if (ytd != null) m.ytd = round2(ytd);
  if (!prev) return m;
  const priorFull = sumThroughMonth(byYear[prev], 12);
  if (priorFull != null) m.priorFull = round2(priorFull);
  if (fullMonths > 0) {
    const priorWindow = sumThroughMonth(byYear[prev], fullMonths);
    const curWindow = sumThroughMonth(byYear[cur], fullMonths);
    if (priorWindow != null) {
      m.priorYtd = round2(priorWindow);
      if (curWindow != null && priorWindow !== 0) m.yoyPct = round1(((curWindow - priorWindow) / priorWindow) * 100);
    }
  }
  return m;
}

/** Sum an account's months for a year, up to and including `maxMonth`. */
export function sumThroughMonth(byMonth: Record<number, number> | undefined, maxMonth: number): number | null {
  if (!byMonth) return null;
  let total = 0;
  let any = false;
  for (const [m, v] of Object.entries(byMonth)) {
    if (Number(m) <= maxMonth) {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
}
