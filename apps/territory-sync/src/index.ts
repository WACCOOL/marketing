import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import {
  addToAggregate,
  buildRepCodes,
  parseRepCodeMapping,
  parseTerritoryHeader,
  unpivotTerritoryRow,
  type RepAggregate,
} from "@wac/shared";
import { syncRepCodesToHubspot, type RepForPush } from "./hubspot.js";

/**
 * Territory sync — out-of-band parser for the Territory workbook.
 *
 * The Territory file's master sheet is ~80 MB of (formula-bloated) XML and needs
 * ~200 MB to parse with SheetJS — over the API Worker's 128 MB limit. So the
 * Worker only LANDS the file in R2 (pass-through `data_ingestions` row), and this
 * Node CLI (run on a CI cron with real RAM) does the parse: it downloads the
 * latest territory object from R2, parses both tabs with the SAME proven
 * @wac/shared parser, and upserts rep_codes + rep_code_zips, finalizing the
 * ingestion row. Single-file snapshot → full-replace prune.
 *
 * Idempotent + change-aware: it parses the latest territory ingestion only when
 * it hasn't been parsed yet (row_count is null), unless `--force` is passed.
 *
 * Env:
 *   R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const MASTER_SHEET = "Territory Master Sheet";
const MAPPING_SHEET = "Rep Code RSM ISR Mapping";
const ZIP_CHUNK = 2000;
const REP_CHUNK = 500;

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

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const dryRun = process.argv.includes("--dry-run");

  const sb: SupabaseClient = createClient(
    env("SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // Latest territory ingestion (Graph cron lands these; pass-through leaves
  // row_count null until we parse).
  const { data, error } = await sb
    .from("data_ingestions")
    .select("id, r2_key, row_count")
    .eq("source", "territory")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`ingestion lookup failed: ${error.message}`);
  if (!data) {
    console.log("[territory-sync] no territory ingestion found; nothing to do.");
    return;
  }
  const ingestion = data as LatestIngestion;
  if (ingestion.row_count != null && !force) {
    console.log(
      `[territory-sync] latest territory ingestion ${ingestion.id} already parsed ` +
        `(row_count=${ingestion.row_count}); skipping. Use --force to re-parse.`,
    );
    return;
  }

  console.log(`[territory-sync] parsing ${ingestion.r2_key} (ingestion ${ingestion.id})`);
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
    console.log(`[territory-sync] downloaded ${bytes.length} bytes`);

    // Parse with SheetJS (real RAM) + the shared parser — exact cached values.
    const wb = XLSX.read(bytes, {
      type: "array",
      sheets: [MASTER_SHEET, MAPPING_SHEET],
      dense: true,
    });
    const master = wb.Sheets[MASTER_SHEET];
    if (!master) throw new Error(`missing sheet "${MASTER_SHEET}"`);
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(master, {
      header: 1,
      blankrows: false,
    });
    const header = parseTerritoryHeader((matrix[0] as unknown[]) ?? []);
    if (!header) throw new Error("Territory Master Sheet has no Zip Code column");

    const aggregates = new Map<string, RepAggregate>();
    const zipRows: {
      rep_code: string;
      zip: string;
      channel: string;
      ingestion_id: string;
    }[] = [];
    for (let r = 1; r < matrix.length; r++) {
      const row = matrix[r] as unknown[] | undefined;
      if (!row) continue;
      for (const rz of unpivotTerritoryRow(row, header)) {
        addToAggregate(aggregates, rz);
        zipRows.push({
          rep_code: rz.repCode,
          zip: rz.zip,
          channel: rz.channel,
          ingestion_id: ingestion.id,
        });
      }
    }

    const mapSheet = wb.Sheets[MAPPING_SHEET];
    const mappingRows = mapSheet
      ? XLSX.utils.sheet_to_json<Record<string, unknown>>(mapSheet, { defval: null })
      : [];
    const { mapping, duplicates } = parseRepCodeMapping(mappingRows);
    const repCodes = buildRepCodes(aggregates, mapping);

    console.log(
      `[territory-sync] parsed: ${zipRows.length} zip rows, ${repCodes.length} rep codes ` +
        `(mapping rows ${mappingRows.length}, dup ${duplicates})`,
    );
    if (zipRows.length === 0 && repCodes.length === 0) {
      throw new Error("parse produced no rows; refusing to prune");
    }

    // HubSpot push payload — zips come from the in-memory aggregate.
    const hubspotToken = process.env.HUBSPOT_TOKEN;
    const reps: RepForPush[] = repCodes.map((r) => ({
      repCode: r.repCode,
      district: r.district,
      rsmTsm: r.rsmTsm,
      salesDistrictCode: r.salesDistrictCode,
      isr: r.isr,
      amtRepCode: r.amtRepCode,
      zips: [...(aggregates.get(r.repCode)?.zips ?? [])],
    }));

    if (dryRun) {
      console.log("[territory-sync] --dry-run: skipping staging writes.");
      if (hubspotToken) {
        await syncRepCodesToHubspot({ token: hubspotToken, reps, dryRun: true });
      } else {
        console.log("[territory-sync] HUBSPOT_TOKEN unset; skipping HubSpot push");
      }
      return;
    }

    // Upsert rep_code_zips (chunked).
    for (let i = 0; i < zipRows.length; i += ZIP_CHUNK) {
      const { error: e } = await sb
        .from("rep_code_zips")
        .upsert(zipRows.slice(i, i + ZIP_CHUNK), { onConflict: "zip,channel" });
      if (e) throw new Error(`rep_code_zips upsert failed: ${e.message}`);
    }

    // Upsert rep_codes (chunked).
    const repRows = repCodes.map((r) => ({
      rep_code: r.repCode,
      district: r.district,
      rsm_tsm: r.rsmTsm,
      sales_district_code: r.salesDistrictCode,
      isr: r.isr,
      amt_rep_code: r.amtRepCode,
      channels: r.channels,
      zip_count: r.zipCount,
      ingestion_id: ingestion.id,
      updated_at: iso(),
    }));
    for (let i = 0; i < repRows.length; i += REP_CHUNK) {
      const { error: e } = await sb
        .from("rep_codes")
        .upsert(repRows.slice(i, i + REP_CHUNK), { onConflict: "rep_code" });
      if (e) throw new Error(`rep_codes upsert failed: ${e.message}`);
    }

    // Full-replace prune: drop rows not from this ingestion.
    const { error: pz, count: prunedZips } = await sb
      .from("rep_code_zips")
      .delete({ count: "exact" })
      .neq("ingestion_id", ingestion.id);
    if (pz) throw new Error(`rep_code_zips prune failed: ${pz.message}`);
    const { error: pr, count: prunedReps } = await sb
      .from("rep_codes")
      .delete({ count: "exact" })
      .neq("ingestion_id", ingestion.id);
    if (pr) throw new Error(`rep_codes prune failed: ${pr.message}`);

    // Push to HubSpot — non-fatal to the staging result (which is already done).
    let hubspotNote: string | null = null;
    if (hubspotToken) {
      try {
        const res = await syncRepCodesToHubspot({ token: hubspotToken, reps, dryRun: false });
        hubspotNote =
          `pushed ${res.pushed}; unmatched region=${res.unmatched.region.length} ` +
          `isr=${res.unmatched.isr.length} rsm=${res.unmatched.rsm.length}`;
      } catch (he) {
        hubspotNote = `HubSpot push FAILED: ${he instanceof Error ? he.message : String(he)}`;
        console.error(`[territory-sync] ${hubspotNote}`);
        process.exitCode = 1;
      }
    } else {
      console.log("[territory-sync] HUBSPOT_TOKEN unset; skipping HubSpot push");
    }

    await sb
      .from("data_ingestions")
      .update({
        status: "succeeded",
        row_count: zipRows.length,
        inserted_count: zipRows.length,
        closed_count: (prunedZips ?? 0) + (prunedReps ?? 0),
        error_count: 0,
        stats_json: {
          zipRows: zipRows.length,
          repCodes: repCodes.length,
          mappingRows: mappingRows.length,
          mappingDuplicates: duplicates,
          hubspot: hubspotNote,
        },
        finished_at: iso(),
        updated_at: iso(),
      })
      .eq("id", ingestion.id);

    console.log(
      `[territory-sync] done: rep_code_zips=${zipRows.length}, rep_codes=${repCodes.length}, ` +
        `pruned=${(prunedZips ?? 0) + (prunedReps ?? 0)}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[territory-sync] FAILED: ${msg}`);
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
