import * as fs from "node:fs";
import * as path from "node:path";
import { DEAL_STAGE_IDS } from "@wac/shared";
import { hs } from "./insideSales.js";

/**
 * Net-value backfill (2026-07-13, Davis) — from SAP's corrective quote export
 * (HubSpot_Quote_2024/2025/2026.csv):
 *
 *   - line items get `net_value` = NET PRICE × Quantity (line prices survive
 *     SAP's rejection/conversion zeroing; validated: Σ per quote reproduces
 *     the pre-zeroing header Net Value to the cent on quote 25089999);
 *   - deals get `sap_net_value` = the raw header Net Value (zeros included —
 *     the inspectable SAP truth);
 *   - Closed LOST deals get `amount` = Σ line net values (the reconstructed
 *     value that was lost). Won/open amounts are deliberately untouched
 *     (partially-converted quotes would overstate; header zeroing on those is
 *     deliberate per quoting — PR #121/#123 history).
 *
 * The daily Worker push maintains all three going forward (hubspotPush.ts).
 * Audit-first: --dry-run (+ --csv=path), --max-apply=N, --limit=N,
 * --skip-lines / --skip-deals.
 */

const BATCH = 100;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface NetValueData {
  /** `<quote>-<item>` → line net value (NET PRICE × Quantity). */
  lineNet: Map<string, number>;
  /** quote → raw header Net Value (last row wins). */
  headerNet: Map<string, number>;
  /** quote → Σ line net values (the reconstructed pre-zeroing value). */
  lineSumByQuote: Map<string, number>;
  rows: number;
  badRows: number;
}

export function parseNetValues(text: string, into: NetValueData): void {
  const lines = text.split("\n");
  const hdr = (lines[0] ?? "").split(",");
  const iq = hdr.indexOf("Qutation #");
  const ii = hdr.indexOf("Quote item number");
  const iQty = hdr.indexOf("Quantity");
  const iPrice = hdr.indexOf("NET PRICE");
  const iNet = hdr.indexOf("Net Value");
  if (iq < 0 || ii < 0 || iQty < 0 || iPrice < 0 || iNet < 0) throw new Error("corrective CSV missing expected headers");
  for (let r = 1; r < lines.length; r++) {
    if (!lines[r]!.trim()) continue;
    const c = lines[r]!.split(",");
    if (c.length !== hdr.length) {
      into.badRows++;
      continue;
    }
    into.rows++;
    const quote = c[iq]!.trim();
    const item = c[ii]!.trim();
    if (!quote || !item) continue;
    const key = `${quote}-${item}`;
    const net = round2((parseFloat(c[iQty]!) || 0) * (parseFloat(c[iPrice]!) || 0));
    const prev = into.lineNet.get(key);
    // Duplicate line keys exist (price-list variants) — keep the larger value
    // so a zeroed variant can't mask a real one.
    if (prev === undefined || net > prev) {
      into.lineSumByQuote.set(quote, round2((into.lineSumByQuote.get(quote) ?? 0) - (prev ?? 0) + net));
      into.lineNet.set(key, net);
    }
    const header = parseFloat(c[iNet]!);
    if (Number.isFinite(header)) into.headerNet.set(quote, round2(header));
  }
}

export function loadNetValueDir(dir: string): NetValueData {
  const data: NetValueData = { lineNet: new Map(), headerNet: new Map(), lineSumByQuote: new Map(), rows: 0, badRows: 0 };
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".csv"));
  if (files.length === 0) throw new Error(`no CSV files in ${dir}`);
  for (const f of files.sort()) parseNetValues(fs.readFileSync(path.join(dir, f), "utf8"), data);
  return data;
}

async function ensureProperty(token: string, objectType: string, name: string, label: string, groupName: string): Promise<void> {
  const res = await hs(token, "GET", `/crm/v3/properties/${objectType}/${name}`);
  if (res.ok) return;
  const created = await hs(token, "POST", `/crm/v3/properties/${objectType}`, {
    name,
    label,
    type: "number",
    fieldType: "number",
    groupName,
  });
  if (!created.ok) throw new Error(`create ${objectType}.${name} failed: HTTP ${created.status}`);
  console.log(`[net-values] created ${objectType} property ${name}`);
}

interface Opts {
  token: string;
  dir: string;
  dryRun: boolean;
  limit?: number;
  maxApply?: number;
  csvPath?: string;
  skipLines?: boolean;
  skipDeals?: boolean;
}

export interface NetValueResult {
  linesFound: number;
  linesMissing: number;
  lineSet: number;
  lineUnchanged: number;
  dealsMatched: number;
  sapNetSet: number;
  lostAmountSet: number;
  applied: number;
  failures: string[];
}

const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 0.01;

