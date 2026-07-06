import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import * as fs from "node:fs";
import {
  addToAggregate,
  buildRepCodes,
  parseAmtIsrMapping,
  parseRepCodeMapping,
  parseTerritoryHeader,
  unpivotTerritoryRow,
  type RepAggregate,
} from "@wac/shared";
import { buildOwnerResolver, syncRepCodesToHubspot, type RepForPush } from "./hubspot.js";
import {
  backfillCompanySubTypes,
  buildSubTypeCandidates,
  reportClassifications,
} from "./companySubType.js";
import {
  buildInsideSalesResolvers,
  reconcileCompanyInsideSales,
  reconcileDealOwners,
  reconcileManagersRollup,
  reconcileRepCodeOwners,
  reconcileRepCodeSync,
  reconcileSpecifierAssociations,
  type AmtIsrRow,
  type RepIsrRow,
} from "./insideSales.js";
import { backfillRepCodes } from "./repCodeBackfill.js";
import { reconcileDealCloseDates } from "./dealCloseDates.js";
import { reconcileDealCreateDates } from "./dealCreateDates.js";

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
const AMT_SHEET = "AMT ISR Mapping";
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

/**
 * Inside-Sales reconciliation mode (Phase 3 one-time backfill / Phase 2 sweep):
 * load the rep-code mapping from the `rep_codes` table (the source of truth,
 * refreshed by the normal parse), build the AMT/rep-code -> owner resolvers, then
 * reconcile every company's ISR fields + the Rep Code owners. Idempotent; run
 * `--dry-run` first to see the change counts.
 */
/** Read an AMT→ISR CSV (cols: AMT Rep Code, Inside Sales Person, …) — validation escape hatch. */
function readAmtCsv(path: string): AmtIsrRow[] {
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const out: AmtIsrRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(",");
    const amt = (cols[0] ?? "").trim();
    const person = (cols[1] ?? "").trim();
    if (amt && person) out.push({ amtRepCode: amt, insideSalesPerson: person });
  }
  return out;
}

