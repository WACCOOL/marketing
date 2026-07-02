import { SHOWROOM_DEFAULT_TAB, type ShowroomSheet } from "./registry.js";

/**
 * Pure parsing of a "PO Showroom Orders" Google Forms responses sheet into
 * normalized orders. Input is the raw Sheets API `values` grid fetched with
 * valueRenderOption=UNFORMATTED_VALUE + dateTimeRenderOption=SERIAL_NUMBER,
 * so numbers/dates arrive as JS numbers — but every accessor also tolerates
 * the formatted-string forms ("$5,065.42", "3705639.0") defensively.
 */

export interface ShowroomOrder {
  agencyKey: string;
  agencyName: string;
  /** 1-based sheet row (header = row 1) for log/warning messages. */
  row: number;
  /** Form submission time (ms epoch), null when unparseable. */
  timestampMs: number | null;
  submittedBy: string;
  salesRep: string;
  accountName: string;
  /** Raw showroom account number as a string ("BY171664A" safe). */
  accountNumber: string;
  orderSource: string;
  tradeShow: string;
  brand: string;
  /** Normalized PO/invoice number ("" when blank). */
  po: string;
  amount: number | null;
  /** Unique dedupe key for the HubSpot upsert (showroom_order_key). */
  orderKey: string;
}

export interface ParsedShowroomSheet {
  orders: ShowroomOrder[];
  warnings: string[];
}

/**
 * Expected columns, located by fuzzy header match (lowercased, non-alphanumerics
 * stripped, `matches` tested with String.includes) so column reordering or minor
 * label edits in the form don't silently misparse — a column that can't be found
 * yields a warning and blank values instead.
 */
const COLUMNS = [
  { key: "timestamp", matches: ["timestamp"] },
  { key: "email", matches: ["emailaddress"] },
  { key: "salesRep", matches: ["salesrepresentative"] },
  { key: "accountName", matches: ["showroomaccountname"] },
  { key: "accountNumber", matches: ["showroomaccountnumber"] },
  { key: "orderSource", matches: ["howthisordercameabout", "canyouclarify"] },
  { key: "tradeShow", matches: ["tradeshow"] },
  { key: "brand", matches: ["brand"] },
  { key: "po", matches: ["invoiceponumber", "internalinvoice", "ponumber"] },
  { key: "amount", matches: ["amount"] },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

function normalizeHeader(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Trimmed string form of a cell ("" for null/undefined). */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/**
 * Normalize a PO/invoice cell: integers (Sheets numeric cells) render without
 * a decimal, the ".0" float artifact from formatted exports is stripped, and
 * alphanumeric POs are uppercased so "by171664a" and "BY171664A" dedupe together.
 */
export function normalizePo(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") {
    // JS renders integer numbers without a decimal ("3705639", never "3705639.0").
    return Number.isFinite(v) ? String(v) : "";
  }
  let s = String(v).trim();
  const floatArtifact = s.match(/^(\d+)\.0+$/);
  if (floatArtifact) s = floatArtifact[1]!;
  return s.toUpperCase();
}

/** Parse an amount cell: numbers pass through; strings shed "$", ",", spaces. */
export function parseAmount(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Days between the Sheets/Excel epoch (1899-12-30) and the Unix epoch. */
const SHEETS_EPOCH_OFFSET_DAYS = 25569;

/**
 * A Sheets serial date -> ms epoch. Serials are in the sheet's timezone (the
 * forms are US-based, so up to a few hours' skew vs UTC) — accepted for
 * closedate purposes.
 */
export function sheetSerialToMs(serial: number): number {
  return Math.round((serial - SHEETS_EPOCH_OFFSET_DAYS) * 86_400_000);
}

/** Timestamp cell (serial number or date-ish string) -> ms epoch, null if unparseable. */
export function parseTimestampMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return sheetSerialToMs(v);
  const s = cellText(v);
  if (!s) return null;
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The `showroom_order_key` dedupe key: `{agencyKey}:{po}:{brandSlug}`, falling
 * back to the (immutable) form-submission timestamp when the PO is blank.
 * Brand is included because one PO can legitimately split across brands —
 * without it the second brand's row would silently overwrite the first's deal.
 */
export function deriveOrderKey(
  agencyKey: string,
  po: string,
  brand: string,
  timestampMs: number | null,
): string {
  const brandSlug =
    brand
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "none";
  const mid = po || `ts${timestampMs ?? 0}`;
  return `${agencyKey}:${mid}:${brandSlug}`;
}

/**
 * Parse the raw values grid of one agency sheet. Rows producing the same
 * orderKey keep the LATEST row (a re-submission correcting an earlier entry)
 * and emit a warning, so one run never sends duplicate ids in a batch.
 */
export function parseShowroomRows(
  values: unknown[][],
  sheet: ShowroomSheet,
): ParsedShowroomSheet {
  const warnings: string[] = [];
  const label = `${sheet.agencyName} (${sheet.tab ?? SHOWROOM_DEFAULT_TAB})`;
  if (!values.length) {
    warnings.push(`${label}: sheet is empty`);
    return { orders: [], warnings };
  }

  const header = values[0]!.map(normalizeHeader);
  const col = new Map<ColumnKey, number>();
  for (const c of COLUMNS) {
    const idx = header.findIndex((h) => h && c.matches.some((m) => h.includes(m)));
    if (idx === -1) {
      warnings.push(`${label}: column "${c.key}" not found in header row`);
    } else {
      col.set(c.key, idx);
    }
  }

  const get = (row: unknown[], key: ColumnKey): unknown => {
    const idx = col.get(key);
    return idx === undefined ? undefined : row[idx];
  };

  const byKey = new Map<string, ShowroomOrder>();
  for (let i = 1; i < values.length; i++) {
    const row = values[i]!;
    const rowNo = i + 1;
    if (!row.some((v) => cellText(v) !== "")) continue; // trailing blank rows

    const timestampMs = parseTimestampMs(get(row, "timestamp"));
    const accountName = cellText(get(row, "accountName"));
    const brand = cellText(get(row, "brand"));
    const po = normalizePo(get(row, "po"));
    const amount = parseAmount(get(row, "amount"));

    // A row with none of the business fields is noise (e.g. a stray edit), not an order.
    if (!accountName && !po && amount === null) {
      warnings.push(`${label} row ${rowNo}: no account/PO/amount — skipped`);
      continue;
    }
    if (amount === null) {
      warnings.push(`${label} row ${rowNo}: unparseable amount "${cellText(get(row, "amount"))}"`);
    }
    if (!po && timestampMs === null) {
      warnings.push(`${label} row ${rowNo}: blank PO and unparseable timestamp — skipped (no stable key)`);
      continue;
    }

    const order: ShowroomOrder = {
      agencyKey: sheet.agencyKey,
      agencyName: sheet.agencyName,
      row: rowNo,
      timestampMs,
      submittedBy: cellText(get(row, "email")),
      salesRep: cellText(get(row, "salesRep")),
      accountName,
      accountNumber: normalizePo(get(row, "accountNumber")),
      orderSource: cellText(get(row, "orderSource")),
      tradeShow: cellText(get(row, "tradeShow")),
      brand,
      po,
      amount,
      orderKey: deriveOrderKey(sheet.agencyKey, po, brand, timestampMs),
    };

    const prior = byKey.get(order.orderKey);
    if (prior) {
      warnings.push(
        `${label} row ${rowNo}: duplicate key ${order.orderKey} (also row ${prior.row}) — keeping the later row`,
      );
    }
    byKey.set(order.orderKey, order);
  }

  return { orders: [...byKey.values()], warnings };
}
