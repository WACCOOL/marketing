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
