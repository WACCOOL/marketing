/**
 * Deal stage + close date derivation — absorbs two HubSpot workflows into the
 * SAP -> HubSpot push (and the territory-sync close-date reconcile):
 *
 *   - wf 1741406037 "Update Deal Stage based on Project Stage changes":
 *     stage_of_project -> dealstage mapping (all 8 SAP picklist values), with
 *     AWARDED + closedate known -> Closed Won.
 *   - wf 1765878069 "Set Close Date for Deal based on Line Item Conversion Date":
 *     Awarded deals whose line items carry quote_conversion_date get
 *     closedate = OLDEST conversion date, then Closed Won.
 *
 * Business semantics: Awarded = order promised but not received (no line-item
 * conversion date, no closedate). Closed Won = an order was actually received
 * (a quote line converted to a sales order); closedate = the first order date.
 *
 * closedate is written as NOON UTC on the source day (see closeDateNoonUtcMs),
 * mirroring deriveCreateDate: closedate is a datetime rendered in the portal
 * timezone (ET), so midnight UTC displays as the PREVIOUS evening — and sorts
 * before the noon-UTC backdated createdate on same-day deals, turning
 * days-to-close math negative. The source dates (line-item
 * quote_conversion_date etc.) stay date-typed midnight-UTC values; only the
 * closedate written from them gets the noon anchor.
 *
 * Two deliberate strengthenings over the workflows:
 *   - closedate is MAINTAINED, not set-once: corrected whenever it drifts from
 *     the oldest conversion date (repairs backfilled deals whose closedate was
 *     stamped at stage-move time). The noon anchor rides this: legacy
 *     midnight-UTC closedates read as drift and get normalized on the next
 *     push/reconcile touch.
 *   - stage writes are gated on stage_of_project actually CHANGING (mirrors the
 *     workflow trigger, so manual stage moves in HubSpot survive), EXCEPT the
 *     Awarded -> Closed Won promotion which is ungated (wf B parity — this is
 *     what un-sticks deals the broken workflow missed).
 *
 * Third derived output (no workflow ancestry): deal-level quote_conversion_date
 * mirrors the OLDEST line-item quote_conversion_date on every deal — ungated by
 * stage, stage_of_project, or pipeline (pure SAP-data mirror, unlike closedate
 * which carries won/lost semantics). Diff-only, maintained like closedate,
 * never cleared when no line carries a conversion date.
 *
 * Pure: no I/O. The Worker feeds it raw SAP payload values; the reconcile feeds
 * it HubSpot property values (toEpochMs accepts both).
 */

import { toHubspotDate } from "./mapping.js";
import type { FixAction } from "./heal.js";

export const UNIVERSAL_PIPELINE_ID = "723098519";

/** Universal Pipeline deal stages. Keys are stable internal names. */
export const DEAL_STAGE_IDS = {
  prequal: "1054295849",
  planning: "1054295850",
  db: "1054295851",
  bidding: "1054295852",
  awarded: "1240424232",
  closedWon: "1054295854",
  closedLost: "1054295855",
} as const;

const STAGE_LABELS: Record<string, string> = {
  [DEAL_STAGE_IDS.prequal]: "Pre-Qualified",
  [DEAL_STAGE_IDS.planning]: "Planning",
  [DEAL_STAGE_IDS.db]: "Design & Budgeting",
  [DEAL_STAGE_IDS.bidding]: "Bidding & Negotiating",
  [DEAL_STAGE_IDS.awarded]: "Awarded",
  [DEAL_STAGE_IDS.closedWon]: "Closed Won",
  [DEAL_STAGE_IDS.closedLost]: "Closed Lost",
};

/** SAP stage_of_project (trim+UPPER) -> dealstage, excluding AWARDED (special-cased). */
const STAGE_BY_PROJECT_STAGE: Record<string, string> = {
  BIDDING: DEAL_STAGE_IDS.bidding,
  REBIDDING: DEAL_STAGE_IDS.bidding,
  BUDGETING: DEAL_STAGE_IDS.db,
  "DESIGN PHASE": DEAL_STAGE_IDS.db,
  "VALUE ENGINEERING": DEAL_STAGE_IDS.db,
  REJECTED: DEAL_STAGE_IDS.closedLost,
  "COVID-19 HOLD": DEAL_STAGE_IDS.closedLost,
};

const OPEN_STAGES: ReadonlySet<string> = new Set([
  DEAL_STAGE_IDS.prequal,
  DEAL_STAGE_IDS.planning,
  DEAL_STAGE_IDS.db,
  DEAL_STAGE_IDS.bidding,
]);

