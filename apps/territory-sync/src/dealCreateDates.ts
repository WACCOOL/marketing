import * as fs from "node:fs";
import { deriveCreateDate, toEpochMs } from "@wac/shared";
import { hs } from "./insideSales.js";

/**
 * Deal create-date reconcile — the backfill companion of the derived-createdate
 * write in the SAP push (DEAL_CREATEDATE_WRITE). HubSpot stamps `createdate`
 * when a record is created IN HUBSPOT, so bulk-backfilled deals carry their
 * import date, not the real SAP quote date (which lives in
 * quote_creation_date). Sweeps every deal that carries quote_creation_date or
 * the quote_conversion_date mirror and applies the SAME shared derivation the
 * live push uses (@wac/shared deriveCreateDate): backdate createdate to noon
 * UTC on the earliest SAP signal day — quote creation, or the oldest conversion
 * date when SAP dated the SO before the quote entry — only when that day is
 * STRICTLY EARLIER than the current createdate's UTC day. Same-day deals and
 * quote-after-createdate oddities are left alone.
 *
 * PROBE: deals are the one HubSpot object whose createdate the API accepts,
 * but that's community lore, not something this portal has proven — so the
 * first applied deal is written ALONE (batch of 1, the same batch/update
 * endpoint the bulk run uses), read back, and the run HARD-ABORTS if the value
 * didn't stick. If it aborts, do not enable DEAL_CREATEDATE_WRITE.
 *
 * Audit-first: run --dry-run (optionally --csv=path) and review before
 * applying; --max-apply=N caps applied updates for the sample stage (the scan
 * is still full, so counts are real). Diff-only and idempotent — verify by
 * re-running --dry-run until corrections=0.
 */

const SCAN_PROPS = ["sap_quote_number", "dealname", "pipeline", "createdate", "quote_creation_date", "quote_conversion_date"].join(",");

const UPDATE_BATCH = 100;

export interface CreateDateChange {
  dealId: string;
  quote: string;
  dealname: string;
  pipeline: string;
  quoteCreationDay: string;
  quoteConversionDay: string;
  createdateBefore: string;
  createdateAfter: string;
  deltaDays: number;
  applied: boolean;
}

export interface DealCreateDateReconcileResult {
  scanned: number;
  /** Deals carrying quote_creation_date or the quote_conversion_date mirror. */
  candidates: number;
  /** Deals whose createdate is on a later UTC day than the quote day. */
  corrections: number;
  /** Quote day AFTER createdate day — never touched, surfaced for visibility. */
  quoteAfterCreate: number;
  updated: number;
  changes: CreateDateChange[];
  failures: string[];
}

