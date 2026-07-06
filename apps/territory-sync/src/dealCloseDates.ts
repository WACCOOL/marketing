import * as fs from "node:fs";
import {
  DEAL_STAGE_IDS,
  UNIVERSAL_PIPELINE_ID,
  deriveDealStageAndCloseDate,
  toEpochMs,
  type DealLineDates,
} from "@wac/shared";
import { hs } from "./insideSales.js";

/**
 * Deal stage + close-date reconcile — the backfill/audit companion of the
 * absorbed HubSpot workflows (1741406037 stage mapping, 1765878069 close date
 * from line-item conversion). Sweeps every SAP deal in the Universal Pipeline
 * and applies the SAME shared derivation the live push uses
 * (@wac/shared deriveDealStageAndCloseDate), with stageOfProject = the value
 * already on the deal, so the stage gate self-blocks and the only writes are:
 *
 *   - Awarded → Closed Won promotions (deals the broken workflow left stuck),
 *   - closedate set/corrected to the oldest line-item quote_conversion_date
 *     (won deals; repairs closedates stamped at stage-move/backfill time),
 *   - deal-level quote_conversion_date set/corrected to the oldest line-item
 *     conversion date on EVERY SAP deal (ungated by stage — this is why the
 *     sweep considers all Universal Pipeline SAP deals, not just closed ones),
 *   - optionally (--include-lost) closedate on Closed Lost deals from the
 *     newest rejection_date, fallback quote_last_changed_date. Lost proposals
 *     are always REPORTED; they're only APPLIED with the flag.
 *
 * Audit-first: run --dry-run (optionally --csv=path) and review before applying.
 * Diff-only and idempotent — verify by re-running --dry-run until all change
 * counters are 0. Never clears closedate (clearCloseDateOnReopen stays off here).
 */

const SCAN_PROPS = [
  "sap_quote_number",
  "dealname",
  "stage_of_project",
  "dealstage",
  "closedate",
  "pipeline",
  "quote_last_changed_date",
  "quote_conversion_date",
].join(",");

const ASSOC_BATCH = 500; // v4 associations batch/read input cap headroom
const LINE_BATCH = 100;
const UPDATE_BATCH = 100;

interface CandidateDeal {
  id: string;
  quote: string;
  dealname: string;
  stageOfProject: string | null;
  dealstage: string | null;
  closedateRaw: string | null;
  quoteLastChangedRaw: string | null;
  quoteConversionRaw: string | null;
}

export interface CloseDateChange {
  dealId: string;
  quote: string;
  dealname: string;
  stageOfProject: string;
  dealstageBefore: string;
  dealstageAfter: string;
  closedateBefore: string;
  closedateAfter: string;
  conversionBefore: string;
  conversionAfter: string;
  deltaDays: number | null;
  rule: "won" | "lost";
  source: string;
  applied: boolean;
}

export interface DealCloseDateReconcileResult {
  scanned: number;
  candidates: number;
  withLineDates: number;
  stagePromotions: number;
  closedatesSet: number;
  closedatesCorrected: number;
  conversionDatesSet: number;
  conversionDatesCorrected: number;
  lostProposals: number;
  updated: number;
  changes: CloseDateChange[];
  failures: string[];
}

