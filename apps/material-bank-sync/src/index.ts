import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { XMLParser } from "fast-xml-parser";
import { parseMaterialBank, type MaterialBankOrder, type ParseResult } from "@wac/shared";
import { connect, download, listInbound, type InboundFile } from "./sftp.js";

/**
 * Material Bank sync — SFTP → R2 archive → Worker (deal/contact/owner routing).
 *
 * Thin by design: this CLI owns the SFTP pull, the ISO-8859-1 decode, the
 * XML→typed-order parse, the R2 archive, and the exactly-once file ledger
 * (data_ingestions, source="material-bank"). Everything HubSpot — dedupe,
 * contact find/create, owner routing, deal + line items, project_type — lives
 * in the Worker (apps/api/src/materialBank.ts), where the HubSpot/Gemini
 * secrets and the lead-ownership machinery already are. Orders are POSTed
 * SERIALLY with a small delay so the Worker stays inside HubSpot's rate budget.
 *
 * Flags:
 *   --sample        SFTP inventory + parse preview of the newest file, no writes
 *   --dry-run       run every order through the Worker with dryRun:true — full
 *                   decision trace (dedupe, owner, amounts), no writes anywhere
 *   --limit N       process only the first N orders per file; the file is NOT
 *                   marked done, so a later full run picks up the rest
 *                   (idempotent — the processed orders just dedupe). This is
 *                   the sample-first approval gate.
 *   --file <name>   restrict to one file
 *   --force         reprocess files even if already recorded
 *   --local <path>  ingest a local .xml file (or directory of them) instead of
 *                   SFTP — everything downstream is identical
 *
 * Env: MB_SFTP_HOST/PORT/USER/PASSWORD/MB_SFTP_PATH,
 *      R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET,
 *      SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY,
 *      MARKETING_APP_URL (default https://marketing.gowac.cc), REP_LOOKUP_TOKEN.
 */

const SOURCE = "material-bank";
const INTER_ORDER_MS = 500;
const POST_RETRIES = 3;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
const iso = () => new Date().toISOString();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Decode (ISO-8859-1) + XML-parse + map a Material Bank file buffer. */
function parseFile(buf: Buffer): ParseResult<MaterialBankOrder> {
  const xml = buf.toString("latin1");
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
  return parseMaterialBank(parser.parse(xml));
}

interface OrderOutcome {
  orderId: string;
  status: string;
  dealId?: string | null;
  ownerId?: string | null;
  ownerSource?: string;
  error?: string;
  [k: string]: unknown;
}

/** POST one order to the Worker; retries transient failures. Never throws for
 * a processed-but-errored order (the Worker returns its outcome either way). */
async function postOrder(order: MaterialBankOrder, dryRun: boolean): Promise<OrderOutcome> {
  const url = `${(process.env.MARKETING_APP_URL ?? "https://marketing.gowac.cc").replace(/\/+$/, "")}/api/hubspot/material-bank/sync`;
  let lastErr = "";
  for (let attempt = 0; attempt < POST_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env("REP_LOOKUP_TOKEN")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ order, dryRun }),
        signal: AbortSignal.timeout(90_000),
      });
      const data = (await res.json().catch(() => null)) as OrderOutcome | null;
      if (data?.orderId) return data;
      lastErr = `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`;
      if (res.status < 500 && res.status !== 429) break; // 4xx won't heal on retry
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await delay(1_000 * (attempt + 1));
  }
  return { orderId: order.orderId, status: "error", error: lastErr };
}

// --- local-file source ----------------------------------------------------------

async function listLocal(path: string): Promise<(InboundFile & { absPath: string })[]> {
  const s = await stat(path);
  const files = s.isDirectory()
    ? (await readdir(path)).filter((n) => /\.xml$/i.test(n)).map((n) => join(path, n))
    : [path];
  const out: (InboundFile & { absPath: string })[] = [];
  for (const abs of files) {
    const fs = await stat(abs);
    out.push({ path: basename(abs), name: basename(abs), size: fs.size, modifiedAt: fs.mtimeMs, absPath: abs });
  }
  return out.sort((a, b) => a.modifiedAt - b.modifiedAt);
}

// --- sample mode ------------------------------------------------------------------

function printOrder(o: MaterialBankOrder): void {
  console.log(
    `  order ${o.orderId}: ${o.contact.email ?? "no-email"} @ ${o.company.name ?? "?"} ` +
      `[${o.company.practice ?? "no practice"}] — "${o.project.name ?? "?"}", ` +
      `budget=${o.project.budgetRaw ?? "∅"}, ${o.lines.length} lines`,
  );
}

async function runSample(read: (f: InboundFile) => Promise<Buffer>, files: InboundFile[]): Promise<void> {
  console.log(`\n=== Inventory: ${files.length} XML files ===`);
  for (const f of files) {
    console.log(`  ${f.path}  ${f.size.toLocaleString()} bytes  mtime=${new Date(f.modifiedAt).toISOString()}`);
  }
  const newest = files[files.length - 1];
  if (!newest) return;
  console.log(`\n=== Parse preview: ${newest.name} ===`);
  const { valid, errors, stats } = parseFile(await read(newest));
  console.log(`stats:`, stats, `errors: ${errors.length}`);
  for (const e of errors.slice(0, 5)) console.log(`  row ${e.rowIndex}: ${e.messages.join("; ")}`);
  for (const o of valid.slice(0, 10)) printOrder(o);
  console.log(`\n[material-bank-sync] sample complete — no writes performed.`);
}

