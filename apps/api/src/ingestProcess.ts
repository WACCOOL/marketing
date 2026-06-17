import * as XLSX from "xlsx";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addToAggregate,
  buildRepCodes,
  parsePricing,
  parseRepCodeMapping,
  parseTerritoryHeader,
  unpivotTerritoryRow,
  type RepAggregate,
} from "@wac/shared";
import type { Env } from "./env.js";
import type { IngestMessage, IngestionPatch } from "./ingest.js";

/**
 * Parse + stage a received file, dispatched by source. The API owns SheetJS
 * (`XLSX.read`) and hands plain rows to the pure parsers in @wac/shared.
 * Sources without a parser yet (territory, open-orders) are pass-through —
 * stored and recorded, no staging rows — until their parsers land.
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
  if (msg.source === "territory") {
    return processTerritory(env, sb, msg);
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

const TERRITORY_MASTER_SHEET = "Territory Master Sheet";
const TERRITORY_MAPPING_SHEET = "Rep Code RSM ISR Mapping";
const ZIP_CHUNK = 2000;

/**
 * Territory: unpivot the master sheet (zip x channel -> rep code) into
 * `rep_code_zips`, parse the mapping tab, and write one row per rep code (union)
 * into `rep_codes`. The unpivot is STREAMED in chunks to bound Worker memory
 * (~200k long rows). Single-file snapshot → full-replace prune of both tables.
 */
async function processTerritory(
  env: Env,
  sb: SupabaseClient,
  msg: IngestMessage,
): Promise<IngestionPatch> {
  const obj = await env.ASSETS_BUCKET.get(msg.r2Key);
  if (!obj) throw new Error(`R2 object missing: ${msg.r2Key}`);
  const bytes = await obj.arrayBuffer();
  // Only parse the two sheets we need (the file has 12), in dense mode, to limit
  // memory — the master sheet is ~40k rows x 15 cols / ~317k unpivoted rows.
  const wb = XLSX.read(bytes, {
    type: "array",
    sheets: [TERRITORY_MASTER_SHEET, TERRITORY_MAPPING_SHEET],
    dense: true,
    cellText: false,
    cellDates: false,
  });

  const master = wb.Sheets[TERRITORY_MASTER_SHEET];
  if (!master) throw new Error(`missing sheet "${TERRITORY_MASTER_SHEET}"`);
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(master, {
    header: 1,
    blankrows: false,
  });
  const header = parseTerritoryHeader((matrix[0] as unknown[]) ?? []);
  if (!header) throw new Error("Territory Master Sheet has no Zip Code column");

  // Stream the unpivot: accumulate a chunk, upsert, repeat; aggregate per rep.
  const aggregates = new Map<string, RepAggregate>();
  let buffer: {
    rep_code: string;
    zip: string;
    channel: string;
    ingestion_id: string;
  }[] = [];
  let zipRows = 0;
  const flush = async () => {
    if (buffer.length === 0) return;
    const { error } = await sb
      .from("rep_code_zips")
      .upsert(buffer, { onConflict: "zip,channel" });
    if (error) throw new Error(`rep_code_zips upsert failed: ${error.message}`);
    zipRows += buffer.length;
    buffer = [];
  };
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r] as unknown[] | undefined;
    if (!row) continue;
    for (const rz of unpivotTerritoryRow(row, header)) {
      addToAggregate(aggregates, rz);
      buffer.push({
        rep_code: rz.repCode,
        zip: rz.zip,
        channel: rz.channel,
        ingestion_id: msg.ingestionId,
      });
      if (buffer.length >= ZIP_CHUNK) await flush();
    }
  }
  await flush();

  // Mapping tab → per-rep attributes.
  const mapSheet = wb.Sheets[TERRITORY_MAPPING_SHEET];
  const mappingRows = mapSheet
    ? XLSX.utils.sheet_to_json<Record<string, unknown>>(mapSheet, { defval: null })
    : [];
  const { mapping, errors: mapErrors, duplicates } = parseRepCodeMapping(mappingRows);

  const repCodes = buildRepCodes(aggregates, mapping);
  if (zipRows === 0 && repCodes.length === 0) {
    throw new Error("territory parse produced no rows; refusing to prune");
  }

  const now = new Date().toISOString();
  for (let i = 0; i < repCodes.length; i += UPSERT_CHUNK) {
    const chunk = repCodes.slice(i, i + UPSERT_CHUNK).map((r) => ({
      rep_code: r.repCode,
      district: r.district,
      rsm_tsm: r.rsmTsm,
      sales_district_code: r.salesDistrictCode,
      isr: r.isr,
      amt_rep_code: r.amtRepCode,
      channels: r.channels,
      zip_count: r.zipCount,
      ingestion_id: msg.ingestionId,
      updated_at: now,
    }));
    const { error } = await sb
      .from("rep_codes")
      .upsert(chunk, { onConflict: "rep_code" });
    if (error) throw new Error(`rep_codes upsert failed: ${error.message}`);
  }

  // Full-replace prune: drop rows not from this ingestion.
  const { error: pzErr, count: prunedZips } = await sb
    .from("rep_code_zips")
    .delete({ count: "exact" })
    .neq("ingestion_id", msg.ingestionId);
  if (pzErr) throw new Error(`rep_code_zips prune failed: ${pzErr.message}`);
  const { error: prErr, count: prunedReps } = await sb
    .from("rep_codes")
    .delete({ count: "exact" })
    .neq("ingestion_id", msg.ingestionId);
  if (prErr) throw new Error(`rep_codes prune failed: ${prErr.message}`);

  return {
    status: "succeeded",
    row_count: zipRows,
    inserted_count: zipRows,
    closed_count: (prunedZips ?? 0) + (prunedReps ?? 0),
    error_count: mapErrors.length,
    errors_json: mapErrors.slice(0, 50),
    stats_json: {
      zipRows,
      repCodes: repCodes.length,
      mappingRows: mappingRows.length,
      mappingDuplicates: duplicates,
    },
    finished_at: new Date().toISOString(),
  };
}
