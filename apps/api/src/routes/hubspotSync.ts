import { Hono } from "hono";
import type { HubspotObjectType } from "@wac/shared";
import type { AppBindings, AuthedUser } from "../auth.js";
import {
  SAP_SYNC_TOKEN_USER_ID,
  requireAuth,
  requireSapSyncAuth,
} from "../auth.js";
import { serviceSupabase } from "../supabase.js";
import {
  captureAndPush,
  captureRecord,
  getFieldIssues,
  getRecordPayload,
  getSummary,
  listFieldIssues,
  listRecords,
  patchResult,
  replayRecords,
  sha256Hex,
  type FieldIssueRow,
  type HubspotSyncRecordRow,
} from "../hubspotSync.js";
import { refreshHubspotOptions } from "../hubspotPush.js";

export const hubspotSyncRoutes = new Hono<AppBindings>();

/**
 * SAP -> HubSpot durable sync endpoints (Phase 1: capture + review dashboard).
 *
 *   POST /api/hubspot-sync/capture/:object  Lambda forwards a raw payload (token)
 *   POST /api/hubspot-sync/result           Lambda forwards its push outcome (token)
 *   GET  /api/hubspot-sync                   list records (internal/admin)
 *   GET  /api/hubspot-sync/issues            list problem fields (Errors tab)
 *   GET  /api/hubspot-sync/summary           dashboard aggregates (Summary tab)
 *   GET  /api/hubspot-sync/:id               one record + payload + issues
 */

const OBJECT_TYPES: HubspotObjectType[] = ["deals", "companies"];

function isInternalOrAdmin(user: AuthedUser): boolean {
  return (
    user.status === "active" && (user.role === "internal" || user.role === "admin")
  );
}

