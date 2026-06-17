import * as XLSX from "xlsx";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parsePricing } from "@wac/shared";
import type { Env } from "./env.js";
import type { IngestMessage, IngestionPatch } from "./ingest.js";

/**
 * Parse + stage a received file, dispatched by source. The API owns SheetJS
 * (`XLSX.read`) and hands plain rows to the pure parsers in @wac/shared.
 *
 * Territory is intentionally NOT parsed here: its master sheet is ~80 MB of XML
 * (formula-bloated) and needs ~200 MB to parse — over the Worker's 128 MB limit.
 * It is parsed out-of-band by apps/territory-sync (a Node CI job with real RAM),
 * so here it stays pass-through (stored + recorded). Open Orders is pass-through
 * until its parser lands.
 */

const UPSERT_CHUNK = 500;

export async function processIngestion(
  env: Env,
  sb: SupabaseClient,
  msg: IngestMessage,
): Promise<IngestionPatch> {
  if (msg.source === "pricing") {
    return processPricing(env, sb, msg);
  }
  // Pass-through: confirm the stored object exists, then succeed.
  const head = await env.ASSETS_BUCKET.head(msg.r2Key);
  if (!head) throw new Error(`R2 object missing: ${msg.r2Key}`);
  return { status: "succeeded", finished_at: new Date().toISOString() };
}

/** Read the first sheet of the stored workbook as plain header-keyed rows. */
async function readSheetRows(
  env: Env,
  r2Key: string,
): Promise<Record<string, unknown>[]> {
  const obj = await env.ASSETS_BUCKET.get(r2Key);
  if (!obj) throw new Error(`R2 object missing: ${r2Key}`);
  const bytes = await obj.arrayBuffer();
  const wb = XLSX.read(bytes, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames[0];
  const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!sheet) throw new Error("workbook has no sheets");
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
}

/**
 * Pricing: parse, chunk-upsert by (variant, sku), then per-variant full replace
 * (prune this variant's rows that aren't from this ingestion). Uploading one
 * price book never disturbs another.
 */
async function processPricing(
  env: Env,
  sb: SupabaseClient,
  msg: IngestMessage,
): Promise<IngestionPatch> {
  const variant = (msg.variant ?? "").trim().toLowerCase();
  if (!variant) throw new Error("pricing ingestion is missing a variant");

  const rows = await readSheetRows(env, msg.r2Key);
  const { valid, errors, stats } = parsePricing(rows, variant);

  for (let i = 0; i < valid.length; i += UPSERT_CHUNK) {
    const chunk = valid.slice(i, i + UPSERT_CHUNK).map((r) => ({
      variant: r.variant,
      sku: r.sku,
      price: r.price,
      currency: r.currency,
      valid_from: r.validFrom,
      valid_to: r.validTo,
      sales_org: r.salesOrg,
      ingestion_id: msg.ingestionId,
    }));
    const { error } = await sb
      .from("pricing")
      .upsert(chunk, { onConflict: "variant,sku" });
    if (error) throw new Error(`pricing upsert failed: ${error.message}`);
  }

  const { error: pruneErr, count } = await sb
    .from("pricing")
    .delete({ count: "exact" })
    .eq("variant", variant)
    .neq("ingestion_id", msg.ingestionId);
  if (pruneErr) throw new Error(`pricing prune failed: ${pruneErr.message}`);

  return {
    status: "succeeded",
    row_count: rows.length,
    inserted_count: valid.length,
    closed_count: count ?? 0,
    error_count: errors.length,
    errors_json: errors.slice(0, 50),
    stats_json: stats,
    finished_at: new Date().toISOString(),
  };
}
