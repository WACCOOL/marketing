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

const ACCOUNT_RE = /^\d{6,}$/;
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
