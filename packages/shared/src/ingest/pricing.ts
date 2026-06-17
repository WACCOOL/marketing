import { asIsoDate, asNumber, asString, field } from "./headers.js";
import type { ParseError, ParseResult } from "./types.js";

/**
 * Pricing parser — the four WAC price books (C1/D1/D6/D7) are SAP price-list
 * exports that share one clean schema:
 *   Sales org. | Price list type | Material | Amount | Unit | Valid From | Valid to
 * One row per Material (SKU). `Price list type` should match the upload's
 * variant; a mismatch is collected as a row error rather than silently trusted.
 */

export interface PricingRow {
  /** Price book key (c1/d1/d6/d7), lowercased. */
  variant: string;
  /** Material — the orderable SKU. */
  sku: string;
  price: number | null;
  currency: string;
  /** ISO yyyy-mm-dd, or null. */
  validFrom: string | null;
  validTo: string | null;
  salesOrg: string | null;
}

export function parsePricing(
  rows: Record<string, unknown>[],
  variant: string,
): ParseResult<PricingRow> {
  const want = variant.trim().toLowerCase();
  const errors: ParseError[] = [];
  let mismatched = 0;
  let superseded = 0;
  // One row per SKU. A SKU can legitimately appear twice (an old price + a newer
  // one, sometimes hidden behind a trailing non-breaking space that asString
  // trims away). Keep the row with the later `valid_from` — the current price.
  const bySku = new Map<string, PricingRow>();

  rows.forEach((raw, i) => {
    const rowIndex = i + 2; // 1-based + header row
    const messages: string[] = [];

    const sku = asString(field(raw, "Material"));
    if (!sku) messages.push("missing Material (SKU)");

    const price = asNumber(field(raw, "Amount"));
    if (price === null) messages.push("missing or non-numeric Amount");

    const ptype = asString(field(raw, "Price list type")).toLowerCase();
    if (ptype && ptype !== want) {
      messages.push(`Price list type '${ptype}' does not match variant '${want}'`);
      mismatched++;
    }

    if (messages.length > 0) {
      errors.push({ rowIndex, messages });
      return;
    }

    const candidate: PricingRow = {
      variant: want,
      sku,
      price,
      currency: asString(field(raw, "Unit")) || "USD",
      validFrom: asIsoDate(field(raw, "Valid From")),
      validTo: asIsoDate(field(raw, "Valid to")),
      salesOrg: asString(field(raw, "Sales org.")) || null,
    };

    const existing = bySku.get(sku);
    if (!existing) {
      bySku.set(sku, candidate);
      return;
    }
    // Duplicate SKU: keep the later valid_from (ISO yyyy-mm-dd sorts correctly;
    // null sorts oldest). Ties keep the last-seen row.
    superseded++;
    if ((candidate.validFrom ?? "") >= (existing.validFrom ?? "")) {
      bySku.set(sku, candidate);
    }
  });

  const valid = [...bySku.values()];
  return {
    valid,
    errors,
    stats: {
      totalRows: rows.length,
      valid: valid.length,
      mismatchedType: mismatched,
      superseded,
    },
  };
}
