/**
 * Deal createdate derivation — keeps HubSpot's system `createdate` honest for
 * SAP deals. `createdate` is stamped when the record is created IN HUBSPOT, so
 * bulk-backfilled/imported deals carry an import date, not the real quote date;
 * the true date lives in `quote_creation_date` (SAP-fed date property). Deals
 * are the one HubSpot object whose createdate the API accepts (create AND
 * update) — contacts/companies reject it.
 *
 * Rule: when the earliest SAP signal day — quote_creation_date or the oldest
 * line-item quote_conversion_date, whichever is older — is STRICTLY BEFORE the
 * reference day (the existing createdate, or "now" on the create path),
 * backdate createdate to that day. Never moves createdate forward (deals
 * created manually in HubSpot before SAP synced keep their earlier date),
 * never touches same-day deals.
 *
 * The conversion date participates because SAP routinely dates the sales-order
 * document BEFORE the quote's system creation stamp (order arrives, quote is
 * keyed retroactively — 15.5k deals, median gap 1 day, max 13). A deal cannot
 * convert before it existed, so the SO date bounds the real-world start; without
 * it those deals close before they're created and days-to-close goes negative.
 *
 * The value written is NOON UTC on the quote day, not midnight:
 * `quote_creation_date` is date-typed (midnight-UTC ms), but createdate is a
 * datetime rendered in the portal timezone (ET) — midnight UTC would display as
 * the PREVIOUS evening. Noon UTC shows the same calendar day in every US zone.
 *
 * Pure: no I/O. The Worker feeds it SAP payload values; the reconcile feeds it
 * HubSpot property values (parse both via toEpochMs before passing).
 */

import type { FixAction } from "./heal.js";

const DAY_MS = 86_400_000;
const NOON_MS = DAY_MS / 2;

function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export interface DeriveCreateDateInput {
  /** quote_creation_date as ms epoch (toEpochMs), null when absent. */
  quoteCreationMs: number | null;
  /** Oldest line-item quote_conversion_date (or the deal-level mirror) as ms
   *  epoch; optional for older callers. Bounds the start when SAP dates the SO
   *  before the quote's creation stamp. */
  oldestConversionMs?: number | null;
  /** Existing HubSpot createdate as ms epoch (toEpochMs); null = create path. */
  existingCreateDateMs: number | null;
  /** Injected clock (create-path reference + testability). */
  nowMs: number;
}

export interface DeriveCreateDateResult {
  /** createdate? (ms-epoch string, noon UTC on the quote day) — {} = nothing to write. */
  properties: Record<string, string>;
  actions: FixAction[];
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Decide the createdate write for one deal. Diff-only and idempotent: the
 * corrected value lands on the quote day, so feeding it back in yields {}.
 */
export function deriveCreateDate(i: DeriveCreateDateInput): DeriveCreateDateResult {
  const properties: Record<string, string> = {};
  const actions: FixAction[] = [];

  const conversionMs = i.oldestConversionMs ?? null;
  if (i.quoteCreationMs === null && conversionMs === null) return { properties, actions };

  const conversionWins =
    conversionMs !== null && (i.quoteCreationMs === null || conversionMs < i.quoteCreationMs);
  const signalMs = conversionWins ? conversionMs : (i.quoteCreationMs as number);
  const source = conversionWins
    ? "oldest quote_conversion_date (SO dated before quote entry)"
    : "quote_creation_date";

  const signalDay = utcDayStart(signalMs);
  const referenceMs = i.existingCreateDateMs ?? i.nowMs;
  if (signalDay >= utcDayStart(referenceMs)) return { properties, actions };

  const target = signalDay + NOON_MS;
  properties.createdate = String(target);
  actions.push({
    property: "createdate",
    from: i.existingCreateDateMs !== null ? String(i.existingCreateDateMs) : undefined,
    to: String(target),
    action: "derived",
    reason:
      i.existingCreateDateMs !== null
        ? `createdate_backdated — ${isoDay(i.existingCreateDateMs)} → ${isoDay(target)} (${source})`
        : `createdate_backdated — new deal backdated to ${source} ${isoDay(target)}`,
  });
  return { properties, actions };
}
