#!/usr/bin/env node
/**
 * One-time reconcile: deal `amount` vs Σ(line item quantity × price) for every
 * SAP deal (pipeline 723098519, sap_quote_number present).
 *
 * Why: SAP's quote_net_value header — the sync's amount source — tracks the
 * quote's OPEN value. It shrinks as lines convert to sales orders and hits 0.00
 * on full conversion (exactly when a deal goes Closed Won), so pass-through
 * amounts are zeroed/understated on converted deals. The line items keep their
 * real qty × price and their sum reproduces the untouched header exactly, so
 * they are the source of truth here (same rule the Worker push now applies via
 * @wac/shared deriveDealAmount).
 *
 * Only canonical SAP lines count (quote_product_name set — HubSpot-native quote
 * items never match, same test as hubspot-dedup-lineitems.mjs). Deals with no
 * canonical lines are skipped and counted: there is nothing to derive from.
 *
 * Usage:
 *   HUBSPOT_TOKEN=… node scripts/hubspot-amount-reconcile.mjs [opts]
 *
 *   --write              PATCH amounts where |diff| > $0.01 (default: report only)
 *   --max-writes <n>     Stop after n corrections (sample run)
 *   --only-deal <id>     Process just this deal record id
 *   --limit <n>          Scan at most n deals
 *   --out <path>         CSV of every diff (default amount-reconcile-diffs.csv)
 *   --resume-file <p>    Written deal ids; skipped on re-run (write mode only,
 *                        default /tmp/amount-reconcile.done)
 *   --delay-ms <n>       Pause between deals per worker (default 120)
 *   --concurrency <n>    Deals processed in parallel (default 4; the hs() retry
 *                        loop absorbs 429s). Use 1 for sample --write runs so
 *                        --max-writes is exact.
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";

const TOKEN = process.env.HUBSPOT_TOKEN;
const API = "https://api.hubapi.com";
const PIPELINE = "723098519";
const PORTAL = "46455872";
const BATCH = 100;
const TOLERANCE = 0.01;

const STAGES = {
  1054295849: "Pre-Qualified",
  1054295850: "Planning",
  1054295851: "Design & Budgeting",
  1054295852: "Bidding & Negotiating",
  1240424232: "Awarded",
  1054295854: "Closed Won",
  1054295855: "Closed Lost",
};

function parseArgs(argv) {
  const a = { delayMs: 120, concurrency: 4, resumeFile: "/tmp/amount-reconcile.done", out: "amount-reconcile-diffs.csv" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--write") a.write = true;
    else if (k === "--max-writes") a.maxWrites = Number(argv[++i]);
    else if (k === "--only-deal") a.onlyDeal = argv[++i];
    else if (k === "--limit") a.limit = Number(argv[++i]);
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--resume-file") a.resumeFile = argv[++i];
    else if (k === "--delay-ms") a.delayMs = Number(argv[++i]);
    else if (k === "--concurrency") a.concurrency = Number(argv[++i]);
    else throw new Error(`unknown arg: ${k}`);
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hs(method, path, body) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** attempt, 30_000));
      continue;
    }
    if (res.status === 204) return {};
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    return json;
  }
  throw new Error(`${method} ${path}: exhausted retries`);
}

/** Page every SAP deal (per-stage keeps each search under the 10k offset cap). */
async function* sapDeals(onlyDeal) {
  if (onlyDeal) {
    const d = await hs(
      "GET",
      `/crm/v3/objects/deals/${onlyDeal}?properties=amount,dealstage,dealname,sap_quote_number`,
    );
    yield d;
    return;
  }
  for (const stage of Object.keys(STAGES)) {
    let after;
    do {
      const res = await hs("POST", "/crm/v3/objects/deals/search", {
        filterGroups: [
          {
            filters: [
              { propertyName: "sap_quote_number", operator: "HAS_PROPERTY" },
              { propertyName: "pipeline", operator: "EQ", value: PIPELINE },
              { propertyName: "dealstage", operator: "EQ", value: stage },
            ],
          },
        ],
        properties: ["amount", "dealstage", "dealname", "sap_quote_number"],
        limit: 100,
        after,
      });
      for (const d of res.results ?? []) yield d;
      after = res.paging?.next?.after;
    } while (after);
  }
}

/** Σ quantity × price over the deal's canonical SAP lines; null when none. */
async function lineTotal(dealId) {
  const assoc = await hs("GET", `/crm/v4/objects/deals/${dealId}/associations/line_items?limit=500`);
  const ids = (assoc.results ?? []).map((r) => String(r.toObjectId));
  let sum = 0;
  let canonical = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const read = await hs("POST", "/crm/v3/objects/line_items/batch/read", {
      properties: ["quantity", "price", "quote_product_name"],
      inputs: ids.slice(i, i + BATCH).map((id) => ({ id })),
    });
    for (const li of read.results ?? []) {
      if (!(li.properties?.quote_product_name ?? "").trim()) continue; // not a SAP line
      const qty = Number(li.properties?.quantity);
      const price = Number(li.properties?.price);
      if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;
      canonical++;
      sum += qty * price;
    }
  }
  return canonical > 0 ? Math.round(sum * 100) / 100 : null;
}

