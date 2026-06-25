import { api } from "./api.js";

/**
 * Client helpers for the SAP -> HubSpot sync review dashboard (Phase 1). Records
 * are captured copies of every payload the SAP Lambdas forward; field issues are
 * the per-field problems (dropped/normalized dropdowns, unmapped fields,
 * association skips) that power the Errors + Summary tabs.
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

export interface SyncRecord {
  id: string;
  objectType: string;
  status: HubspotSyncStatus;
  dedupKey: string | null;
  deliveredBy: string | null;
  source: string;
  sapChangedAt: string | null;
  lambdaError: string | null;
  lambdaStatus: number | null;
  problemCount: number;
  receiptCount: number;
  payloadBytes: number | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface FieldIssue {
  id: string;
  recordId: string;
  objectType: string;
  property: string;
  rawValue: string | null;
  category: string;
  action: string | null;
  mappedTo: string | null;
  reason: string | null;
  dedupKey: string | null;
  createdAt: string;
}

export interface RecordDetail {
  record: SyncRecord;
  payload: unknown;
  issues: FieldIssue[];
}

export interface SyncSummary {
  topFields: { objectType: string; property: string; category: string; n: number }[];
  topValues: { objectType: string; property: string; rawValue: string | null; n: number }[];
  statusCounts: { objectType: string; status: string; n: number }[];
  dailyTrend: { day: string; n: number }[];
}

export interface RecordFilters {
  objectType?: string;
  status?: string;
  q?: string;
  sinceDays?: number;
  hasProblems?: boolean;
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export async function listSyncRecords(filters: RecordFilters = {}): Promise<SyncRecord[]> {
  const res = await api<{ records: SyncRecord[] }>(
    `/api/hubspot-sync${qs({
      objectType: filters.objectType,
      status: filters.status,
      q: filters.q,
      sinceDays: filters.sinceDays,
      hasProblems: filters.hasProblems ? 1 : undefined,
    })}`,
  );
  return res.records;
}

export async function getSyncRecord(id: string): Promise<RecordDetail> {
  return api<RecordDetail>(`/api/hubspot-sync/${id}`);
}

export async function listSyncIssues(filters: {
  objectType?: string;
  category?: string;
  property?: string;
  action?: string;
} = {}): Promise<FieldIssue[]> {
  const res = await api<{ issues: FieldIssue[] }>(
    `/api/hubspot-sync/issues${qs({
      objectType: filters.objectType,
      category: filters.category,
      property: filters.property,
      action: filters.action,
    })}`,
  );
  return res.issues;
}

export async function getSyncSummary(): Promise<SyncSummary> {
  return api<SyncSummary>(`/api/hubspot-sync/summary`);
}

/** Re-pull HubSpot's enum dropdown options into the cache (also runs daily on cron). */
export async function refreshSyncOptions(): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/hubspot-sync/refresh-options`, { method: "POST" });
}

export interface RepushResult {
  total: number;
  pushed: number;
  stillUnmatched: number;
  errors: number;
  optionsCached: boolean;
}

/**
 * Re-push only a single dropped enum property (e.g. program_level) for the records
 * where it was dropped — after adding the options in HubSpot and refreshing the
 * cache. Touches just that one field, not the whole payload.
 */
export async function repushDroppedProperty(args: {
  objectType: string;
  property: string;
  limit?: number;
}): Promise<RepushResult> {
  return api<RepushResult>(`/api/hubspot-sync/repush-property`, {
    method: "POST",
    body: JSON.stringify(args),
  });
}

/** Statuses still in flight — drive auto-refresh polling. */
export function isActiveSync(status: HubspotSyncStatus): boolean {
  return status === "captured" || status === "received" || status === "pushing";
}
