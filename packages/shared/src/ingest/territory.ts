import { asString, field } from "./headers.js";
import type { ParseError } from "./types.js";

/**
 * Territory parser — the "Contract Master Sheet.xlsx" has two tabs:
 *  1. "Territory Master Sheet": zips x channel columns, each cell a rep code.
 *     Unpivoted to long (zip, channel, rep code) rows.
 *  2. "Rep Code RSM ISR Mapping": per rep code District/RSM-TSM/Sales District
 *     Code/ISR/AMT Rep Code.
 * Functions are split per-row so the consumer can STREAM the (~200k) unpivot
 * into chunked upserts rather than materializing it all at once.
 */

export interface RepZipRow {
  repCode: string;
  zip: string;
  channel: string;
}

export interface RepCodeMapping {
  repCode: string;
  district: string | null;
  rsmTsm: string | null;
  salesDistrictCode: string | null;
  isr: string | null;
  amtRepCode: string | null;
}

/** Per-rep aggregate built while streaming the matrix (for the rep_codes row). */
export interface RepAggregate {
  zips: Set<string>;
  channels: Set<string>;
}

export interface RepCodeRow {
  repCode: string;
  district: string | null;
  rsmTsm: string | null;
  salesDistrictCode: string | null;
  isr: string | null;
  amtRepCode: string | null;
  channels: string[];
  zipCount: number;
}

export interface TerritoryHeader {
  zipCol: number;
  channels: { col: number; name: string }[];
}

// Non-channel columns in the master sheet (lowercased). "State" appears twice
// (full name + abbreviation); both are geo.
const GEO_HEADERS = new Set(["zip code", "state", "county", "county & state"]);

/**
 * Locate the Zip Code column and the channel columns from the master sheet's
 * header row (`sheet_to_json(master, { header: 1 })[0]`; col A is blank).
 * Returns null when there's no Zip Code column.
 */
export function parseTerritoryHeader(header: unknown[]): TerritoryHeader | null {
  let zipCol = -1;
  const channels: { col: number; name: string }[] = [];
  header.forEach((cell, col) => {
    const name = asString(cell);
    if (!name) return;
    const lc = name.toLowerCase();
    if (lc === "zip code") {
      zipCol = col;
      return;
    }
    if (GEO_HEADERS.has(lc)) return; // other geo columns (State, County, …)
    channels.push({ col, name });
  });
  if (zipCol === -1) return null;
  return { zipCol, channels };
}

/**
 * Normalize a zip cell. The master sheet stores zips as integers, so leading
 * zeros are lost (501 → "00501", 1001 → "01001"). Pad numeric zips to 5 digits;
 * leave already-formatted values (text zips, ZIP+4) untouched.
 */
export function normalizeZip(v: unknown): string {
  const s = asString(v);
  if (!s) return "";
  return /^\d{1,5}$/.test(s) ? s.padStart(5, "0") : s;
}

/** Unpivot one master-sheet data row into (zip, channel) -> rep code rows. */
export function unpivotTerritoryRow(
  row: unknown[],
  header: TerritoryHeader,
): RepZipRow[] {
  const zip = normalizeZip(row[header.zipCol]);
  if (!zip) return [];
  const out: RepZipRow[] = [];
  for (const ch of header.channels) {
    const repCode = asString(row[ch.col]);
    if (repCode) out.push({ repCode, zip, channel: ch.name });
  }
  return out;
}

/** Accumulate a rep's zips/channels into the streaming aggregate map. */
export function addToAggregate(
  aggregates: Map<string, RepAggregate>,
  rz: RepZipRow,
): void {
  let agg = aggregates.get(rz.repCode);
  if (!agg) {
    agg = { zips: new Set(), channels: new Set() };
    aggregates.set(rz.repCode, agg);
  }
  agg.zips.add(rz.zip);
  agg.channels.add(rz.channel);
}

/** Parse the "Rep Code RSM ISR Mapping" tab. Dedups rep codes (last wins). */
export function parseRepCodeMapping(rows: Record<string, unknown>[]): {
  mapping: Map<string, RepCodeMapping>;
  errors: ParseError[];
  duplicates: number;
} {
  const mapping = new Map<string, RepCodeMapping>();
  const errors: ParseError[] = [];
  let duplicates = 0;

  rows.forEach((raw, i) => {
    const repCode = asString(field(raw, "Rep Code"));
    if (!repCode) {
      // Flag only rows that carry data but no rep code; ignore blank trailing rows.
      if (Object.values(raw).some((v) => asString(v))) {
        errors.push({ rowIndex: i + 2, messages: ["missing Rep Code"] });
      }
      return;
    }
    if (mapping.has(repCode)) duplicates++;
    mapping.set(repCode, {
      repCode,
      district: asString(field(raw, "District")) || null,
      rsmTsm: asString(field(raw, "RSM/TSM")) || null,
      salesDistrictCode: asString(field(raw, "Sales District Code")) || null,
      isr: asString(field(raw, "ISR")) || null,
      amtRepCode: asString(field(raw, "AMT Rep Code")) || null,
    });
  });

  return { mapping, errors, duplicates };
}

/**
 * Merge the matrix aggregates with the mapping into one row per rep code — the
 * UNION of both tabs (a rep code may have zips but no mapping, or vice versa).
 */
export function buildRepCodes(
  aggregates: Map<string, RepAggregate>,
  mapping: Map<string, RepCodeMapping>,
): RepCodeRow[] {
  const repCodes = new Set<string>([...aggregates.keys(), ...mapping.keys()]);
  const out: RepCodeRow[] = [];
  for (const repCode of repCodes) {
    const agg = aggregates.get(repCode);
    const map = mapping.get(repCode);
    out.push({
      repCode,
      district: map?.district ?? null,
      rsmTsm: map?.rsmTsm ?? null,
      salesDistrictCode: map?.salesDistrictCode ?? null,
      isr: map?.isr ?? null,
      amtRepCode: map?.amtRepCode ?? null,
      channels: agg ? [...agg.channels].sort() : [],
      zipCount: agg ? agg.zips.size : 0,
    });
  }
  return out;
}
