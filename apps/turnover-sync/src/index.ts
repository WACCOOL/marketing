import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import {
  parseCustomerParents,
  parseParentRefs,
  parseTurnover,
  type ParentRefRow,
} from "@wac/shared";
import { connect, download, listInbound, type FileKind, type InboundFile } from "./sftp.js";
import { pushCompanyParents, pushTurnoverToHubspot, verifyCoverage } from "./hubspot.js";

/**
 * Turnover (invoiced orders) sync — SFTP → R2 archive → Supabase staging →
 * HubSpot Orders ("Invoiced Orders" pipeline) + company parent-child.
 *
 * Files arrive AD HOC on the ExaVault SFTP (only when there are updates), so
 * the cron runs often and no-ops cheaply: a file is processed exactly once,
 * tracked by data_ingestions (source='turnover', original_name=filename) — the
 * server is never written to. TURNOVER files are rolling windows staged with
 * idempotent upserts (append semantics — no close-on-missing); CUSTOMERS files
 * stage account→parent links (PARENTS files are the name legend); PRODUCTS
 * files are reference-only and skipped.
 *
 * Flags:
 *   --sample           SFTP inventory + header introspection, no writes
 *   --dry-run          parse/preview only — no R2/DB/HubSpot writes
 *   --push             after staging, push this run's touched billing docs
 *                      (+ parent-child when a customers file was staged)
 *   --push-only        skip SFTP/staging; push ALL staging to HubSpot
 *   --verify-coverage  report staged accounts/materials missing in HubSpot
 *   --force            reprocess files even if already recorded
 *   --file <name>      restrict to one file (also how a big backfill file runs)
 *
 * Env: SFTP_HOST/PORT/USER/PASSWORD/SFTP_INBOUND_PATH,
 *      R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET,
 *      SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY, HUBSPOT_TOKEN,
 *      TURNOVER_PIPELINE_ID/TURNOVER_STAGE_ID (optional override).
 */

const SAMPLE_ROWS = 5;
const SAMPLE_DISTINCT = 12;
const UPSERT_CHUNK = 1000;
const SOURCE = "turnover";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
const iso = () => new Date().toISOString();

/** Parse a CSV buffer to header-keyed rows (SheetJS handles BOM/quoting; raw
 * strings so zero-padded identifiers survive). */
function parseCsv(buf: Buffer): { headers: string[]; rows: Record<string, unknown>[] } {
  const wb = XLSX.read(buf, { type: "buffer", raw: true, dense: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("CSV parsed to zero sheets");
  const sheet = wb.Sheets[sheetName]!;
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    blankrows: false,
    raw: true,
  });
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, range: 0 });
  const headers = ((aoa[0] ?? []) as unknown[]).map((h) => String(h ?? ""));
  return { headers, rows };
}

// --- ingestion ledger ---------------------------------------------------------

interface IngestionRow {
  id: string;
}

async function processedNames(sb: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await sb
    .from("data_ingestions")
    .select("original_name")
    .eq("source", SOURCE)
    .eq("status", "succeeded");
  if (error) throw new Error(`data_ingestions read failed: ${error.message}`);
  return new Set((data ?? []).map((r) => String((r as { original_name: string | null }).original_name)).filter(Boolean));
}

async function archiveToR2(s3: S3Client, bucket: string, f: InboundFile, buf: Buffer): Promise<string> {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const key = `ingest/${SOURCE}/${yyyy}/${mm}/${dd}/${randomUUID()}__${f.name}`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: "text/csv" }));
  return key;
}

// --- staging -------------------------------------------------------------------

