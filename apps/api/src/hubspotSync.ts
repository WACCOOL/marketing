import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type HubspotObjectType,
  dedupKeyFor,
  detectUnmappedFields,
  sapChangedAtFor,
} from "@wac/shared";
import type { Env } from "./env.js";
import { pushDeal, pushCompany } from "./hubspotPush.js";

/** Wall-clock ceiling for an inline Worker push (deal + line items + assocs + retries). */
const PUSH_TIMEOUT_MS = 50_000;

/**
 * SAP -> HubSpot durable sync domain layer (Phase 1: capture only).
 *
 * The two AWS Lambdas keep pushing to HubSpot; they ALSO forward each raw
 * payload here (POST /capture/:object) and then the push outcome (POST /result).
 * We store the raw JSON in the R2 inbox and one `hubspot_sync_records` row per
 * DISTINCT payload, deduped by `idempotency_key` (= SHA-256 of the raw body the
 * Lambda computed). This is the durable audit/recovery backlog + the data behind
 * the review dashboard. Mirrors ingest.ts conventions, including the service-role
 * client (these tables have no write policy) and the post-insert R2 failure guard.
 */

export type HubspotSyncStatus =
  | "captured"
  | "received"
  | "pushing"
  | "succeeded"
  | "partial"
  | "held"
  | "failed"
  | "skipped";

/** A normalized per-field problem (powers the Errors + Summary dashboard tabs). */
export type FieldIssueCategory =
  | "enum_mismatch"
  | "unmapped_field"
  | "missing_required"
  | "assoc_not_found"
  | "rate_limit"
  | "hubspot_5xx"
  | "network"
  | "other";

export interface FieldIssueRow {
  id: string;
  record_id: string;
  object_type: string;
  property: string;
  raw_value: string | null;
  category: FieldIssueCategory;
  action: string | null;
  mapped_to: string | null;
  reason: string | null;
  created_at: string;
}

export interface HubspotSyncRecordRow {
  id: string;
  idempotency_key: string;
  object_type: string;
  status: HubspotSyncStatus;
  dedup_key: string | null;
  r2_key: string;
  payload_bytes: number | null;
  delivered_by: string | null;
  source: string;
  sap_changed_at: string | null;
  lambda_result_json: unknown;
  lambda_error: string | null;
  lambda_status: number | null;
  problem_count: number;
  receipt_count: number;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const RECORD_COLUMNS =
  "id, idempotency_key, object_type, status, dedup_key, r2_key, payload_bytes, delivered_by, source, sap_changed_at, lambda_result_json, lambda_error, lambda_status, problem_count, receipt_count, last_seen_at, created_at, updated_at, started_at, finished_at";

/**
 * A fix action forwarded by the Lambda's validation-fix path. The Deals Lambda
 * already builds these (`{property, from, to, action}`) — it just discards them
 * today. `assocSkips` carries the fail-soft company/contact association misses.
 */
export interface ForwardedFixAction {
  scope?: string; // 'deal' | 'line_item' | 'company'
  property: string;
  from?: string | null;
  to?: string | null;
  action?: string; // 'dropped' | 'normalized' | 'duplicate_ids_unresolved' | ...
  reason?: string;
}

export interface ForwardedAssocSkip {
  objectType?: string; // 'companies' | 'contacts'
  property?: string; // e.g. 'account_number' | 'requested_by'
  rawValue?: string | null;
  reason?: string;
}

/** Two-digit zero pad for the date-partitioned R2 prefix. */
function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Build the immutable, object- and time-partitioned inbox key:
 *   hubspot-sync/{object}/{yyyy}/{mm}/{dd}/{idem}__{dedup}.json
 * The idempotency hash leads the leaf so the key is globally unique; the R2 put
 * is gated on a genuine insert (below) so a delayed retry that crosses a UTC-day
 * boundary can't orphan a second object under a different date prefix.
 */
export function buildSyncKey(args: {
  objectType: string;
  idempotencyKey: string;
  dedupKey: string | null;
  now: Date;
}): string {
  const { objectType, idempotencyKey, dedupKey, now } = args;
  const yyyy = now.getUTCFullYear();
  const mm = pad2(now.getUTCMonth() + 1);
  const dd = pad2(now.getUTCDate());
  const dedup = (dedupKey ?? "no-key").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60);
  return `hubspot-sync/${objectType}/${yyyy}/${mm}/${dd}/${idempotencyKey}__${dedup}.json`;
}