function isoDay(ms: number | null): string {
  return ms === null ? "" : new Date(ms).toISOString().slice(0, 10);
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** Write one deal via the SAME batch endpoint the bulk run uses, read it back,
 *  and throw unless HubSpot persisted the exact value. */
async function probeCreateDateWrite(
  token: string,
  dealId: string,
  desired: string,
): Promise<void> {
  const res = await hs(token, "POST", "/crm/v3/objects/0-3/batch/update", {
    inputs: [{ id: dealId, properties: { createdate: desired } }],
  });
  if (!res.ok) {
    throw new Error(
      `createdate probe write failed (${res.status}): ${JSON.stringify(res.data).slice(0, 300)} — ` +
        "HubSpot rejected the createdate update; do NOT enable DEAL_CREATEDATE_WRITE.",
    );
  }
  const back = await hs(token, "GET", `/crm/v3/objects/0-3/${dealId}?properties=createdate`);
  if (!back.ok) {
    throw new Error(`createdate probe read-back failed (${back.status})`);
  }
  const got = toEpochMs(back.data?.properties?.createdate);
  if (got !== Number(desired)) {
    throw new Error(
      `createdate probe MISMATCH on deal ${dealId}: wrote ${desired} (${isoDay(Number(desired))}), ` +
        `read back ${got ?? "null"} (${isoDay(got)}) — HubSpot silently ignored the write; ` +
        "do NOT enable DEAL_CREATEDATE_WRITE.",
    );
  }
  console.log(
    `[create-dates] probe OK: deal ${dealId} createdate persisted as ${isoDay(Number(desired))} (noon UTC)`,
  );
}

export async function reconcileDealCreateDates(opts: {
  token: string;
  dryRun: boolean;
  limit?: number;
  maxApply?: number;
  csvPath?: string;
}): Promise<DealCreateDateReconcileResult> {
  const { token, dryRun, limit, maxApply, csvPath } = opts;
  const failures: string[] = [];
  const changes: CreateDateChange[] = [];

  let scanned = 0;
  let candidates = 0;
  let corrections = 0;
  let quoteAfterCreate = 0;
  let updated = 0;
  let probed = dryRun; // dry runs never write, so nothing to probe

  const pending: { id: string; properties: { createdate: string } }[] = [];
  const applyCapped = () => maxApply !== undefined && updated + pending.length >= maxApply;

  const flush = async () => {
    if (!pending.length) return;
    if (!dryRun) {
      // First-ever write is the probe: batch of 1 + read-back, hard-abort on
      // mismatch (before any bulk damage is possible).
      if (!probed) {
        const first = pending.shift()!;
        await probeCreateDateWrite(token, first.id, first.properties.createdate);
        probed = true;
        updated++;
      }
      for (let i = 0; i < pending.length; i += UPDATE_BATCH) {
        const inputs = pending.slice(i, i + UPDATE_BATCH);
        const res = await hs(token, "POST", "/crm/v3/objects/0-3/batch/update", { inputs });
        if (!res.ok) {
          throw new Error(`deal batch/update ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
        }
        updated += inputs.length;
      }
    } else {
      updated += pending.length;
    }
    pending.length = 0;
  };

  // ---- scan every deal, derive, collect corrections -------------------------
  const nowMs = Date.now();
  let after: string | undefined;
  do {
    const qs = `?limit=100&properties=${SCAN_PROPS}${after ? `&after=${after}` : ""}`;
    const res = await hs(token, "GET", `/crm/v3/objects/0-3${qs}`);
    if (!res.ok) throw new Error(`deals list ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    for (const d of res.data?.results ?? []) {
      scanned++;
      const p = d.properties ?? {};
      const quoteCreationMs = toEpochMs(p.quote_creation_date);
      // The deal-level quote_conversion_date mirror (oldest line conversion,
      // maintained by the push + close-date reconcile) stands in for the
      // line-item scan the live push does — no association reads needed.
      const conversionMs = toEpochMs(p.quote_conversion_date);
      if (quoteCreationMs === null && conversionMs === null) continue;
      candidates++;
      const createdateMs = toEpochMs(p.createdate);
      const derived = deriveCreateDate({
        quoteCreationMs,
        oldestConversionMs: conversionMs,
        existingCreateDateMs: createdateMs,
        nowMs,
      });
      if (!derived.properties.createdate) {
        // Strictly-earlier is the only write rule; count the inverse oddity.
        if (createdateMs !== null && quoteCreationMs !== null && isoDay(quoteCreationMs) > isoDay(createdateMs)) {
          quoteAfterCreate++;
        }
        continue;
      }
      corrections++;

      const afterMs = Number(derived.properties.createdate);
      const apply = !applyCapped();
      changes.push({
        dealId: String(d.id),
        quote: String(p.sap_quote_number ?? "").trim(),
        dealname: String(p.dealname ?? ""),
        pipeline: String(p.pipeline ?? ""),
        quoteCreationDay: isoDay(quoteCreationMs),
        quoteConversionDay: isoDay(conversionMs),
        createdateBefore: isoDay(createdateMs),
        createdateAfter: isoDay(afterMs),
        deltaDays:
          createdateMs !== null ? Math.round((createdateMs - afterMs) / 86_400_000) : 0,
        applied: apply && !dryRun,
      });

      if (apply) {
        pending.push({ id: String(d.id), properties: { createdate: derived.properties.createdate } });
        if (pending.length >= UPDATE_BATCH) await flush();
      }
    }
    if (scanned % 10_000 < 100) {
      console.log(`[create-dates] scanned ${scanned} deals, corrections so far ${corrections}`);
    }
    after = res.data?.paging?.next?.after;
    if (limit && scanned >= limit) break;
  } while (after);
  await flush();
  console.log(`[create-dates] scan done: ${scanned} deals, ${candidates} with quote_creation_date`);

  // ---- report ---------------------------------------------------------------
  if (csvPath) {
    const header =
      "dealId,sap_quote_number,dealname,pipeline,quote_creation_date,quote_conversion_date,createdate_before,createdate_after,delta_days,applied";
    const rows = changes.map((ch) =>
      [
        ch.dealId,
        ch.quote,
        csvEscape(ch.dealname),
        ch.pipeline,
        ch.quoteCreationDay,
        ch.quoteConversionDay,
        ch.createdateBefore,
        ch.createdateAfter,
        ch.deltaDays,
        String(ch.applied),
      ].join(","),
    );
    fs.writeFileSync(csvPath, [header, ...rows].join("\n") + "\n");
    console.log(`[create-dates] wrote ${changes.length} proposed changes to ${csvPath}`);
  }

  return { scanned, candidates, corrections, quoteAfterCreate, updated, changes, failures };
}
