/**
 * Company sub-type classification — candidate builder + backfill (Node CLI).
 *
 *   buildSubTypeCandidates  — crawl every company, tally the company_sub_type
 *                             values in use, derive the curated candidate set
 *                             (junk/typos dropped, frequency-ranked) and write it
 *                             to company_sub_type_candidates. The API Worker reads
 *                             these when classifying. No LLM cost.
 *
 *   backfillCompanySubTypes — crawl companies with a BLANK sub-type and POST each
 *                             to the Worker's classify endpoint (one shared
 *                             classification code path). Gated: requires an
 *                             explicit limit (or --all), supports --dry-run
 *                             (enumerate only, no LLM) and --no-write (classify +
 *                             log, no HubSpot write) so spend can be proven on a
 *                             small sample before any large run.
 *
 * The per-company classification logic itself lives in the Worker
 * (apps/api/src/companyClassify.ts); this only enumerates + dispatches.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COMPANY_SUB_TYPE_PROP,
  deriveSubTypeCandidates,
  type SubTypeOption,
} from "@wac/shared";

const BASE = "https://api.hubapi.com";

interface HsRes {
  ok: boolean;
  status: number;
  data: any;
}

async function hs(token: string, method: string, path: string, body?: unknown): Promise<HsRes> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      // Timeout/network error — retry a few times, then surface it.
      if (attempt < 6) {
        await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** attempt)));
        continue;
      }
      throw e;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      const ra = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, ra > 0 ? ra * 1000 : Math.min(10_000, 500 * 2 ** attempt)));
      continue;
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  }
}

/** Fetch the current company_sub_type option list (value+label) from HubSpot. */
async function fetchSubTypeOptions(token: string): Promise<SubTypeOption[]> {
  const res = await hs(token, "GET", `/crm/v3/properties/companies/${COMPANY_SUB_TYPE_PROP}`);
  if (!res.ok) throw new Error(`property fetch ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  const options = (res.data?.options ?? []) as { label?: string; value?: string }[];
  return options.map((o) => ({
    value: String(o.value ?? o.label ?? ""),
    label: String(o.label ?? o.value ?? ""),
  }));
}

export interface BuildCandidatesResult {
  scanned: number;
  distinctUsed: number;
  candidates: { value: string; count: number }[];
}

/**
 * Crawl all companies, tally company_sub_type usage, derive + persist the
 * candidate set. Idempotent; run with dryRun to preview the list.
 */
export async function buildSubTypeCandidates(opts: {
  sb: SupabaseClient;
  token: string;
  dryRun: boolean;
  minCount?: number;
}): Promise<BuildCandidatesResult> {
  const { sb, token, dryRun } = opts;
  const tallies = new Map<string, number>();
  let scanned = 0;
  let after: string | undefined;

  do {
    const qs = `?limit=100&properties=${COMPANY_SUB_TYPE_PROP}${after ? `&after=${after}` : ""}`;
    const res = await hs(token, "GET", `/crm/v3/objects/companies${qs}`);
    if (!res.ok) throw new Error(`companies list ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    for (const c of res.data?.results ?? []) {
      scanned++;
      const v = String(c.properties?.[COMPANY_SUB_TYPE_PROP] ?? "").trim();
      if (v) tallies.set(v, (tallies.get(v) ?? 0) + 1);
    }
    after = res.data?.paging?.next?.after;
  } while (after);

  const options = await fetchSubTypeOptions(token);
  const candidates = deriveSubTypeCandidates(tallies, options, { minCount: opts.minCount });

  if (!dryRun) {
    const now = new Date().toISOString();
    const rows = candidates.map((c) => ({
      value: c.value,
      label: c.label,
      count: c.count,
      enabled: true,
      updated_at: now,
    }));
    if (rows.length) {
      const { error } = await sb
        .from("company_sub_type_candidates")
        .upsert(rows, { onConflict: "value" });
      if (error) throw new Error(`candidates upsert failed: ${error.message}`);
    }
    // Disable any previously-stored candidate no longer in the derived set.
    const keep = new Set(candidates.map((c) => c.value));
    const { data: existing } = await sb.from("company_sub_type_candidates").select("value");
    const toDisable = ((existing ?? []) as { value: string }[])
      .map((r) => r.value)
      .filter((v) => !keep.has(v));
    if (toDisable.length) {
      const { error } = await sb
        .from("company_sub_type_candidates")
        .update({ enabled: false, updated_at: now })
        .in("value", toDisable);
      if (error) throw new Error(`candidates disable failed: ${error.message}`);
    }
  }

  return {
    scanned,
    distinctUsed: tallies.size,
    candidates: candidates.map((c) => ({ value: c.value, count: c.count })),
  };
}

