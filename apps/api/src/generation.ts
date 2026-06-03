import type { SupabaseClient } from "@supabase/supabase-js";
import type { GenerationJobStatus, GenerationTool } from "@wac/shared";
import type { Env } from "./env.js";

/**
 * Generation job domain layer (Phase 2b).
 *
 * The API inserts a `queued` row under the caller's JWT (RLS) and enqueues a
 * Cloudflare Queue message. The queue consumer (index.ts) hands the message to
 * the generation Container, which performs the running -> succeeded/failed
 * transitions and asset creation. `updateJobStatus` here is the service-role
 * path used by the consumer's failure finalizer.
 */

/** The Cloudflare Queue message body. Keep in sync with apps/generator. */
export interface GenerationMessage {
  jobId: string;
  ownerId: string;
  tool: GenerationTool;
  name: string;
  params: Record<string, unknown>;
}

export interface GenerationJobRow {
  id: string;
  owner_id: string;
  asset_id: string | null;
  tool: GenerationTool;
  status: GenerationJobStatus;
  params_json: Record<string, unknown>;
  result_json: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const JOB_COLUMNS =
  "id, owner_id, asset_id, tool, status, params_json, result_json, error, attempts, created_at, updated_at, started_at, finished_at";

/**
 * Insert a queued job (user-scoped client → RLS enforces owner_id) and enqueue
 * the work. If the enqueue fails after the row is committed, the job is marked
 * failed so it never sticks in `queued`.
 */
export async function createGenerationJob(
  env: Env,
  sb: SupabaseClient,
  args: {
    ownerId: string;
    tool: GenerationTool;
    name: string;
    params: Record<string, unknown>;
  },
): Promise<{ ok: true; row: GenerationJobRow } | { ok: false; error: string }> {
  const { data, error } = await sb
    .from("generation_jobs")
    .insert({
      owner_id: args.ownerId,
      tool: args.tool,
      params_json: args.params,
    })
    .select(JOB_COLUMNS)
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "insert failed" };
  }
  const row = data as GenerationJobRow;

  const message: GenerationMessage = {
    jobId: row.id,
    ownerId: args.ownerId,
    tool: args.tool,
    name: args.name,
    params: args.params,
  };
  try {
    await env.GENERATION_QUEUE.send(message);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb
      .from("generation_jobs")
      .update({
        status: "failed",
        error: `enqueue failed: ${msg}`,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    return { ok: false, error: `enqueue failed: ${msg}` };
  }

  return { ok: true, row };
}

export async function getGenerationJob(
  sb: SupabaseClient,
  id: string,
): Promise<GenerationJobRow | null> {
  const { data, error } = await sb
    .from("generation_jobs")
    .select(JOB_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`generation_jobs lookup failed: ${error.message}`);
  return (data as GenerationJobRow | null) ?? null;
}

export async function listGenerationJobs(
  sb: SupabaseClient,
  limit = 50,
): Promise<GenerationJobRow[]> {
  const { data, error } = await sb
    .from("generation_jobs")
    .select(JOB_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`generation_jobs list failed: ${error.message}`);
  return (data as GenerationJobRow[] | null) ?? [];
}

/**
 * Service-role status patch used by the queue consumer's failure finalizer.
 * The Container performs the running/succeeded transitions itself.
 */
export async function updateJobStatus(
  serviceSb: SupabaseClient,
  id: string,
  patch: Partial<
    Pick<
      GenerationJobRow,
      "status" | "error" | "attempts" | "asset_id" | "result_json"
    >
  > & { finished_at?: string },
): Promise<void> {
  const { error } = await serviceSb
    .from("generation_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    throw new Error(`generation_jobs update failed: ${error.message}`);
  }
}
