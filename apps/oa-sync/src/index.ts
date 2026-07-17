import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { oaRecordHash, type OaOrderDetail, type OaOrderSummary } from "@wac/shared";

import { OaClient } from "./oaClient.js";
import { pushOaToHubspot, type OaStagedRow } from "./hubspot.js";

/**
 * OA (international ERP) → HubSpot sync. One-way v1: pull the four OA lists
 * (+ order details where updateDate moved), stage everything in Supabase
 * oa_records, push CHANGED, non-China-destination records to HubSpot.
 * See supabase/migrations/0042_oa_records.sql and src/hubspot.ts headers for
 * the data model and collision-safety rules.
 *
 * Flags:
 *   --sample          print one raw page of each endpoint + one order detail
 *                     verbatim (schema introspection; no writes anywhere)
 *   --dry-run         pull + diff + print intended payloads; no writes
 *   --push-only       skip OA; push current staging (repair / sample rollout)
 *   --pull-only       pull + stage; no HubSpot push
 *   --quotes A,B      scope the push to specific OA quotation ids
 *   --orders A,B      scope the push to specific OA order ids
 *   --force           re-fetch details and re-push unchanged records
 *
 * Alerting = process exit code 1 → GitHub Actions failure notification (same
 * as every sibling sync).
 */

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
};

const iso = () => new Date().toISOString();
const asId = (v: unknown): string => String(v ?? "").trim();

// --- staging -----------------------------------------------------------------

interface StageInput {
  record_type: OaStagedRow["record_type"];
  oa_id: string;
  raw_json: Record<string, unknown>;
  oa_update_date?: string | null;
  oa_quote_number?: string | null;
  oa_account_number?: string | null;
  oa_project_id?: string | null;
}

async function loadStaged(sb: SupabaseClient): Promise<Map<string, { oa_update_date: string | null; detail_hash: string | null }>> {
  const map = new Map<string, { oa_update_date: string | null; detail_hash: string | null }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("oa_records")
      .select("record_type, oa_id, oa_update_date, detail_hash")
      .order("record_type")
      .order("oa_id")
      .range(from, from + 999);
    if (error) throw new Error(`oa_records read failed: ${error.message}`);
    const page = (data ?? []) as { record_type: string; oa_id: string; oa_update_date: string | null; detail_hash: string | null }[];
    for (const r of page) map.set(`${r.record_type}:${r.oa_id}`, { oa_update_date: r.oa_update_date, detail_hash: r.detail_hash });
    if (page.length < 1000) break;
  }
  return map;
}

async function stage(sb: SupabaseClient, rawInputs: StageInput[]): Promise<number> {
  // Dedupe within the run (last wins) — e.g. projects are keyed by name and
  // OA has duplicate project names; a same-key pair in one upsert batch is a
  // Postgres "cannot affect row a second time" error.
  const inputs = [...new Map(rawInputs.map((r) => [`${r.record_type}:${r.oa_id}`, r])).values()];
  if (inputs.length < rawInputs.length) {
    console.warn(`[oa-sync] deduped ${rawInputs.length - inputs.length} same-key records within this pull`);
  }
  let staged = 0;
  for (let i = 0; i < inputs.length; i += 200) {
    const batch = inputs.slice(i, i + 200).map((r) => ({
      ...r,
      detail_hash: oaRecordHash(r.raw_json),
      updated_at: iso(),
    }));
    const { error } = await sb.from("oa_records").upsert(batch, { onConflict: "record_type,oa_id" });
    if (error) throw new Error(`oa_records upsert failed: ${error.message}`);
    staged += batch.length;
  }
  return staged;
}

// --- pull --------------------------------------------------------------------

interface PullResult {
  staged: number;
  detailsFetched: number;
  detailFailures: number;
}

