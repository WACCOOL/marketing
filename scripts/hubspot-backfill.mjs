#!/usr/bin/env node
/**
 * One-time SAP-quote-CSV → HubSpot backfill.
 *
 * Reads a SAP quote export (one row per LINE ITEM), groups rows into quotes,
 * transforms each into the SAP JSON payload shape the live Lambdas forward, and
 * POSTs it to the Worker's idempotent push endpoint:
 *   POST {BASE}/api/hubspot-sync/push/deals   (Bearer SAP_SYNC_TOKEN)
 *
 * The Worker does the mapping/heal/HubSpot upsert + records the outcome, exactly
 * like a live SAP push — so this reuses the production pipeline, not a side path.
 *
 * Usage:
 *   SAP_SYNC_TOKEN=… node scripts/hubspot-backfill.mjs --file <csv> [opts]
 *
 *   --file <path>        CSV to read (required)
 *   --dry-run            Transform only; print payloads, POST nothing
 *   --limit <n>          Process at most n quotes
 *   --only-quote <q>     Process just this quotation number
 *   --base-url <url>     Default https://marketing.gowac.cc
 *   --delay-ms <n>       Pause between pushes (default 250) — rate-limit guard
 *   --resume-file <p>    Append processed quote#s here; skip them on re-run
 *                        (default <csv>.done)
 *
 * NOTE: quote_product_name (the line-item upsert key) is constructed as
 * `${quotation_number}-${quote_line}`. CONFIRM this matches the live Lambda
 * before the full run, or existing line items will be duplicated, not updated.
 */
import { createReadStream, existsSync, readFileSync, appendFileSync } from "node:fs";

/* ----------------------------- column mapping ------------------------------ */
// 0-based CSV column index -> SAP payload key. Built from the 100-col header and
// reconciled against DEAL_FIELD_MAP / LINE_ITEM_FIELD_MAP in
// packages/shared/src/hubspot/mapping.ts. Items flagged (?) are assumptions to
// verify against a real captured payload / the pushed test deal.

const DEAL_COLS = {
  0: "quotation_number",
  2: "account_number", // "Customer"
  3: "project_type",
  4: "sales_group",
  5: "sales_group_name",
  6: "quoted_by",
  7: "opportunity_type", // "Opportunity Type" (col 82 is the misspelled alias)
  8: "internal_note",
  9: "quote_follow_up_1", // "Schedule Date 1" (?)
  10: "completed_quote_follow_up_1", // "Completed Date 1" (?)
  11: "completed_quote_follow_up_by_1", // "Initial 1" (?)
  12: "quote_follow_up_2",
  13: "completed_quote_follow_up_2",
  14: "completed_quote_follow_up_by_2",
  15: "quote_follow_up_3",
  16: "completed_quote_follow_up_3",
  17: "completed_quote_follow_up_by_3",
  19: "original_estimated_decision_date", // "Estimated Decision Date"
  20: "original_estimated_onsite_date", // "Estimated Onsite Date"
  23: "valid_to",
  24: "register", // "Register" (e.g. REGISTERED)
  25: "stage_of_project",
  26: "quote_creation_date", // "Creation Date"
  27: "price_list",
  28: "project_name_customer_po__", // "Customer PO #" -> dealname
  29: "status_of_quote", // "Status Text"
  31: "doc__currency",
  32: "specifier_type_1",
  33: "specifier_type_category_1", // "Specifier type desc1"
  34: "specifier_account_number_1", // "specifier name 1"
  35: "specifier_type_2",
  36: "specifier_type_category_2",
  37: "specifier_account_number_2",
  38: "specifier_type_3",
  39: "specifier_account_number_3", // duplicate "Specifier type 3" header (?)
  40: "specifier_type_category_3", // "Specifier type desc3"
  41: "specifier_type_4",
  42: "specifier_type_category_4",
  43: "specifier_account_number_4",
  44: "specifier_type_5",
  45: "specifier_type_category_5",
  46: "specifier_account_number_5",
  48: "quote_net_value", // "Net Value" -> amount
  67: "conversion_rate",
  68: "quote_last_changed_date", // "Last Changed" -> sap_changed_at
  69: "sales_rep_2", // "Sales Rep2" (no "Sales Rep1" column present)
  70: "sales_rep_3",
  71: "sales_rep_1_commission__", // "Rep1 Percentage"
  72: "sales_rep_2_commission__",
  73: "sales_rep_3_commission__",
  74: "tax",
  77: "requested_by",
  78: "outside_quote_recipient", // "Quote Recipient"
  79: "project_location", // "Location"
  80: "external_quote_note", // "External Quote Note"
  81: "oppourtunity_type", // "Oppourtunity Type" (alias of opportunity_type)
  82: "technical_type",
  83: "state", // 2nd "Location" header (?)
  84: "oasis_quote_id",
  85: "submittal_agent",
  86: "submittal_agent_desc",
  98: "opportunity_id", // "Oppourtunity ID"
  99: "construct_connect_id",
};