const CRAWL_PROPS = ["name", COMPANY_SUB_TYPE_PROP, "description", "industry", "website", "domain"].join(",");

export interface BackfillResult {
  scanned: number;
  blank: number;
  skippedAttempted: number;
  processed: number;
  byStatus: Record<string, number>;
  wrote: number;
  promptTokens: number;
  outputTokens: number;
}

/** Run async work over items with a fixed concurrency. */
async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

/**
 * Crawl companies, classify the ones with a blank sub-type via the Worker.
 *
 * - dryRun: enumerate only (no POST, no LLM cost).
 * - write=false: POST with write:false (real LLM + audit log, no HubSpot write).
 * - force: re-process companies already in the audit table.
 * - limit: max companies to PROCESS (not scan); enforced by the caller's gate.
 */
export async function backfillCompanySubTypes(opts: {
  sb: SupabaseClient;
  token: string;
  appBaseUrl: string;
  classifyToken: string;
  dryRun: boolean;
  write: boolean;
  force: boolean;
  limit?: number;
  concurrency?: number;
}): Promise<BackfillResult> {
  const { sb, token, appBaseUrl, classifyToken, dryRun, write, force, limit } = opts;
  const concurrency = opts.concurrency ?? 6;
  const url = `${appBaseUrl.replace(/\/$/, "")}/api/hubspot/classify-company/sync`;

  // Preload already-attempted company ids (skip unless --force).
  const attempted = new Set<string>();
  if (!force) {
    const { data, error } = await sb.from("company_sub_type_classifications").select("company_id");
    if (error) throw new Error(`audit preload failed: ${error.message}`);
    for (const r of (data ?? []) as { company_id: string }[]) attempted.add(r.company_id);
  }

  const result: BackfillResult = {
    scanned: 0,
    blank: 0,
    skippedAttempted: 0,
    processed: 0,
    byStatus: {},
    wrote: 0,
    promptTokens: 0,
    outputTokens: 0,
  };

  const classifyOne = async (company: { id: string; properties: Record<string, unknown> }) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${classifyToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          companyId: company.id,
          properties: company.properties,
          source: "backfill",
          write,
        }),
        // Client-side ceiling so a hung request can't block a worker forever
        // (the Worker's own /sync ceiling is 45s; give it margin).
        signal: AbortSignal.timeout(60_000),
      });
      const out = (await res.json().catch(() => ({}))) as {
        status?: string;
        wrote?: boolean;
        promptTokens?: number | null;
        outputTokens?: number | null;
      };
      const status = out.status ?? `http_${res.status}`;
      result.byStatus[status] = (result.byStatus[status] ?? 0) + 1;
      if (out.wrote) result.wrote++;
      result.promptTokens += out.promptTokens ?? 0;
      result.outputTokens += out.outputTokens ?? 0;
    } catch (e) {
      result.byStatus.error = (result.byStatus.error ?? 0) + 1;
      console.error(`[subtype-backfill] ${company.id} POST failed:`, e instanceof Error ? e.message : e);
    }
  };

  // Fetch ONLY blank-AND-has-a-site companies directly via search, in record-id
  // order. This skips the wasted crawl of already-classified companies AND the
  // no-website ones (which always no_data) entirely. Two filter groups (OR'd):
  // blank+website or blank+domain. The hs_object_id cursor pages past search's
  // 10k window. Written companies drop out of results automatically.
  const searchProps = CRAWL_PROPS.split(",");
  let lastId = "0";
  outer: for (;;) {
    const idFilter = { propertyName: "hs_object_id", operator: "GT", value: lastId };
    const res = await hs(token, "POST", "/crm/v3/objects/companies/search", {
      filterGroups: [
        {
          filters: [
            { propertyName: COMPANY_SUB_TYPE_PROP, operator: "NOT_HAS_PROPERTY" },
            { propertyName: "website", operator: "HAS_PROPERTY" },
            idFilter,
          ],
        },
        {
          filters: [
            { propertyName: COMPANY_SUB_TYPE_PROP, operator: "NOT_HAS_PROPERTY" },
            { propertyName: "domain", operator: "HAS_PROPERTY" },
            idFilter,
          ],
        },
      ],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      properties: searchProps,
      limit: 200,
    });
    if (!res.ok) throw new Error(`companies search ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
    const results = (res.data?.results ?? []) as { id: string | number; properties?: Record<string, unknown> }[];
    if (!results.length) break;

    const todo: { id: string; properties: Record<string, unknown> }[] = [];
    for (const c of results) {
      result.scanned++;
      result.blank++; // every result is blank-with-a-site by construction
      const id = String(c.id);
      lastId = id; // results are sorted ascending by id → advance the cursor
      const props = (c.properties ?? {}) as Record<string, unknown>;
      if (!force && attempted.has(id)) {
        result.skippedAttempted++;
        continue;
      }
      if (limit && result.processed + todo.length >= limit) {
        todo.push({ id, properties: props });
        break;
      }
      todo.push({ id, properties: props });
    }

    const batch = limit ? todo.slice(0, Math.max(0, limit - result.processed)) : todo;
    result.processed += batch.length;
    if (!dryRun && batch.length) {
      await mapWithConcurrency(batch, concurrency, classifyOne);
    } else if (dryRun) {
      for (const b of batch) result.byStatus.would_process = (result.byStatus.would_process ?? 0) + 1;
    }

    if (limit && result.processed >= limit) break outer;
  }

  return result;
}

export interface ReportRow {
  companyId: string;
  name: string;
  site: string;
  result: string;
  confidence: number | null;
}

/**
 * Read recent classification attempts from the audit table and join the company
 * name from HubSpot, so picks from a (no-write) sample can be eyeballed. Read-only.
 */
export async function reportClassifications(opts: {
  sb: SupabaseClient;
  token: string;
  status?: string; // default "classified"
  limit?: number; // default 50
}): Promise<ReportRow[]> {
  const { sb, token } = opts;
  const status = opts.status ?? "classified";
  const limit = opts.limit ?? 50;

  const { data, error } = await sb
    .from("company_sub_type_classifications")
    .select("company_id, result, confidence")
    .eq("status", status)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`audit query failed: ${error.message}`);
  const rows = (data ?? []) as { company_id: string; result: string; confidence: number | null }[];
  if (!rows.length) return [];

  const meta = new Map<string, { name: string; site: string }>();
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const res = await hs(token, "POST", "/crm/v3/objects/companies/batch/read", {
      properties: ["name", "website", "domain"],
      inputs: chunk.map((r) => ({ id: r.company_id })),
    });
    for (const c of res.data?.results ?? []) {
      const p = c.properties ?? {};
      meta.set(String(c.id), { name: String(p.name ?? ""), site: String(p.website || p.domain || "") });
    }
  }

  return rows.map((r) => ({
    companyId: r.company_id,
    name: meta.get(r.company_id)?.name ?? "",
    site: meta.get(r.company_id)?.site ?? "",
    result: r.result,
    confidence: r.confidence,
  }));
}