function toRecordResponse(row: HubspotSyncRecordRow) {
  return {
    id: row.id,
    objectType: row.object_type,
    status: row.status,
    dedupKey: row.dedup_key,
    deliveredBy: row.delivered_by,
    source: row.source,
    sapChangedAt: row.sap_changed_at,
    lambdaError: row.lambda_error,
    lambdaStatus: row.lambda_status,
    problemCount: row.problem_count,
    receiptCount: row.receipt_count,
    payloadBytes: row.payload_bytes,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function toIssueResponse(row: FieldIssueRow & { dedup_key?: string | null }) {
  return {
    id: row.id,
    recordId: row.record_id,
    objectType: row.object_type,
    property: row.property,
    rawValue: row.raw_value,
    category: row.category,
    action: row.action,
    mappedTo: row.mapped_to,
    reason: row.reason,
    dedupKey: row.dedup_key ?? null,
    createdAt: row.created_at,
  };
}

/**
 * Parse the request body into { payload, payloadText, idempotencyKey }. Accepts
 * either the envelope { idempotencyKey, payload } (the Lambda) or a bare payload
 * (manual testing — the key is computed from the stored bytes).
 */
async function readPayload(
  raw: string,
): Promise<
  | { ok: true; payload: Record<string, unknown>; payloadText: string; idempotencyKey: string }
  | { ok: false }
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  const envlp = parsed as { idempotencyKey?: unknown; payload?: unknown };
  if (envlp && typeof envlp === "object" && "payload" in envlp) {
    const payload = (envlp.payload ?? {}) as Record<string, unknown>;
    const payloadText = JSON.stringify(payload);
    const idempotencyKey =
      typeof envlp.idempotencyKey === "string" ? envlp.idempotencyKey : await sha256Hex(payloadText);
    return { ok: true, payload, payloadText, idempotencyKey };
  }
  return {
    ok: true,
    payload: parsed as Record<string, unknown>,
    payloadText: raw,
    idempotencyKey: await sha256Hex(raw),
  };
}

/** Capture a forwarded SAP payload (token path = the Lambda). No HubSpot push. */
hubspotSyncRoutes.post("/capture/:object", requireSapSyncAuth, async (c) => {
  const objectType = c.req.param("object") as HubspotObjectType;
  if (!OBJECT_TYPES.includes(objectType)) {
    return c.json({ error: "unknown object type" }, 404);
  }

  const raw = await c.req.text();
  if (!raw) return c.json({ error: "empty body" }, 400);
  const parsed = await readPayload(raw);
  if (!parsed.ok) return c.json({ error: "invalid JSON body" }, 400);
  const { payload, payloadText, idempotencyKey } = parsed;

  const user = c.get("user");
  const deliveredBy =
    user.id === SAP_SYNC_TOKEN_USER_ID ? "sap-lambda" : user.email;

  const res = await captureRecord(c.env, serviceSupabase(c.env), {
    objectType,
    idempotencyKey,
    payloadText,
    payload,
    deliveredBy,
  });
  if (!res.ok) return c.json({ error: res.error }, 500);

  return c.json(
    {
      recordId: res.row.id,
      status: res.row.status,
      isNew: res.isNew,
      problemCount: res.row.problem_count,
    },
    res.isNew ? 201 : 200,
  );
});

/** Patch a record with the Lambda's push outcome (token path). */
hubspotSyncRoutes.post("/result", requireSapSyncAuth, async (c) => {
  let body: {
    idempotencyKey?: string;
    result?: unknown;
    error?: string | null;
    status?: number | null;
    fixActions?: unknown;
    assocSkips?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.idempotencyKey) {
    return c.json({ error: "missing idempotencyKey" }, 400);
  }

  const res = await patchResult(c.env, serviceSupabase(c.env), {
    idempotencyKey: body.idempotencyKey,
    result: body.result,
    error: body.error ?? null,
    status: body.status ?? null,
    fixActions: Array.isArray(body.fixActions) ? body.fixActions : [],
    assocSkips: Array.isArray(body.assocSkips) ? body.assocSkips : [],
  });
  if (!res.ok) {
    return c.json({ error: res.error }, res.error === "not found" ? 404 : 500);
  }
  return c.json({ recordId: res.row.id, status: res.row.status });
});

/**
 * Capture AND push to HubSpot from the Worker (Phase 2 cutover target). The thin
 * proxy Lambdas POST the raw SAP payload here; the Worker does mapping + heal +
 * resolution + the HubSpot writes and records the outcome.
 */
hubspotSyncRoutes.post("/push/:object", requireSapSyncAuth, async (c) => {
  const objectType = c.req.param("object") as HubspotObjectType;
  if (!OBJECT_TYPES.includes(objectType)) {
    return c.json({ error: "unknown object type" }, 404);
  }

  const raw = await c.req.text();
  if (!raw) return c.json({ error: "empty body" }, 400);
  const parsed = await readPayload(raw);
  if (!parsed.ok) return c.json({ error: "invalid JSON body" }, 400);
  const { payload, payloadText, idempotencyKey } = parsed;

  const user = c.get("user");
  const deliveredBy = user.id === SAP_SYNC_TOKEN_USER_ID ? "sap-lambda" : user.email;

  const res = await captureAndPush(c.env, serviceSupabase(c.env), {
    objectType,
    idempotencyKey,
    payloadText,
    payload,
    deliveredBy,
  });
  if (!res.ok) return c.json({ error: res.error }, 500);
  return c.json({ recordId: res.recordId, status: res.status });
});

/** Bulk replay records (default: all `partial`) — re-push + self-heal in place. */
hubspotSyncRoutes.post("/replay", requireSapSyncAuth, async (c) => {
  const user = c.get("user");
  if (user.id !== SAP_SYNC_TOKEN_USER_ID && !isInternalOrAdmin(user)) {
    return c.json({ error: "internal access required" }, 403);
  }
  let body: { status?: string; objectType?: string; limit?: number } = {};
  try {
    body = await c.req.json();
  } catch {
    /* empty body → defaults */
  }
  const res = await replayRecords(c.env, serviceSupabase(c.env), {
    status: body.status ?? "partial",
    objectType: body.objectType,
    limit: body.limit,
  });
  return c.json(res);
});

/** Refresh the cached HubSpot enum option lists (also runs daily on cron). */
hubspotSyncRoutes.post("/refresh-options", requireSapSyncAuth, async (c) => {
  const user = c.get("user");
  if (user.id !== SAP_SYNC_TOKEN_USER_ID && !isInternalOrAdmin(user)) {
    return c.json({ error: "internal access required" }, 403);
  }
  await refreshHubspotOptions(c.env, serviceSupabase(c.env));
  return c.json({ ok: true });
});

/** List recent records (internal/admin). */
hubspotSyncRoutes.get("/", requireAuth, async (c) => {
  if (!isInternalOrAdmin(c.get("user"))) {
    return c.json({ error: "internal access required" }, 403);
  }
  const rows = await listRecords(serviceSupabase(c.env), {
    objectType: c.req.query("objectType"),
    status: c.req.query("status"),
    q: c.req.query("q"),
    sinceDays: c.req.query("sinceDays") ? Number(c.req.query("sinceDays")) : undefined,
    hasProblems: c.req.query("hasProblems") === "1",
  });
  return c.json({ records: rows.map(toRecordResponse) });
});

/** List problem fields across records (Errors tab; internal/admin). */
hubspotSyncRoutes.get("/issues", requireAuth, async (c) => {
  if (!isInternalOrAdmin(c.get("user"))) {
    return c.json({ error: "internal access required" }, 403);
  }
  const rows = await listFieldIssues(serviceSupabase(c.env), {
    objectType: c.req.query("objectType"),
    category: c.req.query("category"),
    property: c.req.query("property"),
    action: c.req.query("action"),
  });
  return c.json({ issues: rows.map(toIssueResponse) });
});

/** Dashboard summary aggregates (Summary tab; internal/admin). */
hubspotSyncRoutes.get("/summary", requireAuth, async (c) => {
  if (!isInternalOrAdmin(c.get("user"))) {
    return c.json({ error: "internal access required" }, 403);
  }
  const summary = await getSummary(serviceSupabase(c.env));
  return c.json(summary);
});

/** One record with its stored payload + field issues (internal/admin). */
hubspotSyncRoutes.get("/:id", requireAuth, async (c) => {
  if (!isInternalOrAdmin(c.get("user"))) {
    return c.json({ error: "internal access required" }, 403);
  }
  const sb = serviceSupabase(c.env);
  const res = await getRecordPayload(c.env, sb, c.req.param("id"));
  if (!res) return c.json({ error: "not found" }, 404);
  const issues = await getFieldIssues(sb, res.record.id);
  return c.json({
    record: toRecordResponse(res.record),
    payload: res.payload,
    issues: issues.map(toIssueResponse),
  });
});
