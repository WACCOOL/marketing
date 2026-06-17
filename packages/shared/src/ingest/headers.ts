/**
 * Header utilities for ingestion parsers. Sheet rows arrive (from SheetJS
 * sheet_to_json) keyed by the workbook's header strings; `field` resolves a
 * value by a canonical header name, tolerant of case and surrounding
 * whitespace, so a parser isn't brittle to "Material" vs "material " etc.
 */

/** Case-insensitive, whitespace-trimmed lookup of a column in a parsed row. */
export function field(row: Record<string, unknown>, name: string): unknown {
  const direct = row[name];
  if (direct !== undefined) return direct;
  const target = name.trim().toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.trim().toLowerCase() === target) return row[key];
  }
  return undefined;
}

/** Coerce a cell to a trimmed string ("" for null/undefined). */
export function asString(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/** Coerce a cell to a finite number, or null. */
export function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = asString(v).replace(/[$,]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Coerce a cell to an ISO date (yyyy-mm-dd) or null. Accepts a JS Date (SheetJS
 * cellDates), or a parseable date string. Uses UTC components so a date-only
 * value isn't shifted across a timezone boundary.
 */
export function asIsoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(asString(v));
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