export async function backfillNetValues(o: Opts): Promise<NetValueResult> {
  const data = loadNetValueDir(o.dir);
  console.log(
    `[net-values] corrective file: ${data.rows} rows (${data.badRows} malformed), ${data.lineNet.size} line keys, ${data.headerNet.size} quotes`,
  );
  const res: NetValueResult = { linesFound: 0, linesMissing: 0, lineSet: 0, lineUnchanged: 0, dealsMatched: 0, sapNetSet: 0, lostAmountSet: 0, applied: 0, failures: [] };
  const audit: string[] = ["scope,id,key,property,before,after"];
  let budget = o.maxApply ?? Number.POSITIVE_INFINITY;

  if (!o.dryRun) {
    await ensureProperty(o.token, "line_items", "net_value", "Net Value", "lineiteminformation");
    await ensureProperty(o.token, "deals", "sap_net_value", "SAP Net Value", "dealinformation");
  }

  // ---- line items -----------------------------------------------------------
  if (!o.skipLines) {
    let keys = [...data.lineNet.keys()];
    if (o.limit) keys = keys.slice(0, o.limit);
    const updates: { id: string; properties: { net_value: number } }[] = [];
    for (let i = 0; i < keys.length; i += BATCH) {
      const slice = keys.slice(i, i + BATCH);
      const r = await hs(o.token, "POST", "/crm/v3/objects/line_items/batch/read", {
        idProperty: "quote_product_name",
        properties: ["quote_product_name", "net_value"],
        inputs: slice.map((id) => ({ id })),
      });
      if (!r.ok && r.status !== 207) {
        res.failures.push(`line read batch ${i}: HTTP ${r.status}`);
        continue;
      }
      const found = new Map<string, { id: string; cur: number | null }>();
      for (const li of (r.data?.results ?? []) as { id: string; properties: Record<string, string> }[]) {
        const k = li.properties["quote_product_name"];
        if (k) found.set(k, { id: li.id, cur: li.properties["net_value"] != null && li.properties["net_value"] !== "" ? Number(li.properties["net_value"]) : null });
      }
      for (const k of slice) {
        const hit = found.get(k);
        if (!hit) {
          res.linesMissing++;
          continue;
        }
        res.linesFound++;
        const desired = data.lineNet.get(k)!;
        if (near(hit.cur, desired)) {
          res.lineUnchanged++;
          continue;
        }
        res.lineSet++;
        audit.push(`line_item,${hit.id},${k},net_value,${hit.cur ?? ""},${desired}`);
        updates.push({ id: hit.id, properties: { net_value: desired } });
      }
      if ((i / BATCH) % 40 === 0) console.log(`[net-values] lines scanned ~${Math.min(i + BATCH, keys.length)}/${keys.length} (${updates.length} to update)`);
    }
    console.log(`[net-values] lines: found=${res.linesFound} missing=${res.linesMissing} set=${res.lineSet} unchanged=${res.lineUnchanged}`);
    if (!o.dryRun) {
      for (let i = 0; i < updates.length && budget > 0; i += BATCH) {
        const slice = updates.slice(i, Math.min(i + BATCH, i + budget));
        const r = await hs(o.token, "POST", "/crm/v3/objects/line_items/batch/update", { inputs: slice });
        if (!r.ok) res.failures.push(`line update batch ${i}: HTTP ${r.status}`);
        else {
          res.applied += slice.length;
          budget -= slice.length;
        }
        if ((i / BATCH) % 40 === 0) console.log(`[net-values] line updates ~${Math.min(i + BATCH, updates.length)}/${updates.length}`);
      }
    }
  }

  // ---- deals ------------------------------------------------------------------
  if (!o.skipDeals) {
    let quotes = [...data.headerNet.keys()];
    if (o.limit) quotes = quotes.slice(0, o.limit);
    const updates: { id: string; properties: Record<string, number> }[] = [];
    for (let i = 0; i < quotes.length; i += BATCH) {
      const slice = quotes.slice(i, i + BATCH);
      const r = await hs(o.token, "POST", "/crm/v3/objects/0-3/batch/read", {
        idProperty: "sap_quote_number",
        properties: ["sap_quote_number", "dealstage", "amount", "sap_net_value"],
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
        const props: Record<string, number> = {};
        const headerNet = data.headerNet.get(quote);
        const curSap = p["sap_net_value"] != null && p["sap_net_value"] !== "" ? Number(p["sap_net_value"]) : null;
        if (headerNet !== undefined && !near(curSap, headerNet)) {
          props["sap_net_value"] = headerNet;
          res.sapNetSet++;
          audit.push(`deal,${d.id},${quote},sap_net_value,${curSap ?? ""},${headerNet}`);
        }
        if (p["dealstage"] === DEAL_STAGE_IDS.closedLost) {
          const lostAmount = data.lineSumByQuote.get(quote) ?? 0;
          const curAmount = p["amount"] != null && p["amount"] !== "" ? Number(p["amount"]) : null;
          if (lostAmount > 0 && !near(curAmount, lostAmount)) {
            props["amount"] = lostAmount;
            res.lostAmountSet++;
            audit.push(`deal,${d.id},${quote},amount,${curAmount ?? ""},${lostAmount}`);
          }
        }
        if (Object.keys(props).length) updates.push({ id: d.id, properties: props });
      }
    }
    console.log(`[net-values] deals: matched=${res.dealsMatched} sap_net_value-set=${res.sapNetSet} lost-amount-set=${res.lostAmountSet}`);
    if (!o.dryRun) {
      for (let i = 0; i < updates.length && budget > 0; i += BATCH) {
        const slice = updates.slice(i, Math.min(i + BATCH, i + budget));
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
    console.log(`[net-values] audit CSV: ${o.csvPath} (${audit.length - 1} rows)`);
  }
  return res;
}
