import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type HubspotObjectType,
  dedupKeyFor,
  detectUnmappedFields,
  norm,
  sapChangedAtFor,
  smartMatchToAllowedOptions,
} from "@wac/shared";
import type { Env } from "./env.js";
import { PATHS, hs, pushDeal, pushCompany } from "./hubspotPush.js";
import { loadOptions, type OptionDef } from "./hubspotHeal.js";

/** Wall-clock ceiling for an inline Worker push (deal + line items + assocs + retries). */
const PUSH_TIMEOUT_MS = 50_000;

/** Issue actions that keep a record out of `succeeded` (a value that didn't land). */
const HARD_ISSUE_ACTIONS = ["dropped", "invalid", "held", "assoc_missing"];

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
 * Parse a forwarded body into { payload, payloadText, idempotencyKey }. Accepts
 * either the envelope { idempotencyKey, payload } (the Lambda) or a bare SAP
 * payload (the key is then the SHA-256 of the stored bytes). Returns null on
 * invalid JSON. Shared by the capture/push routes and the raw-backup replay so
 * a re-pushed payload lands on the SAME idempotency key as the live one.
 */
export async function parseForwardedPayload(
  raw: string,
): Promise<{ payload: Record<string, unknown>; payloadText: string; idempotencyKey: string } | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const envlp = parsed as { idempotencyKey?: unknown; payload?: unknown };
  if (envlp && typeof envlp === "object" && "payload" in envlp) {
    const payload = (envlp.payload ?? {}) as Record<string, unknown>;
    const payloadText = JSON.stringify(payload);
    const idempotencyKey =
      typeof envlp.idempotencyKey === "string" ? envlp.idempotencyKey : await sha256Hex(payloadText);
    return { payload, payloadText, idempotencyKey };
  }
  return {
    payload: parsed as Record<string, unknown>,
    payloadText: raw,
    idempotencyKey: await sha256Hex(raw),
  };
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
  const hasHardIssue = issues.some((i) => HARD_ISSUE_ACTIONS.includes(i.action ?? ""));
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

/**
 * Per-object-type single-property upsert target: the HubSpot batch-upsert path and
 * the idProperty whose value is the record's `dedup_key` (account_number_ for
 * companies, sap_quote_number for deals).
 */
const REPUSH_TARGET: Record<string, { path: string; idProperty: string }> = {
  companies: { path: PATHS.companyUpsert, idProperty: "account_number_" },
  deals: { path: PATHS.dealUpsert, idProperty: "sap_quote_number" },
};

/** Exact value/label match (heal.norm), else conservative smart/prefix match; canonical option value or null. */
export function matchOption(raw: string | null, options: OptionDef[]): string | null {
  if (raw == null || raw === "") return null;
  const exact = options.find((o) => norm(o.value) === norm(raw) || norm(o.label) === norm(raw));
  if (exact) return exact.value;
  return smartMatchToAllowedOptions(raw, options.map((o) => o.value));
}

/**
 * After dropped-issue rows are removed, recompute a record's `problem_count` and
 * status. Only a `partial` record can flip to `succeeded` (no remaining hard
 * issue) — a `failed` record keeps its status, since a single-property fix doesn't
 * clear a record-level push failure.
 */
async function recomputeRecordStatus(sb: SupabaseClient, recordId: string): Promise<void> {
  const [remaining, record] = await Promise.all([
    getFieldIssues(sb, recordId),
    getRecord(sb, recordId),
  ]);
  const patch: Record<string, unknown> = {
    problem_count: remaining.length,
    updated_at: new Date().toISOString(),
  };
  if (record?.status === "partial") {
    const hasHardIssue = remaining.some((i) => HARD_ISSUE_ACTIONS.includes(i.action ?? ""));
    patch.status = hasHardIssue ? "partial" : "succeeded";
  }
  await sb.from("hubspot_sync_records").update(patch).eq("id", recordId);
}

/**
 * Re-push ONLY a single dropped enum property (e.g. `program_level`) for the
 * records where it was dropped — used after the matching HubSpot dropdown options
 * are added and the option cache is refreshed. Unlike `replayRecords`, this does
 * NOT re-send the whole payload (no ISR/association re-resolution): it re-validates
 * each issue's stored `raw_value` against the freshly-cached options and, when it
 * now matches, sends a minimal upsert of just that property. Resolved issue rows
 * are removed and the parent record's status recomputed.
 */
