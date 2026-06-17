import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env.js";

/**
 * Marketing data ingestion domain layer (Phase 1).
 *
 * The ingest endpoint inserts a `received` row (service role), stores the raw
 * file in the R2 inbox, and enqueues a wac-ingest message; the queue consumer
 * (ingestQueue.ts) flips the row to processing -> succeeded/failed. Mirrors the
 * generation.ts job layer, including the "never stick in an early state" guard:
 * if the R2 put or the enqueue fails after the row is committed, the row is
 * marked `failed` so it never sits forever in `received`.
 *
 * Reads/writes here all use the SERVICE-ROLE client: data_ingestions has no
 * insert/update policy (only the service role writes), and the consumer has no
 * user JWT. Route-level reads still gate on internal/admin before calling in.
 */

export type IngestionStatus =
  | "received"
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "skipped";

/** The Cloudflare Queue message body. Kept small — carries ids + the R2 key,
 *  never the file bytes (so reprocess is just re-enqueueing the same key). */
export interface IngestMessage {
  ingestionId: string;
  source: string;
  variant?: string;
  r2Key: string;
}

export interface IngestionRow {
  id: string;
  source: string;
  variant: string | null;
  status: IngestionStatus;
  r2_key: string;
  original_name: string | null;
  content_type: string | null;
  byte_size: number | null;
  delivered_by: string | null;
  row_count: number | null;
  inserted_count: number | null;
  updated_count: number | null;
  closed_count: number | null;
  error_count: number | null;
  errors_json: unknown;
  stats_json: unknown;
  error: string | null;
  /** Upstream change marker for cron-pulled sources (driveItem eTag / mail cursor). */
  source_marker: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const INGESTION_COLUMNS =
  "id, source, variant, status, r2_key, original_name, content_type, byte_size, delivered_by, row_count, inserted_count, updated_count, closed_count, error_count, errors_json, stats_json, error, source_marker, attempts, created_at, updated_at, started_at, finished_at";

/** Patch shape for the consumer / reprocess paths (service role). */
export type IngestionPatch = Partial<
  Pick<
    IngestionRow,
    | "status"
    | "row_count"
    | "inserted_count"
    | "updated_count"
    | "closed_count"
    | "error_count"
    | "errors_json"
    | "stats_json"
    | "error"
    | "attempts"
  >
> & { started_at?: string | null; finished_at?: string | null };

/** Two-digit zero pad for the date-partitioned R2 prefix. */
function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Strip a filename down to a safe, bounded slug for the R2 key leaf. */
function safeName(name: string | undefined, ext: string): string {
  const base = (name ?? "file")
    .replace(/\.[^.]+$/, "") // drop any extension; we append our own
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const stem = base || "file";
  return ext ? `${stem}.${ext}` : stem;
}

/**
 * Build the immutable, source- and time-partitioned inbox key:
 *   ingest/{source}/{yyyy}/{mm}/{dd}/{id}__{name}.{ext}
 * The id leads the leaf so the key is globally unique even if two files share a
 * name, and is reverse-derivable from the audit row (which stores the full key).
 */
export function buildIngestKey(args: {
  source: string;
  id: string;
  originalName?: string;
  ext: string;
  now: Date;
}): string {
  const { source, id, originalName, ext, now } = args;
  const yyyy = now.getUTCFullYear();
  const mm = pad2(now.getUTCMonth() + 1);
  const dd = pad2(now.getUTCDate());
  return `ingest/${source}/${yyyy}/${mm}/${dd}/${id}__${safeName(originalName, ext)}`;
}

/**
 * Insert a `received` row, store the file in R2, and enqueue processing. On a
 * post-insert failure (R2 put or enqueue) the row is finalized as `failed`.
 */
export async function createIngestion(
  env: Env,
  serviceSb: SupabaseClient,
  args: {
    source: string;
    variant?: string;
    originalName?: string;
    contentType: string;
    ext: string;
    bytes: ArrayBuffer;
    deliveredBy: string;
    /** Upstream change marker (cron-pulled sources) so reruns can dedupe. */
    sourceMarker?: string;
  },
): Promise<{ ok: true; row: IngestionRow } | { ok: false; error: string }> {
  const id = crypto.randomUUID();
  const r2Key = buildIngestKey({
    source: args.source,
    id,
    originalName: args.originalName,
    ext: args.ext,
    now: new Date(),
  });

  const { data, error } = await serviceSb
    .from("data_ingestions")
    .insert({
      id,
      source: args.source,
      variant: args.variant ?? null,
      status: "received",
      r2_key: r2Key,
      original_name: args.originalName ?? null,
      content_type: args.contentType,
      byte_size: args.bytes.byteLength,
      delivered_by: args.deliveredBy,
      source_marker: args.sourceMarker ?? null,
    })
    .select(INGESTION_COLUMNS)
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "insert failed" };
  }
  const row = data as IngestionRow;

  try {
    await env.ASSETS_BUCKET.put(r2Key, args.bytes, {
      httpMetadata: { contentType: args.contentType },
    });
    const message: IngestMessage = {
      ingestionId: id,
      source: args.source,
      variant: args.variant,
      r2Key,
    };
    await env.INGEST_QUEUE.send(message);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateIngestionStatus(serviceSb, id, {
      status: "failed",
      error: `ingest setup failed: ${msg}`,
      finished_at: new Date().toISOString(),
    });
    return { ok: false, error: `ingest setup failed: ${msg}` };
  }

  await updateIngestionStatus(serviceSb, id, { status: "queued" });
  row.status = "queued";
  return { ok: true, row };
}

