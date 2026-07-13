import * as fs from "node:fs";
import * as path from "node:path";
import { DEAL_STAGE_IDS, STAGE_BY_PROJECT_STAGE, toHubspotDate } from "@wac/shared";
import { hs } from "./insideSales.js";

/**
 * Conversion-date corrective backfill (2026-07-13, one-off with lasting audit
 * value) — repairs the SAP payload bug where every pre-2026-06-26 payload
 * populated quote_conversion_date with the QUOTE DOCUMENT DATE instead of the
 * SO creation date (confirmed by Johnson Yao 7/10). Source of truth: SAP's
 * corrective line-level export (HubSpot_Quote_2024/2025/2026.csv — `Qutation #`
 * / `Quote item number` / `Conversion Date`, MM/DD/YYYY, 00/00/0000 = never
 * converted).
 *
 * Phase A — line items: for every corrective line key (<quote>-<item> =
 * quote_product_name), batch-READ the existing HubSpot line item and update
 * quote_conversion_date to the corrected value (or clear it when the line
 * never converted). Read-then-update by internal id — deliberately NOT
 * batch/upsert, which would create orphan line items for keys that never
 * synced.
 *
 * Phase B — deals the close-date reconcile deliberately won't touch (its
 * derivation never clears the mirror and never demotes stage):
 *   - quotes with NO converted line in the corrective file but a
 *     quote_conversion_date on the deal → clear the mirror;
 *   - those of them sitting in Closed Won (promoted off the fake conversion) →
 *     revert dealstage to the stage implied by stage_of_project and clear
 *     closedate (per Davis 2026-07-13).
 *
 * After this, run --reconcile-deal-close-dates (sets/corrects the mirror and
 * closedate from the now-correct line items through the shared derivation) and
 * verify --reconcile-deal-create-dates --dry-run reports 0.
 *
 * Audit-first like the sibling reconciles: --dry-run (+ --csv=path), then a
 * capped apply (--max-apply=N), then full. Deals/lines NOT present in the
 * corrective file are never touched.
 */

const BATCH = 100;

export interface CorrectiveData {
  /** `<quote>-<item>` → corrected conversion date (YYYY-MM-DD) or null (never converted). */
  lineConv: Map<string, string | null>;
  /** quote → oldest corrected conversion date, null when no line converted. */
  convByQuote: Map<string, string | null>;
  rows: number;
  badRows: number;
}

const SENTINEL = /^0+\/0+\/0+$/;

function parseUsDate(s: string): string | null {
  if (!s || SENTINEL.test(s)) return null;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

export function parseCorrectiveCsv(text: string, into: CorrectiveData): void {
  const lines = text.split("\n");
  const hdr = (lines[0] ?? "").split(",");
  const iq = hdr.indexOf("Qutation #");
  const ii = hdr.indexOf("Quote item number");
  const ic = hdr.indexOf("Conversion Date");
  if (iq < 0 || ii < 0 || ic < 0) throw new Error("corrective CSV missing expected headers");
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]!.trim()) continue;
    const c = lines[i]!.split(",");
    if (c.length !== hdr.length) {
      into.badRows++;
      continue;
    }
    into.rows++;
    const quote = c[iq]!.trim();
    const item = c[ii]!.trim();
    if (!quote || !item) continue;
    const conv = parseUsDate(c[ic]!.trim());
    const key = `${quote}-${item}`;
    // Duplicate line keys exist (e.g. price-list variants) — a real date wins.
    if (conv || !into.lineConv.has(key)) into.lineConv.set(key, conv);
    if (!into.convByQuote.has(quote)) into.convByQuote.set(quote, null);
    const prev = into.convByQuote.get(quote)!;
    if (conv && (prev === null || conv < prev)) into.convByQuote.set(quote, conv);
  }
}

export function loadCorrectiveDir(dir: string): CorrectiveData {
  const data: CorrectiveData = { lineConv: new Map(), convByQuote: new Map(), rows: 0, badRows: 0 };
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv"));
  if (files.length === 0) throw new Error(`no CSV files in ${dir}`);
  for (const f of files.sort()) parseCorrectiveCsv(fs.readFileSync(path.join(dir, f), "utf8"), data);
  return data;
}