/** SHA-256 hex of a string — fallback when the Lambda doesn't send a key. */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Capture a forwarded payload: upsert one row per distinct payload (deduped by
 * idempotency_key) and, ONLY on a genuine first insert, store the raw JSON in R2
 * and record any unmapped-field issues. Retries / identical re-sends bump
 * receipt_count instead of duplicating.
 */
export async function captureRecord(
  env: Env,
  serviceSb: SupabaseClient,
  args: {
    objectType: HubspotObjectType;
    idempotencyKey: string;
    payloadText: string;
    payload: Record<string, unknown>;
    deliveredBy: string;
    source?: string;
  },
): Promise<
  | { ok: true; row: HubspotSyncRecordRow; isNew: boolean }
  | { ok: false; error: string }
> {
  const dedupKey = dedupKeyFor(args.objectType, args.payload);
  const sapChangedAt = sapChangedAtFor(args.objectType, args.payload);
  const r2Key = buildSyncKey({
    objectType: args.objectType,
    idempotencyKey: args.idempotencyKey,
    dedupKey,
    now: new Date(),
  });
  const payloadBytes = new TextEncoder().encode(args.payloadText).byteLength;

  const { data, error } = await serviceSb
    .from("hubspot_sync_records")
    .insert({
      idempotency_key: args.idempotencyKey,
      object_type: args.objectType,
      status: "captured",
      dedup_key: dedupKey,
      r2_key: r2Key,
      payload_bytes: payloadBytes,
      delivered_by: args.deliveredBy,
      source: args.source ?? "lambda",
      sap_changed_at: sapChangedAt,
    })
    .select(RECORD_COLUMNS)
    .single();

  // Duplicate payload (retry / identical re-send): bump receipt_count and return
  // the existing row without re-storing R2 or re-detecting unmapped fields.
  if (error) {
    if (error.code === "23505") {
      const existing = await getRecordByKey(serviceSb, args.idempotencyKey);
      if (!existing) return { ok: false, error: "conflict but row not found" };
      await serviceSb
        .from("hubspot_sync_records")
        .update({
          receipt_count: existing.receipt_count + 1,
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      return {
        ok: true,
        row: { ...existing, receipt_count: existing.receipt_count + 1 },
        isNew: false,
      };
    }
    return { ok: false, error: error.message };
  }

  const row = data as HubspotSyncRecordRow;

  // Post-insert failure guard (mirrors createIngestion): if the R2 put fails
  // after the row is committed, mark it failed so it never sticks in `captured`.
  try {
    await env.ASSETS_BUCKET.put(r2Key, args.payloadText, {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await serviceSb
      .from("hubspot_sync_records")
      .update({
        status: "failed",
        lambda_error: `capture R2 put failed: ${msg}`,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { ok: false, error: `capture R2 put failed: ${msg}` };
  }

  // Record unmapped fields — data SAP sends that we silently drop today.
  const unmapped = detectUnmappedFields(args.objectType, args.payload);
  if (unmapped.length) {
    await serviceSb.from("hubspot_sync_field_issues").insert(
      unmapped.map((u) => ({
        record_id: row.id,
        object_type: u.objectType,
        property: u.property,
        raw_value: null,
        category: "unmapped_field" as FieldIssueCategory,
        action: "unmapped",
        reason: "field present in SAP payload but has no HubSpot mapping",
      })),
    );
    await serviceSb
      .from("hubspot_sync_records")
      .update({ problem_count: unmapped.length, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    row.problem_count = unmapped.length;
  }

  return { ok: true, row, isNew: true };
}

/** Map a forwarded fix action to a field_issue row shape. */
function fixActionToIssue(
  recordObjectType: string,
  a: ForwardedFixAction,
): Omit<FieldIssueRow, "id" | "record_id" | "created_at"> {
  const objectType =
    a.scope === "line_item"
      ? "line_items"
      : a.scope === "company"
        ? "companies"
        : recordObjectType;
  if (a.action === "normalized") {
    return {
      object_type: objectType,
      property: a.property,
      raw_value: a.from ?? null,
      category: "enum_mismatch",
      action: "normalized",
      mapped_to: a.to ?? null,
      reason: a.reason ?? `normalized "${a.from ?? ""}" → "${a.to ?? ""}"`,
    };
  }
  if (a.action === "duplicate_ids_unresolved") {
    return {
      object_type: objectType,
      property: a.property,
      raw_value: a.from ?? null,
      category: "other",
      action: "invalid",
      mapped_to: null,
      reason: a.reason ?? "duplicate ids in batch — unresolved",
    };
  }
  // default: dropped (no allowed-option match)
  return {
    object_type: objectType,
    property: a.property,
    raw_value: a.from ?? null,
    category: "enum_mismatch",
    action: "dropped",
    mapped_to: null,
    reason: a.reason ?? "dropped — no allowed option matched",
  };
}

/**
 * Patch a record with the Lambda's push outcome. Idempotent under async Lambda
 * retries: the outcome patch is last-write-wins, and the result-owned field
 * issues are REPLACED (delete-then-insert) rather than appended — but the
 * capture-owned `unmapped_field` issues are preserved. problem_count is SET to
 * the final issue count, never incremented.
 */
export async function patchResult(
  env: Env,
  serviceSb: SupabaseClient,
  args: {
    idempotencyKey: string;
    result?: unknown;
    error?: string | null;
    status?: number | null;
    fixActions?: ForwardedFixAction[];
    assocSkips?: ForwardedAssocSkip[];
  },
): Promise<{ ok: true; row: HubspotSyncRecordRow } | { ok: false; error: string }> {
  const record = await getRecordByKey(serviceSb, args.idempotencyKey);
  if (!record) return { ok: false, error: "not found" };

  // Replace result-owned issues; keep capture-owned unmapped issues.
  const { error: delErr } = await serviceSb
    .from("hubspot_sync_field_issues")
    .delete()
    .eq("record_id", record.id)
    .neq("category", "unmapped_field");
  if (delErr) return { ok: false, error: delErr.message };

  const issues = [
    ...(args.fixActions ?? []).map((a) => fixActionToIssue(record.object_type, a)),
    ...(args.assocSkips ?? []).map((s) => ({
      object_type: s.objectType ?? record.object_type,
      property: s.property ?? "association",
      raw_value: s.rawValue ?? null,
      category: "assoc_not_found" as FieldIssueCategory,
      action: "assoc_missing",
      mapped_to: null,
      reason: s.reason ?? "associated record not found in HubSpot",
    })),
  ];

  if (issues.length) {
    const { error: insErr } = await serviceSb
      .from("hubspot_sync_field_issues")
      .insert(issues.map((i) => ({ ...i, record_id: record.id })));
    if (insErr) return { ok: false, error: insErr.message };
  }

  // Recompute the total problem count (unmapped + result issues).
  const { count } = await serviceSb
    .from("hubspot_sync_field_issues")
    .select("id", { count: "exact", head: true })
    .eq("record_id", record.id);
  const problemCount = count ?? issues.length;

  const failed = !!args.error || (args.status != null && args.status >= 400);
  const hasHardIssue = issues.some((i) =>
    ["dropped", "invalid", "held", "assoc_missing"].includes(i.action ?? ""),
  );
  const status: HubspotSyncStatus = failed
    ? "failed"
    : hasHardIssue
      ? "partial"
      : "succeeded";

  const { data, error: updErr } = await serviceSb
    .from("hubspot_sync_records")
    .update({
      status,
      lambda_result_json: args.result ?? null,
      lambda_error: args.error ?? null,
      lambda_status: args.status ?? null,
      problem_count: problemCount,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", record.id)
    .select(RECORD_COLUMNS)
    .single();
  if (updErr || !data) return { ok: false, error: updErr?.message ?? "update failed" };
  return { ok: true, row: data as HubspotSyncRecordRow };
}

/**
 * Phase 2: capture the payload AND push it to HubSpot from the Worker, recording
 * the full outcome. Captures first (durable), marks the row `pushing`, runs the
 * mapping/heal/resolution + HubSpot writes (hubspotPush.ts), then patches the row
 * with the result + field issues. Idempotent re-sends re-push (HubSpot upsert).
 */
export async function captureAndPush(
  env: Env,
  serviceSb: SupabaseClient,
  args: {
    objectType: HubspotObjectType;
    idempotencyKey: string;
    payloadText: string;
    payload: Record<string, unknown>;
    deliveredBy: string;
    source?: string;
  },
): Promise<{ ok: true; recordId: string; status: HubspotSyncStatus } | { ok: false; error: string }> {
  const cap = await captureRecord(env, serviceSb, args);
  if (!cap.ok) return { ok: false, error: cap.error };
  const recordId = cap.row.id;

  await serviceSb
    .from("hubspot_sync_records")
    .update({ status: "pushing", started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", recordId);

  const signal = AbortSignal.timeout(PUSH_TIMEOUT_MS);
  const outcome =
    args.objectType === "deals"
      ? await pushDeal(env, serviceSb, args.payload, signal)
      : await pushCompany(env, serviceSb, args.payload, signal);

  const patched = await patchResult(env, serviceSb, {
    idempotencyKey: args.idempotencyKey,
    result: outcome.result,
    error: outcome.error,
    status: outcome.status,
    fixActions: outcome.fixActions,
    assocSkips: outcome.assocSkips,
  });
  if (!patched.ok) return { ok: false, error: patched.error };
  return { ok: true, recordId, status: patched.row.status };
}

/**
 * Re-push one already-captured record from its stored R2 payload and patch the
 * SAME row (by its idempotency_key) in place. Used to backfill/fix records after
 * mappings/aliases improve. Idempotent (HubSpot upsert) and self-healing.
 */
export async function replayRecord(
  env: Env,
  serviceSb: SupabaseClient,
  recordId: string,
): Promise<{ ok: true; status: HubspotSyncStatus } | { ok: false; error: string }> {
  const record = await getRecord(serviceSb, recordId);
  if (!record) return { ok: false, error: "not found" };
  const obj = await env.ASSETS_BUCKET.get(record.r2_key);
  if (!obj) return { ok: false, error: "payload missing in R2" };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(await obj.text());
  } catch {
    return { ok: false, error: "stored payload is not valid JSON" };
  }

  await serviceSb
    .from("hubspot_sync_records")
    .update({ status: "pushing", started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", recordId);

  const signal = AbortSignal.timeout(PUSH_TIMEOUT_MS);
  const outcome =
    record.object_type === "deals"
      ? await pushDeal(env, serviceSb, payload, signal)
      : await pushCompany(env, serviceSb, payload, signal);

  const patched = await patchResult(env, serviceSb, {
    idempotencyKey: record.idempotency_key,
    result: outcome.result,
    error: outcome.error,
    status: outcome.status,
    fixActions: outcome.fixActions,
    assocSkips: outcome.assocSkips,
  });
  if (!patched.ok) return { ok: false, error: patched.error };
  return { ok: true, status: patched.row.status };
}

/** Bulk replay records matching a status/object filter (inline; for the current backlog). */
export async function replayRecords(
  env: Env,
  serviceSb: SupabaseClient,
  opts: { status?: string; objectType?: string; limit?: number } = {},
): Promise<{ total: number; counts: Record<string, number> }> {
  let q = serviceSb
    .from("hubspot_sync_records")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 500);
  if (opts.status) q = q.eq("status", opts.status);
  if (opts.objectType) q = q.eq("object_type", opts.objectType);
  const { data, error } = await q;
  if (error) throw new Error(`replay query failed: ${error.message}`);
  const ids = ((data as { id: string }[] | null) ?? []).map((r) => r.id);

  const counts: Record<string, number> = {};
  for (const id of ids) {
    const r = await replayRecord(env, serviceSb, id);
    const key = r.ok ? r.status : "error";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { total: ids.length, counts };
}

export async function getRecordByKey(
  sb: SupabaseClient,
  idempotencyKey: string,
): Promise<HubspotSyncRecordRow | null> {
  const { data, error } = await sb
    .from("hubspot_sync_records")
    .select(RECORD_COLUMNS)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw new Error(`hubspot_sync_records lookup failed: ${error.message}`);
  return (data as HubspotSyncRecordRow | null) ?? null;
}

export async function getRecord(
  sb: SupabaseClient,
  id: string,
): Promise<HubspotSyncRecordRow | null> {
  const { data, error } = await sb
    .from("hubspot_sync_records")
    .select(RECORD_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`hubspot_sync_records lookup failed: ${error.message}`);
  return (data as HubspotSyncRecordRow | null) ?? null;
}

export async function listRecords(
  sb: SupabaseClient,
  opts: {
    objectType?: string;
    status?: string;
    q?: string;
    sinceDays?: number;
    hasProblems?: boolean;
    limit?: number;
  } = {},
): Promise<HubspotSyncRecordRow[]> {
  let query = sb
    .from("hubspot_sync_records")
    .select(RECORD_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.objectType) query = query.eq("object_type", opts.objectType);
  if (opts.status) query = query.eq("status", opts.status);
  if (opts.hasProblems) query = query.gt("problem_count", 0);
  if (opts.q) query = query.ilike("dedup_key", `%${opts.q}%`);
  if (opts.sinceDays) {
    const since = new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString();
    query = query.gte("created_at", since);
  }
  const { data, error } = await query;
  if (error) throw new Error(`hubspot_sync_records list failed: ${error.message}`);
  return (data as HubspotSyncRecordRow[] | null) ?? [];
}

export async function getFieldIssues(
  sb: SupabaseClient,
  recordId: string,
): Promise<FieldIssueRow[]> {
  const { data, error } = await sb
    .from("hubspot_sync_field_issues")
    .select("*")
    .eq("record_id", recordId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`hubspot_sync_field_issues list failed: ${error.message}`);
  return (data as FieldIssueRow[] | null) ?? [];
}

/** All problem fields across records, filterable (drives the Errors tab). */
export async function listFieldIssues(
  sb: SupabaseClient,
  opts: {
    objectType?: string;
    category?: string;
    property?: string;
    action?: string;
    limit?: number;
  } = {},
): Promise<(FieldIssueRow & { dedup_key: string | null })[]> {
  let query = sb
    .from("hubspot_sync_field_issues")
    .select("*, record:hubspot_sync_records(dedup_key)")
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 300);
  if (opts.objectType) query = query.eq("object_type", opts.objectType);
  if (opts.category) query = query.eq("category", opts.category);
  if (opts.property) query = query.eq("property", opts.property);
  if (opts.action) query = query.eq("action", opts.action);
  const { data, error } = await query;
  if (error) throw new Error(`hubspot_sync_field_issues list failed: ${error.message}`);
  return ((data as (FieldIssueRow & { record: { dedup_key: string | null } | null })[]) ?? []).map(
    (r) => ({ ...r, dedup_key: r.record?.dedup_key ?? null }),
  );
}

/** Fetch and parse the stored raw payload from R2 (for the detail drawer). */
export async function getRecordPayload(
  env: Env,
  sb: SupabaseClient,
  id: string,
): Promise<{ record: HubspotSyncRecordRow; payload: unknown } | null> {
  const record = await getRecord(sb, id);
  if (!record) return null;
  const obj = await env.ASSETS_BUCKET.get(record.r2_key);
  if (!obj) return { record, payload: null };
  const text = await obj.text();
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // keep raw text if it isn't valid JSON
  }
  return { record, payload };
}

export interface SyncSummary {
  topFields: { objectType: string; property: string; category: string; n: number }[];
  topValues: { objectType: string; property: string; rawValue: string | null; n: number }[];
  statusCounts: { objectType: string; status: string; n: number }[];
  dailyTrend: { day: string; n: number }[];
}

/** Server-aggregated dashboard summaries (the Summary tab). */
export async function getSummary(sb: SupabaseClient): Promise<SyncSummary> {
  const sinceDay = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [fields, values, statuses, daily] = await Promise.all([
    sb
      .from("hubspot_field_problem_counts")
      .select("object_type, property, category, n")
      .order("n", { ascending: false })
      .limit(20),
    sb
      .from("hubspot_value_problem_counts")
      .select("object_type, property, raw_value, n")
      .order("n", { ascending: false })
      .limit(20),
    sb.from("hubspot_record_status_counts").select("object_type, status, n"),
    sb
      .from("hubspot_problem_daily")
      .select("day, n")
      .gte("day", sinceDay)
      .order("day", { ascending: true }),
  ]);

  // Collapse the daily view (split by object_type) into a single per-day total.
  const dayTotals = new Map<string, number>();
  for (const r of (daily.data as { day: string; n: number }[] | null) ?? []) {
    dayTotals.set(r.day, (dayTotals.get(r.day) ?? 0) + Number(r.n));
  }

  return {
    topFields: ((fields.data as SyncSummary["topFields"] | null) ?? []).map((r) => ({
      objectType: (r as unknown as { object_type: string }).object_type,
      property: r.property,
      category: r.category,
      n: Number(r.n),
    })),
    topValues: ((values.data as unknown[] | null) ?? []).map((r) => {
      const x = r as { object_type: string; property: string; raw_value: string | null; n: number };
      return { objectType: x.object_type, property: x.property, rawValue: x.raw_value, n: Number(x.n) };
    }),
    statusCounts: ((statuses.data as unknown[] | null) ?? []).map((r) => {
      const x = r as { object_type: string; status: string; n: number };
      return { objectType: x.object_type, status: x.status, n: Number(x.n) };
    }),
    dailyTrend: [...dayTotals.entries()].map(([day, n]) => ({ day, n })),
  };
}
