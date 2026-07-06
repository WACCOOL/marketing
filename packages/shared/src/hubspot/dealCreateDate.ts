/**
 * Deal createdate derivation — keeps HubSpot's system `createdate` honest for
 * SAP deals. `createdate` is stamped when the record is created IN HUBSPOT, so
 * bulk-backfilled/imported deals carry an import date, not the real quote date;
 * the true date lives in `quote_creation_date` (SAP-fed date property). Deals
 * are the one HubSpot object whose createdate the API accepts (create AND
 * update) — contacts/companies reject it.
 *
 * Rule: when the quote-creation day is STRICTLY BEFORE the reference day (the
 * existing createdate, or "now" on the create path), backdate createdate to the
 * quote day. Never moves createdate forward, never touches same-day deals.
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

  if (i.quoteCreationMs === null) return { properties, actions };

  const quoteDay = utcDayStart(i.quoteCreationMs);
  const referenceMs = i.existingCreateDateMs ?? i.nowMs;
  if (quoteDay >= utcDayStart(referenceMs)) return { properties, actions };

  const target = quoteDay + NOON_MS;
  properties.createdate = String(target);
  actions.push({
    property: "createdate",
    from: i.existingCreateDateMs !== null ? String(i.existingCreateDateMs) : undefined,
    to: String(target),
    action: "derived",
    reason:
      i.existingCreateDateMs !== null
        ? `createdate_backdated — ${isoDay(i.existingCreateDateMs)} → ${isoDay(target)} (quote_creation_date)`
        : `createdate_backdated — new deal backdated to quote_creation_date ${isoDay(target)}`,
  });
  return { properties, actions };
}