const LINE_COLS = {
  1: "quote_line", // "Quote item number"
  18: "sales_order_date",
  21: "fixture_production_time", // "Production Lead" (?)
  22: "plant",
  30: "item_quantity", // "Quantity"
  31: "doc__currency",
  47: "commission",
  49: "rejection_code",
  50: "rejection_date",
  51: "rejection_reason", // "Rejection reason text"
  52: "customer_material_number", // "Customer Material"
  53: "business_unit",
  54: "product_group_description",
  55: "product_line_description",
  56: "unit_price", // "NET PRICE"
  57: "discount_percentage", // "DISCOUNT %"
  58: "zprc",
  59: "material__", // "MATERIAL #" -> hs_sku
  60: "material_description", // "Material Desciption"
  61: "unit_of_measurement",
  62: "material_output",
  75: "total_commission_per_line_item", // "Total Commision"
  76: "quote_conversion_date", // "Conversion Date"
  97: "customization_level",
};

const EXPECTED_COLS = 100;

/* ------------------------------- CSV parser -------------------------------- */
/** Stream a CSV file, invoking onRow(fields[]) per record. RFC-4180 quoting. */
function parseCsv(filePath, onRow) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    let field = "";
    let row = [];
    let inQuotes = false;
    let prevQuote = false; // last char was a closing quote (for "" escape)

    const endField = () => {
      row.push(field);
      field = "";
    };
    const endRow = () => {
      endField();
      // ignore a trailing empty line
      if (!(row.length === 1 && row[0] === "")) onRow(row);
      row = [];
    };

    stream.on("data", (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (inQuotes) {
          if (ch === '"') {
            inQuotes = false;
            prevQuote = true;
          } else {
            field += ch;
          }
        } else if (prevQuote && ch === '"') {
          field += '"'; // escaped quote inside quoted field
          inQuotes = true;
          prevQuote = false;
        } else {
          prevQuote = false;
          if (ch === '"') inQuotes = true;
          else if (ch === ",") endField();
          else if (ch === "\n") endRow();
          else if (ch === "\r") {/* skip */}
          else field += ch;
        }
      }
    });
    stream.on("end", () => {
      if (field.length || row.length) endRow();
      resolve();
    });
    stream.on("error", reject);
  });
}

/* ------------------------------- transform --------------------------------- */
const val = (row, idx) => {
  const v = row[idx];
  return v == null ? "" : String(v).trim();
};

/** Build the SAP deal payload from a quote's contiguous line-item rows. */
function transformQuote(rows) {
  const head = rows[0];
  const deal = {};
  for (const [idx, key] of Object.entries(DEAL_COLS)) {
    const v = val(head, Number(idx));
    if (v !== "" && deal[key] === undefined) deal[key] = v;
  }
  // opportunity_type: prefer the correctly-spelled column, fall back to alias.
  if (!deal.opportunity_type && deal.oppourtunity_type) {
    deal.opportunity_type = deal.oppourtunity_type;
  }

  const quotationNumber = deal.quotation_number ?? "";
  // Every line is kept (no filtering) — a faithful upsert by quote_product_name,
  // so existing HubSpot line items get updated rather than skipped. Empty/voided
  // shell lines from the export are pushed as-is by design.
  const products = rows.map((r) => {
    const line = {};
    for (const [idx, key] of Object.entries(LINE_COLS)) {
      const v = val(r, Number(idx));
      if (v !== "") line[key] = v;
    }
    const quoteLine = line.quote_line ?? "";
    // Line-item upsert key (the Worker requires it). Matches the live Lambda's
    // {quote#}-{line#} format (verified against existing HubSpot line items).
    line.quote_product_name = `${quotationNumber}-${quoteLine}`;
    return line;
  });

  deal.products = products;
  return deal;
}

