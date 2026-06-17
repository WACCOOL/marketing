import { api } from "./api.js";

/**
 * Client helpers for the marketing data ingestion pipeline (Phase 1). The
 * Data Ingestions page lists recent files across all sources and can re-run a
 * stored file. Source labels come from the shared registry (@wac/shared),
 * so this module deals only with the per-ingestion rows.
 */

export type IngestionStatus =
  | "received"
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "skipped";

export interface IngestionRowError {
  rowIndex: number;
  messages: string[];
}

export interface IngestionResponse {
  id: string;
  source: string;
  sourceLabel: string;
  variant: string | null;
  variantLabel: string | null;
  status: IngestionStatus;
  originalName: string | null;
  contentType: string | null;
  byteSize: number | null;
  deliveredBy: string | null;
  rowCount: number | null;
  insertedCount: number | null;
  updatedCount: number | null;
  closedCount: number | null;
  errorCount: number | null;
  errors: IngestionRowError[] | null;
  stats: Record<string, number> | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Statuses still being worked — used to drive auto-refresh polling. */
export const ACTIVE_INGESTION_STATUSES: IngestionStatus[] = [
  "received",
  "queued",
  "processing",
];

export function isActiveIngestion(status: IngestionStatus): boolean {
  return ACTIVE_INGESTION_STATUSES.includes(status);
}

/** List recent ingestions across all sources (newest first). */
export async function listIngestions(source?: string): Promise<IngestionResponse[]> {
  const qs = source ? `?source=${encodeURIComponent(source)}` : "";
  const res = await api<{ ingestions: IngestionResponse[] }>(`/api/ingest${qs}`);
  return res.ingestions;
}

export async function getIngestion(id: string): Promise<IngestionResponse> {
  return api<IngestionResponse>(`/api/ingest/${id}`);
}

/** Re-enqueue an ingestion from its stored R2 key. */
export async function reprocessIngestion(id: string): Promise<IngestionResponse> {
  return api<IngestionResponse>(`/api/ingest/${id}/reprocess`, { method: "POST" });
}