// --- main -----------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const has = (f: string) => argv.includes(f);
  const stringArg = (flag: string) => {
    const i = argv.findIndex((a) => a === flag);
    if (i >= 0) return argv[i + 1];
    return argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
  };
  const fileArg = stringArg("--file");
  const localArg = stringArg("--local");
  const limit = Number(stringArg("--limit") ?? "") || null;
  const dryRun = has("--dry-run");

  const client = localArg ? null : await connect();
  try {
    const all = localArg ? await listLocal(localArg) : await listInbound(client!);
    const read = (f: InboundFile) =>
      localArg ? readFile((f as InboundFile & { absPath: string }).absPath) : download(client!, f.path);

    if (has("--sample")) {
      await runSample(read, all);
      return;
    }

    const sb: SupabaseClient = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const s3 = new S3Client({
      region: "auto",
      endpoint: env("R2_ENDPOINT"),
      credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") },
    });
    const bucket = env("R2_BUCKET");

    const { data, error } = await sb
      .from("data_ingestions")
      .select("original_name")
      .eq("source", SOURCE)
      .eq("status", "succeeded");
    if (error) throw new Error(`data_ingestions read failed: ${error.message}`);
    const done = new Set((data ?? []).map((r) => String((r as { original_name: string | null }).original_name)));

    const work = all.filter((f) => (!fileArg || f.name === fileArg) && (has("--force") || !done.has(f.name)));
    console.log(
      `[material-bank-sync] ${all.length} files ${localArg ? `under ${localArg}` : "on server"}, ${work.length} to process` +
        `${fileArg ? ` (--file ${fileArg})` : ""}${dryRun ? " [DRY RUN]" : ""}${limit ? ` [limit ${limit}]` : ""}`,
    );

    let failures = 0;
    for (const f of work) {
      console.log(`[material-bank-sync] processing ${f.path}`);
      const buf = await read(f);
      const { valid, errors, stats } = parseFile(buf);
      console.log(`[material-bank-sync]   parsed: ${valid.length} orders, ${errors.length} row errors, stats:`, stats);
      const orders = limit ? valid.slice(0, limit) : valid;

      let ingestionId: string | null = null;
      if (!dryRun) {
        const r2Key = await (async () => {
          const now = new Date();
          const key = `ingest/${SOURCE}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${String(now.getUTCDate()).padStart(2, "0")}/${randomUUID()}__${f.name}`;
          await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: "text/xml" }));
          return key;
        })();
        const { data: ins, error: insErr } = await sb
          .from("data_ingestions")
          .insert({
            source: SOURCE,
            status: "processing",
            r2_key: r2Key,
            original_name: f.name,
            content_type: "text/xml",
            byte_size: f.size,
            delivered_by: localArg ? "local" : "sftp",
            started_at: iso(),
          })
          .select("id")
          .single();
        if (insErr) throw new Error(`data_ingestions insert failed: ${insErr.message}`);
        ingestionId = (ins as { id: string }).id;
      }

      const counts: Record<string, number> = {};
      const orderErrors: { orderId: string; error: string }[] = [];
      for (const [i, order] of orders.entries()) {
        const outcome = await postOrder(order, dryRun);
        counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
        console.log(
          `[material-bank-sync]   ${i + 1}/${orders.length} ${outcome.orderId}: ${outcome.status}` +
            `${outcome.dealId ? ` deal=${outcome.dealId}` : ""}` +
            `${outcome.ownerSource ? ` owner=${outcome.ownerId} (${outcome.ownerSource})` : ""}` +
            `${outcome.error ? ` ERROR: ${outcome.error}` : ""}`,
        );
        if (outcome.status === "error") {
          orderErrors.push({ orderId: outcome.orderId, error: outcome.error ?? "unknown" });
        }
        if (i < orders.length - 1) await delay(INTER_ORDER_MS);
      }

      // A file counts as succeeded only when EVERY order in it processed
      // cleanly in a full (un-limited) run; anything else stays retryable.
      const complete = !limit && orderErrors.length === 0 && errors.length === 0;
      if (!complete) failures++;
      if (ingestionId) {
        await sb
          .from("data_ingestions")
          .update({
            status: complete ? "succeeded" : "failed",
            row_count: valid.length,
            error_count: orderErrors.length + errors.length,
            errors_json: [...errors.slice(0, 20), ...orderErrors.slice(0, 30)],
            stats_json: { ...stats, ...counts, ...(limit ? { partial: orders.length } : {}) },
            finished_at: iso(),
            updated_at: iso(),
          })
          .eq("id", ingestionId);
      }
      console.log(`[material-bank-sync]   ${f.name}: ${JSON.stringify(counts)}${complete ? "" : " (NOT marked done)"}`);
    }
    if (failures > 0 && !dryRun && !limit) process.exitCode = 1;
  } finally {
    if (client) await client.end();
  }
}

main().catch((e) => {
  console.error(`[material-bank-sync] fatal: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exitCode = 1;
});
