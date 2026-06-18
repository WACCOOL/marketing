/**
 * Sales pivot parser — the "WAC Sales" / "Schonbek Sales" workbooks are Excel
 * PivotTables over a Power BI dataset (Sales $ by Customer Account). The raw
 * rows live in the cube, but the *displayed* pivot is in the sheet: rows nested
 * Account → Customer Group → Country, one column per Year, value = Sales.
 *
 * We extract per-account sales for every Year column present. A data row's first
 * cell is an account number (group/country child rows are text labels). The
 * caller supplies the sheet as array-of-arrays (sheet_to_json header:1).
 * Destination: HubSpot Company sales properties, matched by account number.
 */

export interface SalesAccount {
  /** Customer account number (SAP, e.g. "0002000005"). */
  account: string;
  /** Sales total per year column, keyed by year string ("2026"). */
  byYear: Record<string, number>;
}

export interface SalesParseResult {
  accounts: SalesAccount[];
  /** Year columns found, ascending — the last is the current/YTD year. */
  years: string[];
}

/** An account row's first cell is all-digits and long enough to not be a year. */
const ACCOUNT_RE = /^\d{6,}$/;
const YEAR_RE = /^(19|20)\d{2}$/;

export function parseSalesPivot(grid: unknown[][]): SalesParseResult {
  // Locate the year columns from the first header row that carries any year.
  const yearCol: Record<string, number> = {};
  for (const row of grid) {
    for (let c = 1; c < row.length; c++) {
      const s = row[c] == null ? "" : String(row[c]).trim();
      if (YEAR_RE.test(s)) yearCol[s] = c;
    }
    if (Object.keys(yearCol).length) break;
  }
  const years = Object.keys(yearCol).sort();

  const byAccount = new Map<string, Record<string, number>>();
  for (const row of grid) {
    const acct = row[0] == null ? "" : String(row[0]).trim();
    if (!ACCOUNT_RE.test(acct)) continue; // skip group/country/total/header rows
    const byYear: Record<string, number> = {};
    for (const y of years) {
      const v = row[yearCol[y]!];
      const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,]/g, ""));
      if (Number.isFinite(n)) byYear[y] = n;
    }
    byAccount.set(acct, byYear); // last wins (accounts unique in the pivot)
  }

  return {
    accounts: [...byAccount.entries()].map(([account, byYear]) => ({ account, byYear })),
    years,
  };
}
