/**
 * Deal amount derivation — keeps `amount` equal to the quote's TOTAL value.
 *
 * SAP's `quote_net_value` header tracks the quote's OPEN value: it shrinks as
 * lines convert to sales orders and hits 0.00 when the quote fully converts —
 * which is exactly what moves a deal to Closed Won. A straight pass-through
 * therefore lands every fully-converted deal at $0 (and understates partially
 * converted ones). The line items in the same payload keep their real
 * quantity × unit price, and their sum reproduces the original header value
 * exactly (verified against deals whose header was still untouched), so the
 * lines are the durable source of truth.
 *
 * Rule: when the payload carries ≥1 line with a finite quantity AND unit price,
 * amount = round(Σ quantity × unitPrice, 2) — qty-0 "quote text" lines
 * contribute 0 naturally. With no usable lines the header passes through,
 * EXCEPT a 0/absent header must never clobber an existing nonzero amount
 * (that's SAP's post-conversion zero arriving without line data).
 *
 * Pure: no I/O. The Worker feeds it SAP payload values; the reconcile script
 * feeds it HubSpot line-item properties.
 */

import type { FixAction } from "./heal.js";

export interface DealAmountLine {
  /** SAP item_quantity ("12.000") or HubSpot line-item quantity. */
  quantity: unknown;
  /** SAP unit_price ("481.95") or HubSpot line-item price. */
  unitPrice: unknown;
}

export interface DeriveDealAmountInput {
  /** The mapped quote_net_value (SAP open value) — string/number/undefined. */
  headerAmount: unknown;
  /** Line items from the payload (or HubSpot) — empty when none. */
  lines: DealAmountLine[];
  /** Existing HubSpot deal amount, null on the create path / when unset. */
  existingAmount: number | null;
}

export interface DeriveDealAmountResult {
  /** amount? — absent = leave the mapped pass-through (or nothing) in place. */
  properties: Record<string, number>;
  actions: FixAction[];
  /** True when the mapped `amount` must NOT be written (0 over nonzero guard). */
  dropAmount: boolean;
}

function toFinite(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/** Sum quantity × unitPrice over lines where BOTH parse; null when none do. */
export function sumLineAmounts(lines: DealAmountLine[]): number | null {
  let sum = 0;
  let usable = 0;
  for (const l of lines) {
    const qty = toFinite(l.quantity);
    const price = toFinite(l.unitPrice);
    if (qty === null || price === null) continue;
    usable++;
    sum += qty * price;
  }
  return usable > 0 ? Math.round(sum * 100) / 100 : null;
}

/**
 * Decide the amount write for one deal. Idempotent: feeding the derived amount
 * back as headerAmount with the same lines yields the same value.
 */
export function deriveDealAmount(i: DeriveDealAmountInput): DeriveDealAmountResult {
  const properties: Record<string, number> = {};
  const actions: FixAction[] = [];
  const header = toFinite(i.headerAmount);

  const lineTotal = sumLineAmounts(i.lines);
  if (lineTotal !== null) {
    properties.amount = lineTotal;
    if (header === null || header !== lineTotal) {
      actions.push({
        property: "amount",
        from: header !== null ? String(header) : undefined,
        to: String(lineTotal),
        action: "derived",
        reason:
          "amount_from_line_items — SAP quote_net_value tracks open value (0 once converted); derived Σ quantity × unit_price",
      });
    }
    return { properties, actions, dropAmount: false };
  }

  // No usable lines: keep the header pass-through, but never let a 0/absent
  // header wipe out a real amount already on the deal.
  if ((header === null || header === 0) && i.existingAmount !== null && i.existingAmount > 0) {
    actions.push({
      property: "amount",
      from: String(i.existingAmount),
      action: "dropped",
      reason:
        "amount_zero_guard — payload has no line items and a 0/absent quote_net_value; kept the existing nonzero amount",
    });
    return { properties, actions, dropAmount: true };
  }

  return { properties, actions, dropAmount: false };
}