async function pull(oa: OaClient, sb: SupabaseClient, opts: { force?: boolean; orderIds?: Set<string> }): Promise<PullResult> {
  const prior = await loadStaged(sb);
  const inputs: StageInput[] = [];
  let detailsFetched = 0;
  let detailFailures = 0;

  // Orders: list is cheap; the detail (with the full embedded quotation) is
  // fetched only when the list row's updateDate moved vs staging (or --force).
  const orderList = await oa.listOrders();
  console.log(`[oa-sync] OA orders list: ${orderList.length}`);
  const detailByOrder = new Map<string, OaOrderDetail>();
  for (const summary of orderList as OaOrderSummary[]) {
    const id = asId(summary.id);
    if (!id) continue;
    if (opts.orderIds && !opts.orderIds.has(id)) continue;
    const before = prior.get(`order:${id}`);
    const unchanged = before && before.oa_update_date === (summary.updateDate ?? null);
    if (unchanged && !opts.force) continue;
    try {
      const detail = await oa.getOrder(id);
      detailByOrder.set(id, detail);
      detailsFetched++;
      const q = detail.quotation;
      inputs.push({
        record_type: "order",
        oa_id: id,
        raw_json: detail as Record<string, unknown>,
        oa_update_date: summary.updateDate ?? detail.updateDate ?? null,
        oa_quote_number: asId(q?.id ?? detail.quotationId) || null,
        oa_account_number: asId(q?.customer?.code) || null,
      });
    } catch (e) {
      detailFailures++;
      console.error(`[oa-sync] order ${id} detail fetch FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Quotes / projects / customers: schemas are young — stage whatever comes
  // back, keyed as best we can; the push layer is tolerant.
  const [quotes, projects, customers] = [await oa.listQuotes(), await oa.listProjects(), await oa.listCustomers()];
  console.log(`[oa-sync] OA quotes: ${quotes.length}, projects: ${projects.length}, customers: ${customers.length}`);
  for (const q of quotes) {
    const id = asId(q.id ?? (q as { quotationId?: unknown }).quotationId);
    if (!id) {
      console.warn(`[oa-sync] quote with no id skipped: ${JSON.stringify(q).slice(0, 120)}`);
      continue;
    }
    inputs.push({
      record_type: "quote",
      oa_id: id,
      raw_json: q,
      oa_update_date: asId((q as { updateDate?: unknown }).updateDate) || null,
      oa_quote_number: id,
      oa_account_number: asId((q as { customer?: { code?: unknown } }).customer?.code) || null,
      oa_project_id: asId((q as { project?: { id?: unknown }; projectId?: unknown }).project?.id ?? (q as { projectId?: unknown }).projectId) || null,
    });
  }
  for (const p of projects) {
    const id = asId(p.id ?? (p as { name?: unknown }).name);
    if (!id) continue;
    inputs.push({
      record_type: "project",
      oa_id: id,
      raw_json: p,
      oa_update_date: asId((p as { updateDate?: unknown }).updateDate) || null,
      oa_project_id: id,
    });
  }
  for (const c of customers) {
    const id = asId((c as { code?: unknown }).code ?? c.id);
    if (!id) continue;
    inputs.push({
      record_type: "customer",
      oa_id: id,
      raw_json: c,
      oa_update_date: asId((c as { updateDate?: unknown }).updateDate) || null,
      oa_account_number: id,
    });
  }

  // Skip rows whose payload hash is unchanged (keeps updated_at meaningful and
  // Supabase writes minimal; push re-derives change from detail_hash anyway).
  const changed = inputs.filter((r) => {
    const before = prior.get(`${r.record_type}:${r.oa_id}`);
    return !before || before.detail_hash !== oaRecordHash(r.raw_json);
  });
  const staged = await stage(sb, changed);
  console.log(`[oa-sync] staged ${staged} changed records (${inputs.length} pulled, ${detailsFetched} order details fetched, ${detailFailures} detail failures)`);
  return { staged, detailsFetched, detailFailures };
}

// --- sample ------------------------------------------------------------------

async function runSample(oa: OaClient): Promise<void> {
  console.log("[oa-sync] SAMPLE — raw first pages of every endpoint (no writes)\n");
  for (const path of ["/orders", "/quotes", "/projects", "/customers"] as const) {
    try {
      const page = await oa.samplePage(path);
      console.log(`===== GET ${path} =====`);
      console.log(JSON.stringify(page, null, 2));
    } catch (e) {
      console.error(`===== GET ${path} FAILED: ${e instanceof Error ? e.message : e}`);
    }
    console.log("");
  }
  try {
    const orders = await oa.listOrders();
    const first = orders[0];
    if (first?.id !== undefined && first?.id !== null) {
      const detail = await oa.getOrder(String(first.id));
      console.log(`===== GET /order/${first.id} =====`);
      console.log(JSON.stringify(detail, null, 2));
    } else {
      console.log("===== no orders available for a detail sample =====");
    }
  } catch (e) {
    console.error(`===== order detail sample FAILED: ${e instanceof Error ? e.message : e}`);
  }
  console.log("\n[oa-sync] sample complete — no writes performed.");
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const has = (f: string) => argv.includes(f);
  const list = (flag: string): Set<string> | undefined => {
    const i = argv.findIndex((a) => a === flag);
    const v = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
    return v ? new Set(v.split(",").map((s) => s.trim()).filter(Boolean)) : undefined;
  };
  const dryRun = has("--dry-run");
  const force = has("--force");
  const quoteIds = list("--quotes");
  const orderIds = list("--orders");

  const oa = new OaClient(env("OA_API_SECRET"));

  if (has("--sample")) {
    await runSample(oa);
    return;
  }

  const sb: SupabaseClient = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let pullFailures = 0;
  if (!has("--push-only")) {
    if (dryRun) {
      // Dry run stages nothing; it reports what WOULD stage, then previews the
      // push from current staging + would-be payloads.
      const prior = await loadStaged(sb);
      const orders = await oa.listOrders();
      const changedOrders = orders.filter((o) => {
        const before = prior.get(`order:${asId(o.id)}`);
        return !before || before.oa_update_date !== (o.updateDate ?? null);
      });
      const [quotes, projects, customers] = [await oa.listQuotes(), await oa.listProjects(), await oa.listCustomers()];
      console.log(
        `[oa-sync] DRY RUN — OA has ${orders.length} orders (${changedOrders.length} new/changed), ${quotes.length} quotes, ${projects.length} projects, ${customers.length} customers; staging untouched`,
      );
    } else {
      const res = await pull(oa, sb, { force, orderIds });
      pullFailures = res.detailFailures;
    }
  }

  if (!has("--pull-only")) {
    await pushOaToHubspot(sb, env("HUBSPOT_TOKEN"), { dryRun, force, quoteIds, orderIds });
  }

  if (pullFailures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`[oa-sync] fatal: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  process.exitCode = 1;
});
