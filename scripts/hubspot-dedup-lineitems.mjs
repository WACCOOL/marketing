#!/usr/bin/env node
/**
 * One-time cleanup: delete duplicate SAP line items left by an earlier messy CSV
 * import. A dup is a line item with `quote_line` set but NO `quote_product_name`
 * (the canonical SAP line items always have both; HubSpot-native quote items have
 * neither, so they're never matched).
 *
 * Only touches deals that HAVE an `sap_quote_number` AND are NOT in the
 * Pre-Qualified stage (dealstage 1054295849). Manual deals (no SAP quote #) and
 * Pre-Qualified deals are excluded entirely. Safety net: a deal is skipped unless
 * it also has at least one canonical (quote_product_name) line item, so the run
 * can never remove a deal's only copies.
 *
 * Usage:
 *   HUBSPOT_TOKEN=… node scripts/hubspot-dedup-lineitems.mjs [--dry-run] [--limit N] [--resume-file p]
 */
import { existsSync, readFileSync, appendFileSync } from "node:fs";

const TOKEN = process.env.HUBSPOT_TOKEN;
const API = "https://api.hubapi.com";
const PREQUAL_STAGE = "1054295849"; // "Pre-Qualified"
const BATCH = 100;

function parseArgs(argv) {
  const a = { delayMs: 120, resumeFile: "/tmp/dedup-lineitems.done" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--limit") a.limit = Number(argv[++i]);
    else if (k === "--resume-file") a.resumeFile = argv[++i];
    else if (k === "--delay-ms") a.delayMs = Number(argv[++i]);
    else throw new Error(`unknown arg: ${k}`);
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hs(method, path, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
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
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 204) return {};
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    return json;
  }
  throw new Error(`${method} ${path}: exhausted retries`);
}

// All deal stages EXCEPT Pre-Qualified (1054295849). Paginating per-stage keeps
// each search under HubSpot's 10,000-result offset cap (the whole in-scope set is
// ~25k). Combined hs_object_id sort+filter 400s, so we partition by stage instead.
const NON_PREQUAL_STAGES = [
  "1054295850", // Planning
  "1054295851", // Design & Budgeting
  "1054295852", // Bidding & Negotiating
  "1240424232", // Awarded
  "1054295854", // Closed Won
  "1054295855", // Closed Lost
];

/** Page through every in-scope deal id (SAP quote # present, not Pre-Qualified). */
async function* inScopeDeals() {
  for (const stage of NON_PREQUAL_STAGES) {
    let after;
    do {
      const body = {
        filterGroups: [
          {
            filters: [
              { propertyName: "sap_quote_number", operator: "HAS_PROPERTY" },
              { propertyName: "dealstage", operator: "EQ", value: stage },
            ],
          },
        ],
        properties: ["hs_object_id"],
        limit: 100,
        after,
      };
      const res = await hs("POST", "/crm/v3/objects/deals/search", body);
      for (const d of res.results ?? []) yield d.id;
      after = res.paging?.next?.after;
    } while (after);
  }
}

/** The line items on a deal, partitioned into canonical vs dup. */
async function classifyLineItems(dealId) {
  const assoc = await hs("GET", `/crm/v4/objects/deals/${dealId}/associations/line_items?limit=500`);
  const ids = (assoc.results ?? []).map((r) => String(r.toObjectId));
  const canonical = [];
  const dups = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const read = await hs("POST", "/crm/v3/objects/line_items/batch/read", {
      properties: ["quote_line", "quote_product_name"],
      inputs: slice.map((id) => ({ id })),
    });
    for (const li of read.results ?? []) {
      const hasName = !!(li.properties?.quote_product_name ?? "").trim?.();
      const hasLine = !!(li.properties?.quote_line ?? "").trim?.();
      if (hasName) canonical.push(li.id);
      else if (hasLine) dups.push(li.id); // quote_line but no quote_product_name = dup
    }
  }
  return { canonical, dups };
}

async function archive(ids) {
  for (let i = 0; i < ids.length; i += BATCH) {
    await hs("POST", "/crm/v3/objects/line_items/batch/archive", {
      inputs: ids.slice(i, i + BATCH).map((id) => ({ id })),
    });
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!TOKEN) throw new Error("HUBSPOT_TOKEN env var required");

  const done = new Set();
  if (!args.dryRun && existsSync(args.resumeFile)) {
    for (const l of readFileSync(args.resumeFile, "utf8").split("\n")) if (l.trim()) done.add(l.trim());
    console.error(`resume: ${done.size} deals already processed`);
  }

  let deals = 0;
  let processed = 0;
  let skippedNoCanonical = 0;
  let dupsTotal = 0;
  for await (const dealId of inScopeDeals()) {
    deals++;
    if (done.has(dealId)) continue;
    if (args.limit != null && processed >= args.limit) break;
    const { canonical, dups } = await classifyLineItems(dealId);
    // Safety: never strip a deal that has no canonical line items.
    if (canonical.length === 0) {
      if (dups.length) skippedNoCanonical++;
      processed++;
      continue;
    }
    if (dups.length) {
      if (!args.dryRun) await archive(dups);
      dupsTotal += dups.length;
    }
    if (!args.dryRun) appendFileSync(args.resumeFile, `${dealId}\n`);
    processed++;
    if (processed % 250 === 0) {
      console.error(`[${processed}] deals done · ${dupsTotal} dups ${args.dryRun ? "would be " : ""}deleted · ${skippedNoCanonical} skipped (no canonical)`);
    }
    if (args.delayMs) await sleep(args.delayMs);
  }
  console.error(
    `FINISHED: scanned ${deals} in-scope deals, processed ${processed}; ${dupsTotal} dup line items ${args.dryRun ? "WOULD BE deleted (dry run)" : "deleted"}; ${skippedNoCanonical} deals skipped (no canonical line item).`,
  );
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