export async function repushDroppedProperty(
  env: Env,
  serviceSb: SupabaseClient,
  opts: { objectType: string; property: string; limit?: number },
): Promise<{
  total: number;
  pushed: number;
  stillUnmatched: number;
  errors: number;
  optionsCached: boolean;
}> {
  const target = REPUSH_TARGET[opts.objectType];
  if (!target) throw new Error(`unsupported object type: ${opts.objectType}`);
  const token = env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN not configured");

  // The property must be a cached enum (run refresh-options first if not).
  const optionsByProp = await loadOptions(serviceSb, opts.objectType);
  const options = optionsByProp.get(opts.property);
  if (!options || options.length === 0) {
    return { total: 0, pushed: 0, stillUnmatched: 0, errors: 0, optionsCached: false };
  }

  type IssueRow = {
    id: string;
    raw_value: string | null;
    record_id: string;
    record: { dedup_key: string | null; status: string } | null;
  };
  const { data, error } = await serviceSb
    .from("hubspot_sync_field_issues")
    .select("id, raw_value, record_id, record:hubspot_sync_records(dedup_key, status)")
    .eq("object_type", opts.objectType)
    .eq("property", opts.property)
    .eq("action", "dropped")
    .limit(opts.limit ?? 500);
  if (error) throw new Error(`dropped-issue query failed: ${error.message}`);
  // The to-one embed is returned as an object at runtime, but typegen widens it to
  // an array — cast through unknown (same shape the detail/list helpers rely on).
  const rows = (data as unknown as IssueRow[] | null) ?? [];

  // One push per record: take the first matchable dropped value for the property.
  const byRecord = new Map<string, { dedupKey: string; canonical: string; issueIds: string[] }>();
  let stillUnmatched = 0;
  for (const r of rows) {
    const dedupKey = r.record?.dedup_key ?? null;
    const canonical = dedupKey ? matchOption(r.raw_value, options) : null;
    if (!dedupKey || canonical === null) {
      stillUnmatched++;
      continue;
    }
    const existing = byRecord.get(r.record_id);
    if (existing) existing.issueIds.push(r.id);
    else byRecord.set(r.record_id, { dedupKey, canonical, issueIds: [r.id] });
  }

  const signal = AbortSignal.timeout(PUSH_TIMEOUT_MS);
  const resolvedIssueIds: string[] = [];
  const affectedRecordIds: string[] = [];
  let pushed = 0;
  let errors = 0;
  for (const [recordId, info] of byRecord) {
    const res = await hs(
      token,
      "POST",
      target.path,
      {
        inputs: [
          { idProperty: target.idProperty, id: info.dedupKey, properties: { [opts.property]: info.canonical } },
        ],
      },
      signal,
    );
    if (res.ok) {
      pushed++;
      resolvedIssueIds.push(...info.issueIds);
      affectedRecordIds.push(recordId);
    } else {
      errors++;
    }
  }

  if (resolvedIssueIds.length) {
    const { error: delErr } = await serviceSb
      .from("hubspot_sync_field_issues")
      .delete()
      .in("id", resolvedIssueIds);
    if (delErr) throw new Error(`clear resolved issues failed: ${delErr.message}`);
    for (const recordId of affectedRecordIds) await recomputeRecordStatus(serviceSb, recordId);
  }

  return { total: rows.length, pushed, stillUnmatched, errors, optionsCached: true };
}

/**
 * Isolated R2 prefix for the SAP Lambda's independent raw backup. The thin-proxy
 * Lambdas write the raw payload here BEFORE forwarding to /push, so the copy
 * survives even when the Worker route is unavailable (the 2026-06-23 incident:
 * a stale `main` deploy wiped /push, and the only capture lived ON the Worker).
 * Kept separate from the Worker's own `hubspot-sync/` capture prefix.
 *   raw-sap/{object}/{yyyy}/{mm}/{dd}/{idempotencyKey}.json
 */
export const RAW_INBOX_PREFIX = "raw-sap";

/** UTC day-partition prefixes spanning [from, to] (inclusive) — narrows R2 list scans. */
function rawDayPrefixes(objectType: string, from: Date, to: Date): string[] {
  const prefixes: string[] = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (cur.getTime() <= end) {
    prefixes.push(
      `${RAW_INBOX_PREFIX}/${objectType}/${cur.getUTCFullYear()}/${pad2(cur.getUTCMonth() + 1)}/${pad2(cur.getUTCDate())}/`,
    );
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return prefixes;
}

/**
 * Replay the Lambda's raw R2 backup (`raw-sap/` inbox) over a time window through
 * captureAndPush. The push is idempotent (HubSpot upsert, deduped by
 * idempotency_key), so replaying a whole window is safe even for events that
 * already succeeded — this is the recovery path for any gap where the Worker
 * /push route was unavailable. Filters by R2 `uploaded` time; when a `from` is
 * given the scan is narrowed to that window's UTC day-partitions.
 */
export async function replayRawRange(
  env: Env,
  serviceSb: SupabaseClient,
  opts: { objectType?: HubspotObjectType; from?: Date; to?: Date; limit?: number },
): Promise<{
  scanned: number;
  replayed: number;
  skippedOutOfRange: number;
  errors: number;
  counts: Record<string, number>;
}> {
  const objects: HubspotObjectType[] = opts.objectType ? [opts.objectType] : ["deals", "companies"];
  const limit = opts.limit ?? 500;
  const counts: Record<string, number> = {};
  let scanned = 0;
  let replayed = 0;
  let skippedOutOfRange = 0;
  let errors = 0;
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  for (const obj of objects) {
    const scanPrefixes = opts.from
      ? rawDayPrefixes(obj, opts.from, opts.to ?? new Date())
      : [`${RAW_INBOX_PREFIX}/${obj}/`];
    for (const prefix of scanPrefixes) {
      let cursor: string | undefined;
      do {
        const listed = await env.ASSETS_BUCKET.list({ prefix, cursor, limit: 1000 });
        cursor = listed.truncated ? listed.cursor : undefined;
        for (const o of listed.objects) {
          if (opts.from && o.uploaded < opts.from) {
            skippedOutOfRange++;
            continue;
          }
          if (opts.to && o.uploaded > opts.to) {
            skippedOutOfRange++;
            continue;
          }
          if (replayed >= limit) {
            return { scanned, replayed, skippedOutOfRange, errors, counts };
          }
          scanned++;
          const body = await env.ASSETS_BUCKET.get(o.key);
          const parsed = body ? await parseForwardedPayload(await body.text()) : null;
          if (!parsed) {
            errors++;
            bump("error");
            continue;
          }
          const res = await captureAndPush(env, serviceSb, {
            objectType: obj,
            idempotencyKey: parsed.idempotencyKey,
            payloadText: parsed.payloadText,
            payload: parsed.payload,
            deliveredBy: "replay-raw",
            source: "replay-raw",
          });
          if (res.ok) {
            replayed++;
            bump(res.status);
          } else {
            errors++;
            bump("error");
          }
        }
      } while (cursor);
    }
  }
  return { scanned, replayed, skippedOutOfRange, errors, counts };
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
