import type { GenerationJobStatus, GenerationTool } from "@wac/shared";
import { api } from "./api.js";

/**
 * Client helpers for the async generation pipeline (Phase 2b). `createJob`
 * enqueues work; `pollJob` polls the status endpoint until the job reaches a
 * terminal state. The full Application Image UI arrives in 2c — this is the
 * reusable plumbing it will build on.
 */

export interface JobResponse {
  jobId: string;
  tool: GenerationTool;
  status: GenerationJobStatus;
  assetId: string | null;
  error: string | null;
  result: { files?: { format: string; key: string; bytes: number }[] } | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

const TERMINAL: GenerationJobStatus[] = ["succeeded", "failed"];

export async function createJob(
  tool: GenerationTool,
  name: string,
  params: Record<string, unknown> = {},
  tags: string[] = [],
): Promise<{ jobId: string; status: GenerationJobStatus }> {
  return api("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ tool, name, params, tags }),
  });
}

export async function getJob(jobId: string): Promise<JobResponse> {
  return api(`/api/jobs/${jobId}`);
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onUpdate?: (job: JobResponse) => void;
  signal?: AbortSignal;
}

/**
 * Poll a job until it succeeds or fails (or the timeout elapses). Resolves with
 * the terminal job; rejects on timeout or abort.
 */
export async function pollJob(
  jobId: string,
  opts: PollOptions = {},
): Promise<JobResponse> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (opts.signal?.aborted) throw new Error("polling aborted");

    const job = await getJob(jobId);
    opts.onUpdate?.(job);
    if (TERMINAL.includes(job.status)) return job;

    if (Date.now() + intervalMs >= deadline) {
      throw new Error(`job ${jobId} did not finish within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