export async function getIngestion(
  sb: SupabaseClient,
  id: string,
): Promise<IngestionRow | null> {
  const { data, error } = await sb
    .from("data_ingestions")
    .select(INGESTION_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`data_ingestions lookup failed: ${error.message}`);
  return (data as IngestionRow | null) ?? null;
}

/**
 * The most-recent ingestion's `source_marker` for a source — the cron pullers'
 * cursor. Territory compares it to the current driveItem eTag (skip if equal);
 * Open Orders uses it as the `receivedDateTime gt` lower bound. Any-status (not
 * just succeeded) so a stored file isn't pulled twice even if parsing failed.
 */
export async function getLatestIngestionMarker(
  serviceSb: SupabaseClient,
  source: string,
): Promise<string | null> {
  const { data, error } = await serviceSb
    .from("data_ingestions")
    .select("source_marker")
    .eq("source", source)
    .not("source_marker", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`data_ingestions marker lookup failed: ${error.message}`);
  return (data as { source_marker: string | null } | null)?.source_marker ?? null;
}

export async function listIngestions(
  sb: SupabaseClient,
  opts: { limit?: number; source?: string } = {},
): Promise<IngestionRow[]> {
  let query = sb
    .from("data_ingestions")
    .select(INGESTION_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 100);
  if (opts.source) query = query.eq("source", opts.source);
  const { data, error } = await query;
  if (error) throw new Error(`data_ingestions list failed: ${error.message}`);
  return (data as IngestionRow[] | null) ?? [];
}

/** Service-role status/result patch used by the consumer and reprocess paths. */
export async function updateIngestionStatus(
  serviceSb: SupabaseClient,
  id: string,
  patch: IngestionPatch,
): Promise<void> {
  const { error } = await serviceSb
    .from("data_ingestions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    throw new Error(`data_ingestions update failed: ${error.message}`);
  }
}

/**
 * Re-enqueue an existing ingestion from its stored R2 key. Idempotent: the
 * consumer re-reads the same original and converges the staging table to the
 * same state. Resets the row to `queued` and clears the prior error.
 */
export async function reprocessIngestion(
  env: Env,
  serviceSb: SupabaseClient,
  id: string,
): Promise<{ ok: true; row: IngestionRow } | { ok: false; error: string }> {
  const row = await getIngestion(serviceSb, id);
  if (!row) return { ok: false, error: "not found" };

  await updateIngestionStatus(serviceSb, id, {
    status: "queued",
    error: null,
    started_at: null,
    finished_at: null,
  });

  const message: IngestMessage = {
    ingestionId: row.id,
    source: row.source,
    variant: row.variant ?? undefined,
    r2Key: row.r2_key,
  };
  try {
    await env.INGEST_QUEUE.send(message);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateIngestionStatus(serviceSb, id, {
      status: "failed",
      error: `re-enqueue failed: ${msg}`,
      finished_at: new Date().toISOString(),
    });
    return { ok: false, error: `re-enqueue failed: ${msg}` };
  }

  return { ok: true, row: { ...row, status: "queued", error: null } };
}