async function runInsideSalesReconcile(
  sb: SupabaseClient,
  dryRun: boolean,
  limit?: number,
  amtCsvPath?: string,
): Promise<void> {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    console.log("[inside-sales] HUBSPOT_TOKEN unset; cannot reconcile.");
    return;
  }
  const { data, error } = await sb.from("rep_codes").select("rep_code, amt_rep_code, isr");
  if (error) throw new Error(`rep_codes load failed: ${error.message}`);
  const rows: RepIsrRow[] = (data ?? []).map((r: any) => ({
    repCode: r.rep_code,
    amtRepCode: r.amt_rep_code,
    isr: r.isr,
  }));
  if (!rows.length) {
    console.log("[inside-sales] rep_codes table is empty; run the parse first. Aborting.");
    return;
  }

  // AMT→ISR roster: from the local CSV override (validation) else the amt_isr_map table.
  let amtRows: AmtIsrRow[] = [];
  if (amtCsvPath) {
    amtRows = readAmtCsv(amtCsvPath);
    console.log(`[inside-sales] AMT roster from CSV ${amtCsvPath}: ${amtRows.length} rows`);
  } else {
    const { data: amtData, error: amtErr } = await sb
      .from("amt_isr_map")
      .select("amt_rep_code, inside_sales_person");
    if (amtErr) {
      console.warn(`[inside-sales] amt_isr_map load failed: ${amtErr.message} (rep-sheet AMTs only)`);
    }
    amtRows = (amtData ?? []).map((r: any) => ({
      amtRepCode: r.amt_rep_code,
      insideSalesPerson: r.inside_sales_person,
    }));
    console.log(`[inside-sales] AMT roster from amt_isr_map: ${amtRows.length} rows`);
  }

  const owner = await buildOwnerResolver(token);
  const resolvers = buildInsideSalesResolvers(rows, amtRows, owner);
  console.log(
    `[inside-sales] resolvers built from sheet: ${resolvers.amtToOwner.size} AMT codes, ` +
      `${resolvers.repCodeToOwner.size} rep codes${dryRun ? " (DRY RUN — no writes)" : ""}`,
  );

  // Rep-code owners FIRST — derives unmapped rep codes' ISR from the agency
  // company's AMT and AUGMENTS resolvers.repCodeToOwner so the company pass below
  // can resolve no-AMT accounts serviced by those rep codes.
  const rep = await reconcileRepCodeOwners({ token, resolvers, dryRun });
  console.log(
    `[inside-sales] rep code owners: scanned=${rep.scanned} ${dryRun ? "would-update" : "updated"}=${rep.updated} ` +
      `(augmented ${rep.augmented} from agency-company AMT) → resolver now has ${resolvers.repCodeToOwner.size} rep codes`,
  );

  const co = await reconcileCompanyInsideSales({ token, resolvers, dryRun, limit });
  const affected = co.unresolved.reduce((s, u) => s + u.companies, 0);
  console.log(
    `[inside-sales] companies: scanned=${co.scanned} ${dryRun ? "would-update" : "updated"}=${co.updated} ` +
      `unresolved=${co.unresolved.length} codes across ${affected} companies`,
  );
  if (co.unresolved.length) {
    console.log("[inside-sales] unresolved codes (code×companies):");
    console.log(`  ${co.unresolved.map((u) => `${u.code}×${u.companies}`).join("  ")}`);
  }

  // Deal owners LAST — re-own each ACTIVE deal (not closed-won/closed-lost) to its
  // rep code's owner via sales_group. First run is the backfill; later runs are the
  // sheet-change sweep + self-heal. Resolver is fully augmented by the rep-code pass.
  const dl = await reconcileDealOwners({ token, resolvers, dryRun, limit });
  console.log(
    `[inside-sales] deal owners: scanned=${dl.scanned} ${dryRun ? "would-update" : "updated"}=${dl.updated} ` +
      `skippedClosed=${dl.skippedClosed} unresolved=${dl.unresolved.length} codes`,
  );
  if (dl.unresolved.length) {
    console.log("[inside-sales] unresolved deal rep codes (code×deals):");
    console.log(`  ${dl.unresolved.map((u) => `${u.code}×${u.deals}`).join("  ")}`);
  }

  // Rep Code ← agency company field sync + "Inactive" label (absorbs the
  // "Account # to Rep Code Syncing" + status workflows). Idempotent backstop /
  // backfill for the real-time path in the API Worker.
  const rcs = await reconcileRepCodeSync({ token, dryRun, limit });
  console.log(
    `[rep-sync] rep codes: scanned=${rcs.scanned} ${dryRun ? "would-update" : "updated"}-fields=${rcs.fieldsUpdated} ` +
      `inactive=${rcs.inactive} labels(+${rcs.labelsAdded}/-${rcs.labelsRemoved}) failures=${rcs.failures}` +
      `${rcs.labelMissing ? " [Inactive label not set up — labeling skipped]" : ""}`,
  );

  // Specifier companies → Opportunity associations (absorbs the 5 "Associated
  // Specifier N to Opportunity" workflows). Idempotent backstop for the real-time
  // path; the first full run is the backfill of every existing Opportunity.
  const spec = await reconcileSpecifierAssociations({ token, dryRun, limit });
  console.log(
    `[specifier-assoc] deals: scanned=${spec.scanned} ${dryRun ? "would-associate" : "associated"}=${spec.associated} ` +
      `unresolved=${spec.unresolved}${spec.labelMissing ? " [Specifier label not set up — labeling skipped]" : ""}`,
  );
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const dryRun = process.argv.includes("--dry-run");
  const reconcileInsideSales =
    process.argv.includes("--backfill-companies") || process.argv.includes("--reconcile-inside-sales");

  const sb: SupabaseClient = createClient(
    env("SUPABASE_URL"),
    env("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) || undefined : undefined;

  // One-time corrective: realign inside_sales_managers to the manager_1/_2 rollup.
  if (process.argv.includes("--fix-managers-rollup")) {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) {
      console.log("[managers-rollup] HUBSPOT_TOKEN unset; nothing to do.");
      return;
    }
    const r = await reconcileManagersRollup({ token, dryRun, limit });
    console.log(
      `[managers-rollup] scanned=${r.scanned} ${dryRun ? "would-update" : "updated"}=${r.updated}`,
    );
    return;
  }

  // One-time backfill for the missing-Rep-Code auto-create feature: create a Rep
  // Code record for every SAP-referenced code HubSpot lacks (companies'
  // sales_rep_code + deals' sales_group) and associate every referencing record
  // that has no association — pre-existing codes included. One review task per
  // created code. Run --dry-run first for the counts; --limit=N to sample scans.
  if (process.argv.includes("--backfill-rep-codes")) {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) {
      console.log("[rep-backfill] HUBSPOT_TOKEN unset; nothing to do.");
      return;
    }
    const r = await backfillRepCodes({
      sb,
      token,
      dryRun,
      limit,
      alertOwnerEmail: process.env.REP_CODE_ALERT_OWNER_EMAIL,
    });
    const verb = dryRun ? "would-" : "";
    console.log(
      `[rep-backfill] scanned companies=${r.companiesScanned} deals=${r.dealsScanned} | ` +
        `rep codes existing=${r.repCodesExisting} referenced=${r.codesReferenced}`,
    );
    console.log(
      `[rep-backfill] ${verb}create=${r.created.length} invalid-skipped=${r.invalid.length} | ` +
        `assoc gaps companies=${r.companyAssocsMissing} deals=${r.dealAssocsMissing}` +
        (dryRun
          ? ""
          : ` | created assocs companies=${r.companyAssocsCreated} deals=${r.dealAssocsCreated} tasks=${r.tasksCreated}`),
    );
    if (r.created.length) {
      console.log(
        `[rep-backfill] ${verb}created codes:\n  ` +
          r.created.map((c) => `${c.code}${c.owner ? " (owner resolved)" : ""}`).join("\n  "),
      );
    }
    if (r.invalid.length) {
      console.log(
        "[rep-backfill] invalid values skipped (companies/deals referencing):\n  " +
          r.invalid.map((v) => `"${v.value}" (${v.companies}/${v.deals})`).join("\n  "),
      );
    }
    if (r.gapByCode.length) {
      console.log(
        "[rep-backfill] association gaps by code (companies/deals, top 40):\n  " +
          r.gapByCode
            .sort((a, b) => b.companies + b.deals - (a.companies + a.deals))
            .slice(0, 40)
            .map((g) => `${g.code}${g.exists ? "" : " [new]"} (${g.companies}/${g.deals})`)
            .join("\n  "),
      );
    }
    for (const f of [...r.createFailures, ...r.assocFailures, ...r.taskFailures]) {
      console.warn(`[rep-backfill] WARN: ${f}`);
    }
    return;
  }

  // Specifier → Opportunity associations on their own (the one-time backfill of every
  // existing Opportunity; run with no --limit). Runs daily as part of the inside-sales
  // reconcile too — this flag just lets it run standalone.
  if (process.argv.includes("--reconcile-specifiers")) {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) {
      console.log("[specifier-assoc] HUBSPOT_TOKEN unset; nothing to do.");
      return;
    }
    const r = await reconcileSpecifierAssociations({ token, dryRun, limit });
    console.log(
      `[specifier-assoc] deals: scanned=${r.scanned} ${dryRun ? "would-associate" : "associated"}=${r.associated} ` +
        `unresolved=${r.unresolved}${r.labelMissing ? " [Specifier label not set up — labeling skipped]" : ""}`,
    );
    return;
  }

  // Deal stage + close-date reconcile (the backfill/audit companion of the absorbed
  // stage-mapping + close-date HubSpot workflows): promote stuck Awarded deals whose
  // line items converted, and set/correct closedate to the oldest quote_conversion_date.
  // ALWAYS run --dry-run (with --csv=path) and review before applying; --include-lost
  // additionally applies the Closed-Lost close-date rule (proposals are reported either way).
  if (process.argv.includes("--reconcile-deal-close-dates")) {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) {
      console.log("[close-dates] HUBSPOT_TOKEN unset; nothing to do.");
      return;
    }
    const csvArg = process.argv.find((a) => a.startsWith("--csv="));
    const r = await reconcileDealCloseDates({
      token,
      dryRun,
      limit,
      includeLost: process.argv.includes("--include-lost"),
      csvPath: csvArg ? csvArg.split("=")[1] : undefined,
    });
    const verb = dryRun ? "would-" : "";
    console.log(
      `[close-dates] scanned=${r.scanned} candidates=${r.candidates} withLineDates=${r.withLineDates}`,
    );
    console.log(
      `[close-dates] ${verb}promote awarded→closed-won=${r.stagePromotions} | closedate ${verb}set=${r.closedatesSet} ${verb}corrected=${r.closedatesCorrected} | ` +
        `lost proposals=${r.lostProposals}${process.argv.includes("--include-lost") ? " (applied)" : " (REPORT ONLY — apply with --include-lost)"}`,
    );
    console.log(
      `[close-dates] quote_conversion_date ${verb}set=${r.conversionDatesSet} ${verb}corrected=${r.conversionDatesCorrected}`,
    );
    console.log(`[close-dates] ${verb}updated deals=${r.updated}`);
    for (const f of r.failures) console.warn(`[close-dates] WARN: ${f}`);
    return;
  }

  // Deal create-date reconcile (the backfill companion of the derived-createdate
  // write, DEAL_CREATEDATE_WRITE): backdate HubSpot's system createdate to the
  // SAP quote day (noon UTC) wherever quote_creation_date is on an earlier
  // calendar day — bulk-imported deals carry their import date. ALWAYS run
  // --dry-run (with --csv=path) and review before applying; the first real write
  // is a self-probing batch of 1 that read-back-verifies HubSpot persisted the
  // value and hard-aborts otherwise. --max-apply=N caps applied updates (sample
  // stage). Verify by re-running --dry-run until corrections=0.
  if (process.argv.includes("--reconcile-deal-create-dates")) {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) {
      console.log("[create-dates] HUBSPOT_TOKEN unset; nothing to do.");
      return;
    }
    const csvArg = process.argv.find((a) => a.startsWith("--csv="));
    const maxApplyArg = process.argv.find((a) => a.startsWith("--max-apply="));
    const r = await reconcileDealCreateDates({
      token,
      dryRun,
      limit,
      maxApply: maxApplyArg ? Number(maxApplyArg.split("=")[1]) || undefined : undefined,
      csvPath: csvArg ? csvArg.split("=")[1] : undefined,
    });
    const verb = dryRun ? "would-" : "";
    console.log(
      `[create-dates] scanned=${r.scanned} candidates=${r.candidates} | ` +
        `${verb}backdate=${r.corrections} quote-after-createdate (untouched)=${r.quoteAfterCreate}`,
    );
    console.log(`[create-dates] ${verb}updated deals=${r.updated}`);
    for (const f of r.failures) console.warn(`[create-dates] WARN: ${f}`);
    return;
  }

  // Build the curated company_sub_type candidate set from values actually in use
  // (junk/typos dropped, frequency-ranked). No LLM cost. Run --dry-run to preview.
  if (process.argv.includes("--build-subtype-candidates")) {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) {
      console.log("[subtype-candidates] HUBSPOT_TOKEN unset; nothing to do.");
      return;
    }
    const minArg = process.argv.find((a) => a.startsWith("--min-count="));
    const minCount = minArg ? Number(minArg.split("=")[1]) || undefined : undefined;
    const r = await buildSubTypeCandidates({ sb, token, dryRun, minCount });
    console.log(
      `[subtype-candidates] scanned=${r.scanned} distinctUsed=${r.distinctUsed} ` +
        `candidates=${r.candidates.length}${dryRun ? " (DRY RUN — not written)" : ""}`,
    );
    console.log(
      "[subtype-candidates] top:\n  " +
        r.candidates.slice(0, 40).map((c) => `${c.value} (${c.count})`).join("\n  "),
    );
    return;
  }

  // Backfill: classify companies with a BLANK sub-type via the Worker endpoint.
  // GATED so the full population can't run by accident — requires --limit=N or --all.
  //   --dry-run    enumerate only (no LLM cost)
  //   --no-write   real LLM + audit log, but no HubSpot write (the cost/quality sample)
  //   --force      re-process companies already attempted
  // Env: MARKETING_APP_URL (Worker base URL), REP_LOOKUP_TOKEN, HUBSPOT_TOKEN.
  if (process.argv.includes("--backfill-company-subtypes")) {
    const token = process.env.HUBSPOT_TOKEN;
    const appBaseUrl = process.env.MARKETING_APP_URL;
    const classifyToken = process.env.REP_LOOKUP_TOKEN;
    if (!token || !appBaseUrl || !classifyToken) {
      console.log(
        "[subtype-backfill] need HUBSPOT_TOKEN, MARKETING_APP_URL, and REP_LOOKUP_TOKEN; aborting.",
      );
      return;
    }
    const all = process.argv.includes("--all");
    if (!limit && !all) {
      console.log(
        "[subtype-backfill] refusing to run unbounded. Pass --limit=N (recommended) or --all. " +
          "Tip: start with `--dry-run` then `--limit=200 --no-write` to prove the cost.",
      );
      process.exitCode = 1;
      return;
    }
    const write = !process.argv.includes("--no-write");
    const force = process.argv.includes("--force");
    const concArg = process.argv.find((a) => a.startsWith("--concurrency="));
    const concurrency = concArg ? Number(concArg.split("=")[1]) || undefined : undefined;
    const r = await backfillCompanySubTypes({
      sb,
      token,
      appBaseUrl,
      classifyToken,
      dryRun,
      write,
      force,
      limit: all ? undefined : limit,
      concurrency,
    });
    console.log(
      `[subtype-backfill] scanned=${r.scanned} blank=${r.blank} skippedAttempted=${r.skippedAttempted} ` +
        `processed=${r.processed}${dryRun ? " (DRY RUN — no LLM)" : write ? "" : " (NO-WRITE)"}`,
    );
    console.log(`[subtype-backfill] byStatus=${JSON.stringify(r.byStatus)} wrote=${r.wrote}`);
    if (r.promptTokens || r.outputTokens) {
      console.log(
        `[subtype-backfill] tokens: prompt=${r.promptTokens} output=${r.outputTokens} ` +
          `→ avg/company prompt=${Math.round(r.promptTokens / Math.max(1, r.processed))} ` +
          `output=${Math.round(r.outputTokens / Math.max(1, r.processed))} ` +
          `(price these against your model's per-token rate, then × the blank count to project the full run)`,
      );
    }
    return;
  }

  // Show recent classification picks (name → sub-type @ confidence) from the
  // audit table, for eyeballing a no-write sample. Read-only.
  if (process.argv.includes("--report-subtype-classifications")) {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) {
      console.log("[subtype-report] HUBSPOT_TOKEN unset; nothing to do.");
      return;
    }
    const statusArg = process.argv.find((a) => a.startsWith("--status="));
    const status = statusArg ? statusArg.split("=")[1] : "classified";
    const rows = await reportClassifications({ sb, token, status, limit });
    console.log(`[subtype-report] ${rows.length} "${status}" picks (most recent first):`);
    for (const r of rows) {
      const conf = r.confidence == null ? "?" : r.confidence.toFixed(2);
      console.log(`  ${r.result}  @${conf}  ←  ${r.name || "(no name)"}${r.site ? `  [${r.site}]` : ""}`);
    }
    return;
  }

  // Standalone reconciliation mode — independent of the parse/upsert flow.
  if (reconcileInsideSales) {
    const amtCsvArg = process.argv.find((a) => a.startsWith("--amt-csv="));
    const amtCsv = amtCsvArg ? amtCsvArg.split("=").slice(1).join("=") : undefined;
    await runInsideSalesReconcile(sb, dryRun, limit, amtCsv);
    return;
  }

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
      sheets: [MASTER_SHEET, MAPPING_SHEET, AMT_SHEET],
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

    // "AMT ISR Mapping" tab — complete AMT Rep Code → Inside Sales Person roster.
    const amtSheet = wb.Sheets[AMT_SHEET];
    const amtRows = amtSheet
      ? XLSX.utils.sheet_to_json<Record<string, unknown>>(amtSheet, { defval: null })
      : [];
    const { mapping: amtMapping, errors: amtErrors, duplicates: amtDups } = parseAmtIsrMapping(amtRows);
    if (!amtSheet) console.warn(`[territory-sync] no "${AMT_SHEET}" tab found — AMT→ISR roster empty`);

    console.log(
      `[territory-sync] parsed: ${zipRows.length} zip rows, ${repCodes.length} rep codes ` +
        `(mapping rows ${mappingRows.length}, dup ${duplicates}); ` +
        `AMT ISR rows ${amtMapping.size} (dup ${amtDups}, errors ${amtErrors.length})`,
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

    // Upsert amt_isr_map (the AMT→ISR roster). Guarded: only touch it when the tab
    // produced rows, so a temporarily missing/empty tab never wipes the roster.
    if (amtMapping.size > 0) {
      const amtRowsDb = [...amtMapping.entries()].map(([amt, person]) => ({
        amt_rep_code: amt,
        inside_sales_person: person,
        ingestion_id: ingestion.id,
        updated_at: iso(),
      }));
      for (let i = 0; i < amtRowsDb.length; i += REP_CHUNK) {
        const { error: e } = await sb
          .from("amt_isr_map")
          .upsert(amtRowsDb.slice(i, i + REP_CHUNK), { onConflict: "amt_rep_code" });
        if (e) throw new Error(`amt_isr_map upsert failed: ${e.message}`);
      }
      const { error: pa } = await sb
        .from("amt_isr_map")
        .delete({ count: "exact" })
        .neq("ingestion_id", ingestion.id);
      if (pa) throw new Error(`amt_isr_map prune failed: ${pa.message}`);
    } else {
      console.warn("[territory-sync] AMT ISR roster empty — leaving amt_isr_map untouched");
    }

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