/** Day-level value of a HubSpot date/datetime property (ms epoch or ISO). */
export function dayOf(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const n = Number(s);
  if (Number.isFinite(n)) return new Date(n).toISOString().slice(0, 10);
  return null;
}

/** Reverted dealstage for a falsely-Closed-Won deal, from its SAP stage_of_project. */
export function revertStageFor(stageOfProject: string | null): string {
  const sop = (stageOfProject ?? "").trim().toUpperCase();
  if (sop === "AWARDED") return DEAL_STAGE_IDS.awarded;
  return STAGE_BY_PROJECT_STAGE[sop] ?? DEAL_STAGE_IDS.awarded;
}

interface RepairOpts {
  token: string;
  dir: string;
  dryRun: boolean;
  limit?: number;
  maxApply?: number;
  csvPath?: string;
  /** Skip phases for staged runs. */
  skipLines?: boolean;
  skipDeals?: boolean;
}

export interface RepairResult {
  lineKeys: number;
  linesFound: number;
  linesMissing: number;
  lineSet: number;
  lineCleared: number;
  lineUnchanged: number;
  dealsScanned: number;
  dealsMatched: number;
  mirrorCleared: number;
  closedWonReverted: number;
  applied: number;
  failures: string[];
}

export async function repairConversionDates(o: RepairOpts): Promise<RepairResult> {
  const data = loadCorrectiveDir(o.dir);
  console.log(
    `[conv-repair] corrective file: ${data.rows} rows (${data.badRows} malformed skipped), ` +
      `${data.lineConv.size} line keys, ${data.convByQuote.size} quotes ` +
      `(${[...data.convByQuote.values()].filter(Boolean).length} with a real conversion)`,
  );

  const res: RepairResult = {
    lineKeys: data.lineConv.size,
    linesFound: 0,
    linesMissing: 0,
    lineSet: 0,
    lineCleared: 0,
    lineUnchanged: 0,
    dealsScanned: 0,
    dealsMatched: 0,
    mirrorCleared: 0,
    closedWonReverted: 0,
    applied: 0,
    failures: [],
  };
  const audit: string[] = ["scope,id,key,action,before,after"];
  let budget = o.maxApply ?? Number.POSITIVE_INFINITY;

  // ---- Phase A: line items -------------------------------------------------
  if (!o.skipLines) {
    let keys = [...data.lineConv.keys()];
    if (o.limit) keys = keys.slice(0, o.limit);
    const updates: { id: string; properties: { quote_conversion_date: string | number } }[] = [];
    for (let i = 0; i < keys.length; i += BATCH) {
      const slice = keys.slice(i, i + BATCH);
      const r = await hs(o.token, "POST", "/crm/v3/objects/line_items/batch/read", {
        idProperty: "quote_product_name",
        properties: ["quote_product_name", "quote_conversion_date"],
        inputs: slice.map((id) => ({ id })),
      });
      if (!r.ok && r.status !== 207) {
        res.failures.push(`line read batch ${i}: HTTP ${r.status}`);
        continue;
      }
      const found = new Map<string, { id: string; cur: string | null }>();
      for (const li of (r.data?.results ?? []) as { id: string; properties: Record<string, string> }[]) {
        const k = li.properties["quote_product_name"];
        if (k) found.set(k, { id: li.id, cur: dayOf(li.properties["quote_conversion_date"]) });
      }
      for (const k of slice) {
        const hit = found.get(k);
        if (!hit) {
          res.linesMissing++;
          continue;
        }
        res.linesFound++;
        const desired = data.lineConv.get(k) ?? null;
        if (hit.cur === desired) {
          res.lineUnchanged++;
          continue;
        }
        const after = desired ? (toHubspotDate(desired) as number) : "";
        if (desired) res.lineSet++;
        else res.lineCleared++;
        audit.push(`line_item,${hit.id},${k},${desired ? "set" : "clear"},${hit.cur ?? ""},${desired ?? ""}`);
        updates.push({ id: hit.id, properties: { quote_conversion_date: after } });
      }
      if ((i / BATCH) % 20 === 0)
        console.log(`[conv-repair] lines scanned ~${Math.min(i + BATCH, keys.length)}/${keys.length} (${updates.length} to update)`);
    }
    console.log(
      `[conv-repair] lines: ${res.linesFound} found, ${res.linesMissing} not in HubSpot | ` +
        `set=${res.lineSet} clear=${res.lineCleared} unchanged=${res.lineUnchanged}`,
    );
    if (!o.dryRun) {
      for (let i = 0; i < updates.length && budget > 0; i += BATCH) {
        const slice = updates.slice(i, Math.min(i + BATCH, i + budget));
        const r = await hs(o.token, "POST", "/crm/v3/objects/line_items/batch/update", { inputs: slice });
        if (!r.ok) res.failures.push(`line update batch ${i}: HTTP ${r.status}`);
        else {
          res.applied += slice.length;
          budget -= slice.length;
        }
        if ((i / BATCH) % 20 === 0)
          console.log(`[conv-repair] line updates ~${Math.min(i + BATCH, updates.length)}/${updates.length}`);
      }
    }
  }

  // ---- Phase B: deal mirror clears + false Closed Won reverts ---------------
  if (!o.skipDeals) {
    let quotes = [...data.convByQuote.keys()];
    if (o.limit) quotes = quotes.slice(0, o.limit);
    const dealUpdates: { id: string; properties: Record<string, string> }[] = [];
    for (let i = 0; i < quotes.length; i += BATCH) {
      const slice = quotes.slice(i, i + BATCH);
      res.dealsScanned += slice.length;
      const r = await hs(o.token, "POST", "/crm/v3/objects/0-3/batch/read", {
        idProperty: "sap_quote_number",
        properties: ["sap_quote_number", "quote_conversion_date", "dealstage", "closedate", "stage_of_project"],
        inputs: slice.map((id) => ({ id })),
      });
      if (!r.ok && r.status !== 207) {
        res.failures.push(`deal read batch ${i}: HTTP ${r.status}`);
        continue;
      }
      for (const d of (r.data?.results ?? []) as { id: string; properties: Record<string, string> }[]) {
        res.dealsMatched++;
        const p = d.properties;
        const quote = p["sap_quote_number"]!;
        const corrected = data.convByQuote.get(quote) ?? null;
        const cur = dayOf(p["quote_conversion_date"]);
        if (corrected !== null || cur === null) continue; // set/corrected mirrors ride the close-date reconcile
        const props: Record<string, string> = { quote_conversion_date: "" };
        res.mirrorCleared++;
        audit.push(`deal,${d.id},${quote},clear-mirror,${cur},`);
        if (p["dealstage"] === DEAL_STAGE_IDS.closedWon) {
          props["dealstage"] = revertStageFor(p["stage_of_project"] ?? null);
          props["closedate"] = "";
          res.closedWonReverted++;
          audit.push(`deal,${d.id},${quote},revert-closed-won,${p["dealstage"]}|${dayOf(p["closedate"]) ?? ""},${props["dealstage"]}|`);
        }
        dealUpdates.push({ id: d.id, properties: props });
      }
    }
    console.log(
      `[conv-repair] deals: ${res.dealsMatched}/${res.dealsScanned} matched | ` +
        `mirror-clear=${res.mirrorCleared} closed-won-revert=${res.closedWonReverted}`,
    );
    if (!o.dryRun) {
      for (let i = 0; i < dealUpdates.length && budget > 0; i += BATCH) {
        const slice = dealUpdates.slice(i, Math.min(i + BATCH, i + budget));
        const r = await hs(o.token, "POST", "/crm/v3/objects/0-3/batch/update", { inputs: slice });
        if (!r.ok) res.failures.push(`deal update batch ${i}: HTTP ${r.status}`);
        else {
          res.applied += slice.length;
          budget -= slice.length;
        }
      }
    }
  }

  if (o.csvPath) {
    fs.writeFileSync(o.csvPath, audit.join("\n") + "\n");
    console.log(`[conv-repair] audit CSV: ${o.csvPath} (${audit.length - 1} rows)`);
  }
  return res;
}