async function writeAmounts(diffs) {
  for (let i = 0; i < diffs.length; i += BATCH) {
    await hs("POST", "/crm/v3/objects/deals/batch/update", {
      inputs: diffs.slice(i, i + BATCH).map((d) => ({ id: d.id, properties: { amount: String(d.total) } })),
    });
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!TOKEN) throw new Error("HUBSPOT_TOKEN env var required");

  const done = new Set();
  if (args.write && existsSync(args.resumeFile)) {
    for (const l of readFileSync(args.resumeFile, "utf8").split("\n")) if (l.trim()) done.add(l.trim());
    console.error(`resume: ${done.size} deals already written`);
  }

  let scanned = 0;
  let matches = 0;
  let skippedNoLines = 0;
  let written = 0;
  const diffs = [];
  const byStage = new Map(); // stage -> {n, delta}

  let stop = false;
  const failed = [];
  const processDeal = async (deal) => {
    const total = await lineTotal(deal.id);
    if (total === null) {
      skippedNoLines++;
      return;
    }
    const amount = deal.properties?.amount != null && deal.properties.amount !== "" ? Number(deal.properties.amount) : null;
    if (amount !== null && Math.abs(amount - total) <= TOLERANCE) {
      matches++;
      return;
    }

    const stage = STAGES[deal.properties?.dealstage] ?? deal.properties?.dealstage;
    const diff = { id: String(deal.id), name: deal.properties?.dealname ?? "", stage, amount, total };
    diffs.push(diff);
    const s = byStage.get(stage) ?? { n: 0, delta: 0 };
    s.n++;
    s.delta += total - (amount ?? 0);
    byStage.set(stage, s);

    if (args.write && (args.maxWrites == null || written < args.maxWrites)) {
      await writeAmounts([diff]);
      appendFileSync(args.resumeFile, `${diff.id}\n`);
      written++;
      if (args.maxWrites != null && written >= args.maxWrites) {
        console.error(`max-writes ${args.maxWrites} reached — stopping (sample run)`);
        stop = true;
      }
    }
  };

  const inflight = new Set();
  for await (const deal of sapDeals(args.onlyDeal)) {
    if (stop) break;
    if (args.limit != null && scanned >= args.limit) break;
    scanned++;
    if (done.has(String(deal.id))) continue;

    let p;
    p = processDeal(deal)
      .catch((e) => failed.push({ deal, err: e.message })) // one bad deal must not kill the scan
      .then(() => (args.delayMs ? sleep(args.delayMs) : undefined))
      .finally(() => inflight.delete(p));
    inflight.add(p);
    if (inflight.size >= args.concurrency) await Promise.race(inflight);

    if (scanned % 500 === 0) {
      console.error(`[${scanned}] scanned · ${matches} match · ${diffs.length} diffs · ${skippedNoLines} no-lines${args.write ? ` · ${written} written` : ""}`);
    }
  }
  await Promise.all(inflight);

  // Serial second chance for deals that errored mid-scan (post-burst calm).
  if (failed.length) {
    console.error(`retrying ${failed.length} failed deals serially…`);
    const retries = failed.splice(0);
    for (const { deal } of retries) {
      try {
        await processDeal(deal);
      } catch (e) {
        failed.push({ deal, err: e.message });
      }
      await sleep(250);
    }
  }

  const rows = ["deal_id,dealname,stage,amount,line_total,delta,url"];
  for (const d of diffs.sort((a, b) => Math.abs(b.total - (b.amount ?? 0)) - Math.abs(a.total - (a.amount ?? 0)))) {
    rows.push(
      `${d.id},"${d.name.replaceAll('"', '""')}",${d.stage},${d.amount ?? ""},${d.total},${(d.total - (d.amount ?? 0)).toFixed(2)},https://app.hubspot.com/contacts/${PORTAL}/record/0-3/${d.id}`,
    );
  }
  writeFileSync(args.out, rows.join("\n") + "\n");

  console.error(`\nFINISHED: ${scanned} scanned · ${matches} already correct · ${skippedNoLines} skipped (no SAP lines) · ${diffs.length} diffs${args.write ? ` · ${written} corrected` : " (dry run — nothing written)"}`);
  if (failed.length) {
    console.error(`  UNRESOLVED after retry — rerun for these ${failed.length} deals:`);
    for (const f of failed) console.error(`    ${f.deal.id}: ${f.err}`);
  }
  for (const [stage, s] of byStage) {
    console.error(`  ${stage}: ${s.n} diffs, Σdelta ${s.delta.toFixed(2)}`);
  }
  console.error(`  full diff list -> ${args.out}`);
  console.error(`  top diffs:`);
  for (const d of diffs.slice(0, 20)) {
    console.error(`    ${d.stage} · "${d.name}" ${d.amount ?? "(unset)"} -> ${d.total} · https://app.hubspot.com/contacts/${PORTAL}/record/0-3/${d.id}`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
