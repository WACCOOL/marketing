/**
 * Annuity Pipeline sheet helpers — pure logic shared by the annuity-sync CLI.
 *
 * The "Annuity Pipeline" workbook drives two HubSpot outcomes: tagging existing
 * Universal-Pipeline deals that match a national account's SAP wildcards, and
 * standing up a year's worth of monthly annuity deals. These functions cover the
 * pure, testable bits: wildcard → RegExp matching and year-column detection.
 */

/** Split a "Wild Card SAP" cell into normalized, lowercased patterns. The cell
 *  holds one or more SAP wildcards separated by commas, e.g.
 *  `*culver's*, *culvers*`. Blanks are dropped. */
export function parseWildcards(cell: unknown): string[] {
  if (cell == null) return [];
  return String(cell)
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
}

/** Compile a SAP-style wildcard (`*` = any run of characters) into an anchored,
 *  case-insensitive RegExp. Every other regex metacharacter is escaped to a
 *  literal, so a leading/trailing `*` makes the pattern a contains-match
 *  (`*better*buzz*` ⇒ name contains "better" then later "buzz"). */
export function wildcardToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`));
  return new RegExp(`^${body}$`, "i");
}

/** True if `name` matches ANY of the wildcard patterns (OR). */
export function matchesAnyWildcard(name: string, patterns: string[]): boolean {
  if (!name) return false;
  return patterns.some((p) => wildcardToRegExp(p).test(name));
}

/** If a header names an annuity year column (e.g. "2026 Annuity"), return the
 *  4-digit year as a number; otherwise null. Year columns are detected by
 *  pattern, not hardcoded, so a future "2028 Annuity" column just works. */
export function parseAnnuityYearHeader(header: unknown): number | null {
  if (header == null) return null;
  const s = String(header).trim();
  if (!/annuity/i.test(s)) return null;
  const m = s.match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

export interface AnnuityAccount {
  endUser: string;
  companyId: string;
  opportunityName: string;
  wildcards: string[];
  /** year → monthly $ (only years with a populated, positive amount). */
  annualByYear: Record<number, number>;
}

export interface AnnuitySheet {
  accounts: AnnuityAccount[];
  years: number[];
}

const ANNUITY_HEADERS = {
  endUser: "NA End User",
  wildcard: "Wild Card SAP",
  id: "HubSpot Record ID",
  name: "Opportunity Name",
} as const;

/**
 * Parse the "Annuities and Associations" grid — an array-of-arrays as produced by
 * `XLSX.sheet_to_json(sheet, { header: 1 })`, with row 0 the header. Year columns
 * are detected by {@link parseAnnuityYearHeader}; rows without a HubSpot Record ID
 * are dropped. Shared by the annuity-sync CLI and the Worker's real-time labeling
 * so both interpret the sheet identically.
 */
export function parseAnnuityGrid(grid: unknown[][]): AnnuitySheet {
  const header = (grid[0] ?? []).map((h) => String(h ?? "").trim());
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const idCol = col(ANNUITY_HEADERS.id);
  const wildcardCol = col(ANNUITY_HEADERS.wildcard);
  const nameCol = col(ANNUITY_HEADERS.name);
  const endUserCol = col(ANNUITY_HEADERS.endUser);
  if (idCol < 0 || wildcardCol < 0 || nameCol < 0) {
    throw new Error(`annuity sheet missing required column(s); header = [${header.join(" | ")}]`);
  }

  const yearCols = new Map<number, number>(); // year → column index
  header.forEach((h, i) => {
    const y = parseAnnuityYearHeader(h);
    if (y != null) yearCols.set(y, i);
  });

  const accounts: AnnuityAccount[] = [];
  for (const row of grid.slice(1)) {
    const idRaw = row[idCol];
    if (idRaw == null || String(idRaw).trim() === "") continue;
    const annualByYear: Record<number, number> = {};
    for (const [year, ci] of yearCols) {
      const v = row[ci];
      const num = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,]/g, "").trim());
      if (Number.isFinite(num) && num > 0) annualByYear[year] = num;
    }
    accounts.push({
      endUser: endUserCol >= 0 ? String(row[endUserCol] ?? "").trim() : "",
      companyId: String(idRaw).trim().replace(/\.0$/, ""),
      opportunityName: String(row[nameCol] ?? "").trim(),
      wildcards: parseWildcards(row[wildcardCol]),
      annualByYear,
    });
  }
  return { accounts, years: [...yearCols.keys()].sort((a, b) => a - b) };
}