async function stageTurnover(
  sb: SupabaseClient,
  buf: Buffer,
  f: InboundFile,
  ingestionId: string,
): Promise<{ rowCount: number; errorCount: number; errorsJson: unknown; stats: Record<string, number>; touchedDocs: Set<string> }> {
  const { rows } = parseCsv(buf);
  const { valid, errors, stats } = parseTurnover(rows);
  if (valid.length === 0) throw new Error("parse produced no valid lines; refusing to stage");

  const dbRows = valid.map((r) => ({
    billing_document: r.billingDocument,
    material: r.material,
    rep_code: r.repCode,
    sold_to: r.soldTo,
    billing_date: r.billingDate,
    currency: r.currency,
    quotation_ref: r.quotationRef,
    brand: f.brand,
    quantity: r.quantity,
    ytd_total: r.ytdTotal,
    discounted_sales: r.discountedSales,
    raw_json: r.raw,
    source_file: f.name,
    ingestion_id: ingestionId,
    updated_at: iso(),
  }));
  for (let i = 0; i < dbRows.length; i += UPSERT_CHUNK) {
    const { error } = await sb
      .from("turnover_orders")
      .upsert(dbRows.slice(i, i + UPSERT_CHUNK), { onConflict: "billing_document,material,rep_code" });
    if (error) throw new Error(`turnover_orders upsert failed: ${error.message}`);
  }
  return {
    rowCount: rows.length,
    errorCount: errors.length,
    errorsJson: errors.slice(0, 50),
    stats,
    touchedDocs: new Set(valid.map((r) => r.billingDocument)),
  };
}

async function stageCustomers(
  sb: SupabaseClient,
  buf: Buffer,
  f: InboundFile,
  ingestionId: string,
  parentNames: Map<string, string>,
): Promise<{ rowCount: number; errorCount: number; errorsJson: unknown; stats: Record<string, number> }> {
  const { rows } = parseCsv(buf);
  const { valid, errors, stats } = parseCustomerParents(rows);
  if (valid.length === 0) throw new Error("parse produced no valid customers; refusing to stage");

  const dbRows = valid.map((r) => ({
    account: r.account,
    customer_name: r.customerName,
    parent_account: r.parentAccount,
    parent_name: r.parentAccount ? (parentNames.get(r.parentAccount) ?? null) : null,
    raw_json: r.raw,
    source_file: f.name,
    ingestion_id: ingestionId,
    updated_at: iso(),
  }));
  for (let i = 0; i < dbRows.length; i += UPSERT_CHUNK) {
    const { error } = await sb
      .from("company_parents")
      .upsert(dbRows.slice(i, i + UPSERT_CHUNK), { onConflict: "account" });
    if (error) throw new Error(`company_parents upsert failed: ${error.message}`);
  }
  return { rowCount: rows.length, errorCount: errors.length, errorsJson: errors.slice(0, 50), stats };
}

// --- sample mode (Milestone A, kept) --------------------------------------------

function distinctSample(rows: Record<string, unknown>[], header: string): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const v = r[header];
    if (v === null || v === undefined || v === "") continue;
    seen.add(String(v));
    if (seen.size >= SAMPLE_DISTINCT) break;
  }
  return [...seen];
}

function findHeaders(headers: string[], needles: string[]): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, "");
  return headers.filter((h) => needles.some((n) => norm(h).includes(norm(n))));
}

const KEY_COLUMN_HINTS: Record<FileKind, string[]> = {
  turnover: [
    "billing", "invoice", "material", "rep", "sales group", "quotation", "quote",
    "customer", "account", "qty", "quantity", "value", "price", "date", "item", "pos",
  ],
  customers: ["account", "customer", "parent", "name", "rep", "group"],
  parents: ["parent", "account", "name"],
  products: ["material", "product", "sku", "description", "group", "unit"],
  unknown: [],
};