/**
 * ms epoch from any date shape this pipeline sees: SAP strings (MM/DD/YYYY,
 * YYYY-MM-DD, YYYYMMDD — via toHubspotDate, sentinels -> null), ms-epoch
 * numbers/strings (HubSpot date properties), or ISO datetimes (HubSpot
 * datetime properties like closedate).
 */
export function toEpochMs(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const d = toHubspotDate(s);
  if (d !== null) return d;
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const DAY_MS = 86_400_000;
const NOON_MS = DAY_MS / 2;

/**
 * Noon UTC on the given instant's UTC day — the anchor every derived closedate
 * is written at. Same convention (and reasoning) as deriveCreateDate: noon UTC
 * shows the same calendar day in every US zone, and keeps a same-day
 * close >= the noon-UTC backdated createdate (non-negative days-to-close).
 */
export function closeDateNoonUtcMs(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS + NOON_MS;
}

export interface DealLineDates {
  conversionMs: number | null;
  rejectionMs: number | null;
}

/**
 * Extract conversion/rejection dates from line-item bags. Works on raw SAP
 * `products` entries and on HubSpot line-item `properties` alike — both use
 * the field names quote_conversion_date / rejection_date.
 */
export function lineItemDates(items: Array<Record<string, unknown>>): DealLineDates[] {
  return items.map((it) => ({
    conversionMs: toEpochMs(it?.quote_conversion_date),
    rejectionMs: toEpochMs(it?.rejection_date),
  }));
}

export interface ExistingDealState {
  stageOfProject: string | null;
  dealstage: string | null;
  /** Parse the HubSpot closedate value via toEpochMs before passing. */
  closedateMs: number | null;
  pipeline: string | null;
  /** Deal-level quote_conversion_date via toEpochMs; optional for older callers. */
  quoteConversionDateMs?: number | null;
}

export interface DeriveDealStageOptions {
  /** Write closedate on Closed Lost deals (newest rejection_date, fallback quote_last_changed_date). Default false. */
  lostCloseDates?: boolean;
  /** Clear closedate when the stage gate passes into an open stage (deal reopened). Default false. */
  clearCloseDateOnReopen?: boolean;
}

export interface DeriveDealStageInput {
  /** Incoming SAP stage_of_project (raw; null/blank = no stage signal). */
  stageOfProject: string | null | undefined;
  /** Existing HubSpot deal state; null = new deal. */
  existing: ExistingDealState | null;
  lineItems: DealLineDates[];
  /** Lost-rule fallback when no line carries a rejection_date. */
  quoteLastChangedMs?: number | null;
  options?: DeriveDealStageOptions;
}

export interface DeriveDealStageResult {
  /** dealstage? closedate? ("" = clear) pipeline? (new deals only) quote_conversion_date? — diff-only, {} = nothing to write. */
  properties: Record<string, string>;
  actions: FixAction[];
}

function label(stageId: string): string {
  return STAGE_LABELS[stageId] ?? stageId;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Decide the dealstage + closedate writes for one deal. Diff-only and
 * idempotent: feeding the result back in yields {}.
 */
export function deriveDealStageAndCloseDate(i: DeriveDealStageInput): DeriveDealStageResult {
  const properties: Record<string, string> = {};
  const actions: FixAction[] = [];
  const opts = i.options ?? {};
  const existing = i.existing;
  const isNew = existing === null;

  // Stage ids are pipeline-specific — never write dealstage on a deal that
  // lives outside the Universal Pipeline (closedate rules still apply).
  const pipelineOk = isNew || !existing.pipeline || existing.pipeline === UNIVERSAL_PIPELINE_ID;

  const sop = i.stageOfProject != null ? String(i.stageOfProject).trim().toUpperCase() : "";
  const existingSop = existing?.stageOfProject != null ? existing.stageOfProject.trim().toUpperCase() : "";
  const sopChanged = isNew || (sop !== "" && sop !== existingSop);

  const existingClosedateMs = existing?.closedateMs ?? null;
  const conversions = i.lineItems.map((l) => l.conversionMs).filter((ms): ms is number => ms !== null);
  const oldestConversionMs = conversions.length ? Math.min(...conversions) : null;

  // ---- stage decision -------------------------------------------------------
  let targetStage: string | null = null;
  let stageReason = "";

  if (sop && sopChanged && pipelineOk) {
    if (sop === "AWARDED") {
      // Order received (conversion date) or closedate already known -> Closed Won;
      // otherwise promised-but-unordered -> Awarded.
      const won = existingClosedateMs !== null || oldestConversionMs !== null;
      targetStage = won ? DEAL_STAGE_IDS.closedWon : DEAL_STAGE_IDS.awarded;
      stageReason = won
        ? `stage_derived — stage_of_project AWARDED + closedate known → ${label(targetStage)}`
        : `stage_derived — stage_of_project AWARDED → ${label(targetStage)}`;
    } else if (STAGE_BY_PROJECT_STAGE[sop]) {
      targetStage = STAGE_BY_PROJECT_STAGE[sop];
      stageReason = `stage_derived — stage_of_project ${sop} → ${label(targetStage)}`;
    }
  }

  // Awarded -> Closed Won promotion (wf B parity, deliberately UNGATED): an
  // Awarded deal whose closedate is known or becomes known in this write is won.
  if (
    !targetStage &&
    pipelineOk &&
    existing?.dealstage === DEAL_STAGE_IDS.awarded &&
    (existingClosedateMs !== null || oldestConversionMs !== null)
  ) {
    targetStage = DEAL_STAGE_IDS.closedWon;
    stageReason = "stage_derived — awarded → closed-won promotion (closedate known)";
  }

  if (targetStage && targetStage !== existing?.dealstage) {
    properties.dealstage = targetStage;
    actions.push({
      property: "dealstage",
      from: existing?.dealstage ?? undefined,
      to: targetStage,
      action: "derived",
      reason: stageReason,
    });
    if (isNew) properties.pipeline = UNIVERSAL_PIPELINE_ID;
  }

  // ---- close-date decision --------------------------------------------------
  // Keyed off the EFFECTIVE stage (after the decision above), so a deal a human
  // dragged to an open stage gets no closedate writes even while SAP says AWARDED.
  const effectiveStage = properties.dealstage ?? existing?.dealstage ?? null;

  const writeClosedate = (sourceMs: number, source: string) => {
    const desiredMs = closeDateNoonUtcMs(sourceMs);
    if (existingClosedateMs === null) {
      properties.closedate = String(desiredMs);
      actions.push({
        property: "closedate",
        to: String(desiredMs),
        action: "derived",
        reason: `closedate_set — ${source} ${isoDay(desiredMs)}`,
      });
    } else if (existingClosedateMs !== desiredMs) {
      properties.closedate = String(desiredMs);
      actions.push({
        property: "closedate",
        from: String(existingClosedateMs),
        to: String(desiredMs),
        action: "derived",
        reason: `closedate_corrected — ${isoDay(existingClosedateMs)} → ${isoDay(desiredMs)} (${source})`,
      });
    }
  };

  if (effectiveStage === DEAL_STAGE_IDS.awarded || effectiveStage === DEAL_STAGE_IDS.closedWon) {
    // No conversion dates -> leave closedate untouched (preserves the manual
    // closedate -> Closed Won path from wf A).
    if (oldestConversionMs !== null) writeClosedate(oldestConversionMs, "oldest quote_conversion_date");
  } else if (effectiveStage === DEAL_STAGE_IDS.closedLost && opts.lostCloseDates) {
    const rejections = i.lineItems.map((l) => l.rejectionMs).filter((ms): ms is number => ms !== null);
    const newestRejectionMs = rejections.length ? Math.max(...rejections) : null;
    if (newestRejectionMs !== null) writeClosedate(newestRejectionMs, "newest rejection_date");
    else if (i.quoteLastChangedMs != null) writeClosedate(i.quoteLastChangedMs, "quote_last_changed_date");
  } else if (
    opts.clearCloseDateOnReopen &&
    properties.dealstage !== undefined &&
    OPEN_STAGES.has(properties.dealstage) &&
    existingClosedateMs !== null
  ) {
    // Deal reopened (gate passed into an open stage) — a lingering closedate is
    // now wrong. Opt-in: the reconcile never clears, the live push may.
    properties.closedate = "";
    actions.push({
      property: "closedate",
      from: String(existingClosedateMs),
      to: "",
      action: "derived",
      reason: `closedate_cleared — reopened (${existingSop || "?"} → ${sop || "?"})`,
    });
  }

  // ---- deal-level quote_conversion_date mirror ------------------------------
  // Ungated: unlike closedate this carries no won/lost meaning, it just surfaces
  // the oldest line-item conversion date on the deal for reporting/filters.
  const existingConversionMs = existing?.quoteConversionDateMs ?? null;
  if (oldestConversionMs !== null && oldestConversionMs !== existingConversionMs) {
    properties.quote_conversion_date = String(oldestConversionMs);
    actions.push({
      property: "quote_conversion_date",
      from: existingConversionMs !== null ? String(existingConversionMs) : undefined,
      to: String(oldestConversionMs),
      action: "derived",
      reason:
        existingConversionMs === null
          ? `conversion_date_set — oldest quote_conversion_date ${isoDay(oldestConversionMs)}`
          : `conversion_date_corrected — ${isoDay(existingConversionMs)} → ${isoDay(oldestConversionMs)}`,
    });
  }

  return { properties, actions };
}