/* --------------------------------- runner ---------------------------------- */
function parseArgs(argv) {
  const a = { delayMs: 250, baseUrl: "https://marketing.gowac.cc" };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--file") a.file = next();
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--limit") a.limit = Number(next());
    else if (k === "--only-quote") a.onlyQuote = next();
    else if (k === "--base-url") a.baseUrl = next();
    else if (k === "--delay-ms") a.delayMs = Number(next());
    else if (k === "--resume-file") a.resumeFile = next();
    else if (k === "--concurrency") a.concurrency = Number(next());
    else if (k === "--skip-file") a.skipFile = next();
    else throw new Error(`unknown arg: ${k}`);
  }
  if (!a.file) throw new Error("--file is required");
  a.resumeFile ??= `${a.file}.done`;
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pushQuote(payload, baseUrl, token) {
  const url = `${baseUrl}/api/hubspot-sync/push/deals`;
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      if (attempt === 4) return { ok: false, error: `network: ${e.message}` };
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    const body = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...body } : { ok: false, status: res.status, error: body.error };
  }
  return { ok: false, error: "exhausted retries" };
}

async function main() {
  const args = parseArgs(process.argv);
  const token = process.env.SAP_SYNC_TOKEN;
  if (!args.dryRun && !token) throw new Error("SAP_SYNC_TOKEN env var required to push (or use --dry-run)");
  if (!existsSync(args.file)) throw new Error(`no such file: ${args.file}`);

  const done = new Set();
  if (!args.dryRun && existsSync(args.resumeFile)) {
    for (const l of readFileSync(args.resumeFile, "utf8").split("\n")) {
      const q = l.trim();
      if (q) done.add(q);
    }
    console.error(`resume: ${done.size} quotes already done`);
  }
  // Skip list (e.g. quotes modified in HubSpot today, newer than the CSV) — these
  // are excluded from the run so a stale CSV row can't regress fresher data.
  if (args.skipFile && existsSync(args.skipFile)) {
    let skipped = 0;
    for (const l of readFileSync(args.skipFile, "utf8").split("\n")) {
      const q = l.trim();
      if (q && !done.has(q)) {
        done.add(q);
        skipped++;
      }
    }
    console.error(`skip-file: excluding ${skipped} quotes (modified since the CSV)`);
  }

  // Collect transformed payloads (group contiguous rows by quotation #).
  const quotes = [];
  let curKey = null;
  let curRows = [];
  let header = null;
  const flush = () => {
    if (curRows.length) quotes.push(transformQuote(curRows));
    curRows = [];
  };
  await parseCsv(args.file, (fields) => {
    if (!header) {
      header = fields;
      if (fields.length !== EXPECTED_COLS) {
        console.error(`WARN: header has ${fields.length} cols, expected ${EXPECTED_COLS}`);
      }
      return;
    }
    const key = (fields[0] ?? "").trim();
    if (!key) return;
    if (key !== curKey) {
      flush();
      curKey = key;
    }
    curRows.push(fields);
  });
  flush();

  let selected = quotes;
  if (args.onlyQuote) selected = selected.filter((q) => q.quotation_number === args.onlyQuote);
  selected = selected.filter((q) => !done.has(q.quotation_number));
  if (args.limit != null) selected = selected.slice(0, args.limit);

  console.error(
    `parsed ${quotes.length} quotes from ${args.file}; processing ${selected.length}` +
      (args.dryRun ? " (DRY RUN)" : ""),
  );

  if (args.dryRun) {
    for (const q of selected) {
      console.log(JSON.stringify(q, null, 2));
      console.error(`  ${q.quotation_number}: ${q.products.length} line items`);
    }
    return;
  }

  // Bounded worker pool: `concurrency` quotes in flight at once. Quotes are
  // independent (distinct deals/keys) so there's no cross-quote race; the only
  // shared limit is HubSpot's rate cap, which pushQuote's 429-backoff respects.
  const tally = {};
  const conc = Math.max(1, args.concurrency ?? 1);
  let n = 0;
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= selected.length) return;
      const q = selected[i];
      const r = await pushQuote(q, args.baseUrl, token);
      n++;
      const k = r.ok ? r.status ?? "ok" : `error:${r.status ?? ""}`;
      tally[k] = (tally[k] ?? 0) + 1;
      if (r.ok) appendFileSync(args.resumeFile, `${q.quotation_number}\n`);
      console.error(
        `[${n}/${selected.length}] ${q.quotation_number} (${q.products.length} li) -> ` +
          (r.ok ? `${r.status} ${r.recordId ?? ""}` : `FAIL ${r.status ?? ""} ${r.error ?? ""}`),
      );
      if (args.delayMs) await sleep(args.delayMs);
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
  console.error("done:", JSON.stringify(tally));
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
