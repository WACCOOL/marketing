import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import { parseOpenOrders, type OpenOrderRow } from "@wac/shared";

/**
 * Open Orders sync — out-of-band parser for the daily SAP "Open Orders Master".
 *
 * The Report sheet is ~12.6 MB of XML (header in row 3, ~8k line rows). That
 * fits the Worker, but the eventual HubSpot push fans out thousands of API calls
 * with no Worker time limit to respect, so the whole flow runs here (real RAM /
 * Node) instead — mirroring territory-sync. The API Worker only LANDS the file
 * in R2 (pass-through `data_ingestions` row); this CLI parses the latest one
 * into the `open_orders` staging table.
 *
 * Reconciliation = full daily SNAPSHOT with close-on-missing (NOT a prune):
 *   1. Upsert every parsed line on (so, posnr) → is_open=true, last_seen=this.
 *   2. Any previously-open line NOT in today's file flips is_open=false (reason
 *      unknown — fulfilled or cancelled); the row is KEPT as history.
 *
 * Idempotent + change-aware: parses the latest open-orders ingestion only when
 * it hasn't been parsed yet (row_count is null), unless `--force` is passed. A
 * daily file supersedes the prior snapshot, so parsing only the newest is right.
 *
 * Env:
 *   R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const REPORT_SHEET = "Report";
// Header is on sheet row 3 (rows 1-2 are blank) — 0-indexed 2.
const HEADER_ROW = 2;
const UPSERT_CHUNK = 1000;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
const iso = () => new Date().toISOString();

interface LatestIngestion {
  id: string;
  r2_key: string;
  row_count: number | null;
}

function toDbRow(r: OpenOrderRow, ingestionId: string) {
  return {
    so: r.so,
    posnr: r.posnr,
    po_number: r.poNumber,
    po_date: r.poDate,
    customer_account: r.customerAccount,
    customer_name: r.customerName,
    sales_group: r.salesGroup,
    amt_rep: r.amtRep,
    sales_territory: r.salesTerritory,
    business_unit: r.businessUnit,
    material: r.material,
    order_qty: r.orderQty,
    net_price: r.netPrice,
    line_net_value: r.lineNetValue,
    back_order_qty: r.backOrderQty,
    raw_json: r.raw,
    is_open: true,
    // ingestion_id tracks the run that last wrote the row; last_seen drives the
    // close-on-missing query below. On a daily snapshot they coincide.
    ingestion_id: ingestionId,
    last_seen_ingestion_id: ingestionId,
    updated_at: iso(),
  };
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const dryRun = process.argv.includes("--dry-run");

  const sb: SupabaseClient = createClient(
    env("SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // Latest open-orders ingestion (Graph cron lands these; pass-through leaves
  // row_count null until we parse).
  const { data, error } = await sb
    .from("data_ingestions")
    .select("id, r2_key, row_count")
    .eq("source", "open-orders")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`ingestion lookup failed: ${error.message}`);
  if (!data) {
    console.log("[open-orders-sync] no open-orders ingestion found; nothing to do.");
    return;
  }
  const ingestion = data as LatestIngestion;
  if (ingestion.row_count != null && !force) {
    console.log(
      `[open-orders-sync] latest ingestion ${ingestion.id} already parsed ` +
        `(row_count=${ingestion.row_count}); skipping. Use --force to re-parse.`,
    );
    return;
  }

  console.log(`[open-orders-sync] parsing ${ingestion.r2_key} (ingestion ${ingestion.id})`);
  if (!dryRun) {
    await sb
      .from("data_ingestions")
      .update({ status: "processing", started_at: iso(), updated_at: iso() })
      .eq("id", ingestion.id);
  }

  try {
    // Download from R2 (S3 API).
    const s3 = new S3Client({
      region: "auto",
      endpoint: env("R2_ENDPOINT"),
      credentials: {
        accessKeyId: env("R2_ACCESS_KEY_ID"),
        secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
      },
    });
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: env("R2_BUCKET"), Key: ingestion.r2_key }),
    );
    if (!obj.Body) throw new Error("empty R2 object body");
    const bytes = await obj.Body.transformToByteArray();
    console.log(`[open-orders-sync] downloaded ${bytes.length} bytes`);

    // Parse with SheetJS (real RAM). cellDates so date cols come through as Date
    // (asIsoDate normalizes). range:HEADER_ROW puts the header on sheet row 3.
    const wb = XLSX.read(bytes, {
      type: "array",
      sheets: [REPORT_SHEET],
      cellDates: true,
      dense: true,
    });
    const sheet = wb.Sheets[REPORT_SHEET];
    if (!sheet) throw new Error(`missing sheet "${REPORT_SHEET}"`);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      range: HEADER_ROW,
      defval: null,
      blankrows: false,
    });

    const { valid, errors, stats } = parseOpenOrders(rows);
    console.log(
      `[open-orders-sync] parsed: ${valid.length} lines (rows ${rows.length}, ` +
        `errors ${errors.length}, dup ${stats.duplicates})`,
    );
    if (valid.length === 0) {
      throw new Error("parse produced no valid lines; refusing to reconcile");
    }
    if (dryRun) {
      console.log("[open-orders-sync] --dry-run: skipping all writes.");
      console.log("[open-orders-sync] sample:", JSON.stringify(valid[0], null, 2).slice(0, 800));
      return;
    }

    // 1. Upsert every line (chunked) on (so, posnr).
    for (let i = 0; i < valid.length; i += UPSERT_CHUNK) {
      const chunk = valid.slice(i, i + UPSERT_CHUNK).map((r) => toDbRow(r, ingestion.id));
      const { error: e } = await sb
        .from("open_orders")
        .upsert(chunk, { onConflict: "so,posnr" });
      if (e) throw new Error(`open_orders upsert failed: ${e.message}`);
    }

    // 2. Close-on-missing: previously-open lines absent from today's file are no
    // longer open (reason unknown). Keep the row; flip the flag + stamp closed_at.
    const { error: ce, count: closed } = await sb
      .from("open_orders")
      .update(
        { is_open: false, closed_at: iso(), updated_at: iso() },
        { count: "exact" },
      )
      .neq("last_seen_ingestion_id", ingestion.id)
      .eq("is_open", true);
    if (ce) throw new Error(`open_orders close-on-missing failed: ${ce.message}`);

    await sb
      .from("data_ingestions")
      .update({
        status: "succeeded",
        row_count: valid.length,
        inserted_count: valid.length,
        closed_count: closed ?? 0,
        error_count: errors.length,
        errors_json: errors.slice(0, 50),
        stats_json: stats,
        finished_at: iso(),
        updated_at: iso(),
      })
      .eq("id", ingestion.id);

    console.log(
      `[open-orders-sync] done: lines=${valid.length}, closed=${closed ?? 0}, errors=${errors.length}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[open-orders-sync] FAILED: ${msg}`);
    if (!dryRun) {
      await sb
        .from("data_ingestions")
        .update({ status: "failed", error: msg, finished_at: iso(), updated_at: iso() })
        .eq("id", ingestion.id);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