function isoDay(ms: number | null): string {
  return ms === null ? "" : new Date(ms).toISOString().slice(0, 10);
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** All line-item ids associated to the given deals (v4 batch read + per-deal paging). */
async function fetchLineItemIdsByDeal(
  token: string,
  dealIds: string[],
): Promise<Map<string, string[]>> {
  const byDeal = new Map<string, string[]>();
  for (let i = 0; i < dealIds.length; i += ASSOC_BATCH) {
    const chunk = dealIds.slice(i, i + ASSOC_BATCH);
    const res = await hs(token, "POST", "/crm/v4/associations/deals/line_items/batch/read", {
      inputs: chunk.map((id) => ({ id })),
    });
    if (!res.ok) {
      throw new Error(`assoc batch/read ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    for (const r of res.data?.results ?? []) {
      const dealId = String(r?.from?.id ?? "");
      if (!dealId) continue;
      const ids = byDeal.get(dealId) ?? [];
      for (const t of r?.to ?? []) {
        if (t?.toObjectId != null) ids.push(String(t.toObjectId));
      }
      byDeal.set(dealId, ids);
      // >LIMIT-line deals (rare but real — wf B paginated too): follow the
      // per-deal paging cursor via the single-object endpoint.
      let after: string | undefined = r?.paging?.next?.after;
      while (after) {
        const page = await hs(
          token,
          "GET",
          `/crm/v4/objects/deals/${dealId}/associations/line_items?limit=500&after=${encodeURIComponent(after)}`,
        );
        if (!page.ok) {
          throw new Error(`assoc page ${page.status}: ${JSON.stringify(page.data).slice(0, 300)}`);
        }
        for (const t of page.data?.results ?? []) {
          if (t?.toObjectId != null) ids.push(String(t.toObjectId));
        }
        after = page.data?.paging?.next?.after;
      }
    }
  }
  return byDeal;
}

/** Batch-read conversion/rejection dates for the given line items. */
async function fetchLineDates(
  token: string,
  lineItemIds: string[],
): Promise<Map<string, DealLineDates>> {
  const out = new Map<string, DealLineDates>();
  for (let i = 0; i < lineItemIds.length; i += LINE_BATCH) {
    const chunk = lineItemIds.slice(i, i + LINE_BATCH);
    const res = await hs(token, "POST", "/crm/v3/objects/line_items/batch/read", {
      properties: ["quote_conversion_date", "rejection_date"],
      inputs: chunk.map((id) => ({ id })),
    });
    // Batch read 404s when ALL ids are gone; tolerate and skip (archived lines).
    if (!res.ok && res.status !== 404) {
      throw new Error(`line_items batch/read ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    for (const li of res.data?.results ?? []) {
      const p = li?.properties ?? {};
      out.set(String(li.id), {
        conversionMs: toEpochMs(p.quote_conversion_date),
        rejectionMs: toEpochMs(p.rejection_date),
      });
    }
  }
  return out;
}

export async function reconcileDealCloseDates(opts: {
  token: string;
  dryRun: boolean;
  limit?: number;
  includeLost: boolean;
  csvPath?: string;
}): Promise<DealCloseDateReconcileResult> {
  const { token, dryRun, limit, includeLost, csvPath } = opts;
  const failures: string[] = [];

  // ---- 1. scan every deal, keep the SAP candidates -------------------------
  const candidates: CandidateDeal[] = [];
  let scanned = 0;
  let after: string | undefined;
  do {
    const qs = `?limit=100&properties=${SCAN_PROPS}${after ? `&after=${after}` : ""}`;
    const res = await hs(token, "GET", `/crm/v3/objects/0-3${qs}`);
    if (!res.ok) throw new Error(`deals list ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    for (const d of res.data?.results ?? []) {
      scanned++;
      const p = d.properties ?? {};
      if (String(p.pipeline ?? "") !== UNIVERSAL_PIPELINE_ID) continue;
      const quote = String(p.sap_quote_number ?? "").trim();
      if (!quote) continue; // SAP deals only — showroom/manual deals are out of scope
      // Every SAP deal is a candidate: the conversion-date mirror applies to all
      // stages, and the shared derivation's own gates keep stage/closedate
      // writes confined to the closed/awarded cases exactly as before.
      candidates.push({
        id: String(d.id),
        quote,
        dealname: String(p.dealname ?? ""),
        stageOfProject: p.stage_of_project != null ? String(p.stage_of_project) : null,
        dealstage: p.dealstage != null ? String(p.dealstage) : null,
        closedateRaw: p.closedate != null ? String(p.closedate) : null,
        quoteLastChangedRaw: p.quote_last_changed_date != null ? String(p.quote_last_changed_date) : null,
        quoteConversionRaw: p.quote_conversion_date != null ? String(p.quote_conversion_date) : null,
      });
    }
    if (scanned % 10_000 < 100) console.log(`[close-dates] scanned ${scanned} deals, candidates so far ${candidates.length}`);
    after = res.data?.paging?.next?.after;
    if (limit && scanned >= limit) break;
  } while (after);
  console.log(`[close-dates] scan done: ${scanned} deals, ${candidates.length} candidates`);

  // ---- 2. line-item conversion/rejection dates per candidate ---------------
  const lineIdsByDeal = await fetchLineItemIdsByDeal(token, candidates.map((c) => c.id));
  const allLineIds = [...lineIdsByDeal.values()].flat();
  console.log(`[close-dates] ${allLineIds.length} line items across ${lineIdsByDeal.size} deals; reading dates…`);
  const datesByLine = await fetchLineDates(token, allLineIds);

  // ---- 3. derive with the SAME shared function the live push uses ----------
  const changes: CloseDateChange[] = [];
  const pending: { id: string; properties: Record<string, string> }[] = [];
  let withLineDates = 0;
  let stagePromotions = 0;
  let closedatesSet = 0;
  let closedatesCorrected = 0;
  let conversionDatesSet = 0;
  let conversionDatesCorrected = 0;
  let lostProposals = 0;
  let updated = 0;

  const flush = async () => {
    if (!pending.length) return;
    if (!dryRun) {
      for (let i = 0; i < pending.length; i += UPDATE_BATCH) {
        const inputs = pending.slice(i, i + UPDATE_BATCH);
        const res = await hs(token, "POST", "/crm/v3/objects/0-3/batch/update", { inputs });
        if (!res.ok) {
          throw new Error(`deal batch/update ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
        }
      }
    }
    updated += pending.length;
    pending.length = 0;
  };

  for (const c of candidates) {
    const lineItems = (lineIdsByDeal.get(c.id) ?? [])
      .map((id) => datesByLine.get(id))
      .filter((d): d is DealLineDates => d !== undefined);
    if (lineItems.some((l) => l.conversionMs !== null || l.rejectionMs !== null)) withLineDates++;

    const closedateMs = toEpochMs(c.closedateRaw);
    const conversionMs = toEpochMs(c.quoteConversionRaw);
    // Lost proposals are always computed (audit visibility); applied only with --include-lost.
    const derived = deriveDealStageAndCloseDate({
      stageOfProject: c.stageOfProject, // = stored value → the stage gate self-blocks; only promotions pass
      existing: {
        stageOfProject: c.stageOfProject,
        dealstage: c.dealstage,
        closedateMs,
        pipeline: UNIVERSAL_PIPELINE_ID,
        quoteConversionDateMs: conversionMs,
      },
      lineItems,
      quoteLastChangedMs: toEpochMs(c.quoteLastChangedRaw),
      options: { lostCloseDates: true, clearCloseDateOnReopen: false },
    });
    if (!Object.keys(derived.properties).length) continue;

    // The gate self-blocks mapping writes and promotion needs dealstage=Awarded,
    // so a closedate on a Closed Lost deal is exactly "the lost rule fired".
    // The lost gate covers ONLY closedate — the conversion-date mirror is
    // stage-agnostic and applies to lost deals too.
    const isLost = c.dealstage === DEAL_STAGE_IDS.closedLost;
    const applyProps = { ...derived.properties };
    if (isLost && !includeLost) delete applyProps.closedate;
    const apply = Object.keys(applyProps).length > 0;

    if (derived.properties.dealstage) stagePromotions++;
    const cdAction = derived.actions.find((a) => a.property === "closedate");
    if (cdAction && isLost) lostProposals++;
    else if (cdAction?.reason?.startsWith("closedate_set")) closedatesSet++;
    else if (cdAction?.reason?.startsWith("closedate_corrected")) closedatesCorrected++;
    const convAction = derived.actions.find((a) => a.property === "quote_conversion_date");
    if (convAction?.reason?.startsWith("conversion_date_set")) conversionDatesSet++;
    else if (convAction?.reason?.startsWith("conversion_date_corrected")) conversionDatesCorrected++;

    const afterMs = derived.properties.closedate ? Number(derived.properties.closedate) : closedateMs;
    const conversionAfterMs = derived.properties.quote_conversion_date
      ? Number(derived.properties.quote_conversion_date)
      : conversionMs;
    changes.push({
      dealId: c.id,
      quote: c.quote,
      dealname: c.dealname,
      stageOfProject: c.stageOfProject ?? "",
      dealstageBefore: c.dealstage ?? "",
      dealstageAfter: derived.properties.dealstage ?? c.dealstage ?? "",
      closedateBefore: isoDay(closedateMs),
      closedateAfter: isoDay(afterMs),
      conversionBefore: isoDay(conversionMs),
      conversionAfter: isoDay(conversionAfterMs),
      deltaDays:
        closedateMs !== null && afterMs !== null && derived.properties.closedate
          ? Math.round((afterMs - closedateMs) / 86_400_000)
          : null,
      rule: isLost ? "lost" : "won",
      source: cdAction?.reason ?? derived.actions[0]?.reason ?? "",
      applied: apply && !dryRun,
    });

    if (apply) {
      pending.push({ id: c.id, properties: applyProps });
      if (pending.length >= UPDATE_BATCH) await flush();
    }
  }
  await flush();

  // ---- 4. report ------------------------------------------------------------
  if (csvPath) {
    const header =
      "dealId,sap_quote_number,dealname,stage_of_project,dealstage_before,dealstage_after,closedate_before,closedate_after,conversion_before,conversion_after,delta_days,rule,source,applied";
    const rows = changes.map((ch) =>
      [
        ch.dealId,
        ch.quote,
        csvEscape(ch.dealname),
        ch.stageOfProject,
        ch.dealstageBefore,
        ch.dealstageAfter,
        ch.closedateBefore,
        ch.closedateAfter,
        ch.conversionBefore,
        ch.conversionAfter,
        ch.deltaDays ?? "",
        ch.rule,
        csvEscape(ch.source),
        String(ch.applied),
      ].join(","),
    );
    fs.writeFileSync(csvPath, [header, ...rows].join("\n") + "\n");
    console.log(`[close-dates] wrote ${changes.length} proposed changes to ${csvPath}`);
  }

  return {
    scanned,
    candidates: candidates.length,
    withLineDates,
    stagePromotions,
    closedatesSet,
    closedatesCorrected,
    conversionDatesSet,
    conversionDatesCorrected,
    lostProposals,
    updated,
    changes,
    failures,
  };
}