function printInventory(files: InboundFile[]): void {
  console.log(`\n=== Inventory under scan root: ${files.length} files ===`);
  for (const f of files) {
    const when = new Date(f.modifiedAt).toISOString();
    console.log(
      `  [${f.kind.padEnd(9)}] ${f.brand}  ${f.path}  ${f.size.toLocaleString()} bytes  mtime=${when}`,
    );
  }
  const counts = files.reduce<Record<string, number>>((acc, f) => {
    acc[f.kind] = (acc[f.kind] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  by kind:`, counts);
  if (counts["unknown"]) {
    console.log(`  NOTE: "unknown" files need a classification decision.`);
  }
}

async function sampleFile(buf: Buffer, f: InboundFile): Promise<void> {
  console.log(`\n=== Sample: ${f.path} (${f.kind}, ${f.brand}) ===`);
  const { headers, rows } = parseCsv(buf);
  console.log(`rows: ${rows.length}`);
  console.log(`headers (${headers.length}, verbatim):`);
  headers.forEach((h, i) => console.log(`  ${String(i + 1).padStart(2)}. ${JSON.stringify(h)}`));
  console.log(`first ${Math.min(SAMPLE_ROWS, rows.length)} rows:`);
  for (const r of rows.slice(0, SAMPLE_ROWS)) console.log("  ", JSON.stringify(r));
  const interesting = findHeaders(headers, KEY_COLUMN_HINTS[f.kind]);
  if (interesting.length > 0) {
    console.log(`distinct-value samples (key-column candidates):`);
    for (const h of interesting) {
      console.log(`  ${JSON.stringify(h)}:`, distinctSample(rows, h));
    }
  }
}

async function runSample(): Promise<void> {
  const client = await connect();
  try {
    const files = await listInbound(client);
    printInventory(files);
    if (files.length === 0) return;
    const newestByKind = new Map<FileKind, InboundFile>();
    for (const f of files) newestByKind.set(f.kind, f);
    for (const f of newestByKind.values()) {
      const buf = await download(client, f.path);
      try {
        await sampleFile(buf, f);
      } catch (e) {
        console.error(`  sample of ${f.path} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    console.log(`\n[turnover-sync] sample complete — no writes performed.`);
  } finally {
    await client.end();
  }
}

// --- main -----------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const has = (f: string) => argv.includes(f);
  const fileArg = (() => {
    const i = argv.findIndex((a) => a === "--file");
    if (i >= 0) return argv[i + 1];
    return argv.find((a) => a.startsWith("--file="))?.slice("--file=".length);
  })();
  const dryRun = has("--dry-run");

  if (has("--sample")) {
    await runSample();
    return;
  }

  const sb: SupabaseClient = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (has("--verify-coverage")) {
    await verifyCoverage(sb, env("HUBSPOT_TOKEN"));
    return;
  }

  if (has("--push-only")) {
    // --docs / --accounts scope a push to specific billing documents / customer
    // accounts (comma-separated) — for sample-first approval and spot repairs.
    const list = (flag: string) => {
      const i = argv.findIndex((a) => a === flag);
      const v = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
      return v ? new Set(v.split(",").map((s) => s.trim()).filter(Boolean)) : undefined;
    };
    const docs = list("--docs");
    const accounts = list("--accounts");
    if (docs || !accounts) await pushTurnoverToHubspot(sb, env("HUBSPOT_TOKEN"), { dryRun, billingDocs: docs });
    if (accounts || !docs) await pushCompanyParents(sb, env("HUBSPOT_TOKEN"), { dryRun, accounts });
    return;
  }

  // --- default: pull + stage (then optionally --push) ---
  const s3 = new S3Client({
    region: "auto",
    endpoint: env("R2_ENDPOINT"),
    credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") },
  });
  const bucket = env("R2_BUCKET");

  const client = await connect();
  let touchedDocs = new Set<string>();
  let customersStaged = false;
  let failures = 0;
  try {
    const all = await listInbound(client);
    const done = await processedNames(sb);
    const workKinds: FileKind[] = ["turnover", "customers", "parents"];
    const work = all.filter(
      (f) =>
        workKinds.includes(f.kind) &&
        (!fileArg || f.name === fileArg) &&
        (has("--force") || !done.has(f.name)),
    );
    console.log(`[turnover-sync] ${all.length} files on server, ${work.length} to process${fileArg ? ` (--file ${fileArg})` : ""}`);
    if (work.length === 0) return;

    // Parents legend: newest parents file on the server (fresh each run — it's
    // tiny and names enrich company_parents rows staged this run).
    const parentNames = new Map<string, string>();
    const newestParents = [...all].reverse().find((f) => f.kind === "parents");
    if (newestParents) {
      try {
        const { rows } = parseCsv(await download(client, newestParents.path));
        const { valid } = parseParentRefs(rows);
        for (const p of valid as ParentRefRow[]) if (p.name) parentNames.set(p.account, p.name);
        console.log(`[turnover-sync] parents legend: ${parentNames.size} names (${newestParents.name})`);
      } catch (e) {
        console.warn(`[turnover-sync] parents legend load failed (continuing): ${e instanceof Error ? e.message : e}`);
      }
    }

    for (const f of work) {
      console.log(`[turnover-sync] processing ${f.path} (${f.kind}, ${f.brand})`);
      const buf = await download(client, f.path);

      if (dryRun) {
        const { rows } = parseCsv(buf);
        const parsed = f.kind === "turnover" ? parseTurnover(rows) : f.kind === "customers" ? parseCustomerParents(rows) : parseParentRefs(rows);
        console.log(`[turnover-sync]   DRY RUN: ${rows.length} rows -> ${parsed.valid.length} valid, ${parsed.errors.length} errors, stats:`, parsed.stats);
        continue;
      }

      const r2Key = await archiveToR2(s3, bucket, f, buf);
      const { data: ins, error: insErr } = await sb
        .from("data_ingestions")
        .insert({
          source: SOURCE,
          variant: f.kind,
          status: "processing",
          r2_key: r2Key,
          original_name: f.name,
          content_type: "text/csv",
          byte_size: f.size,
          delivered_by: "sftp",
          started_at: iso(),
        })
        .select("id")
        .single();
      if (insErr) throw new Error(`data_ingestions insert failed: ${insErr.message}`);
      const ingestionId = (ins as IngestionRow).id;

      try {
        let result: { rowCount: number; errorCount: number; errorsJson: unknown; stats: Record<string, number> };
        if (f.kind === "turnover") {
          const staged = await stageTurnover(sb, buf, f, ingestionId);
          staged.touchedDocs.forEach((d) => touchedDocs.add(d));
          result = staged;
        } else if (f.kind === "customers") {
          result = await stageCustomers(sb, buf, f, ingestionId, parentNames);
          customersStaged = true;
        } else {
          // parents: legend only — record the parse so the file is marked done.
          const { rows } = parseCsv(buf);
          const { valid, errors, stats } = parseParentRefs(rows);
          result = { rowCount: rows.length, errorCount: errors.length, errorsJson: errors.slice(0, 50), stats: { ...stats, legendOnly: valid.length } };
        }
        await sb
          .from("data_ingestions")
          .update({
            status: "succeeded",
            row_count: result.rowCount,
            error_count: result.errorCount,
            errors_json: result.errorsJson,
            stats_json: result.stats,
            finished_at: iso(),
            updated_at: iso(),
          })
          .eq("id", ingestionId);
        console.log(`[turnover-sync]   staged ${f.name}: ${result.rowCount} rows, ${result.errorCount} row errors`);
      } catch (e) {
        failures++;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[turnover-sync]   FAILED ${f.name}: ${msg}`);
        await sb
          .from("data_ingestions")
          .update({ status: "failed", error: msg.slice(0, 500), finished_at: iso(), updated_at: iso() })
          .eq("id", ingestionId);
      }
    }
  } finally {
    await client.end();
  }

  if (has("--push") && !dryRun) {
    if (touchedDocs.size > 0) {
      await pushTurnoverToHubspot(sb, env("HUBSPOT_TOKEN"), { billingDocs: touchedDocs });
    }
    if (customersStaged) {
      await pushCompanyParents(sb, env("HUBSPOT_TOKEN"));
    }
    if (touchedDocs.size === 0 && !customersStaged) {
      console.log("[turnover-sync] nothing staged this run — skipping push.");
    }
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[turnover-sync] fatal: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exitCode = 1;
});
