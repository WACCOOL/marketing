import { Hono } from "hono";
import { getSource, getVariant, type SourceDescriptor } from "@wac/shared";
import type { AppBindings, AuthedUser } from "../auth.js";
import {
  INGEST_TOKEN_USER_ID,
  requireAuth,
  requireIngestAuth,
} from "../auth.js";
import { serviceSupabase } from "../supabase.js";
import {
  createIngestion,
  getIngestion,
  listIngestions,
  reprocessIngestion,
  type IngestionRow,
} from "../ingest.js";

export const ingestRoutes = new Hono<AppBindings>();

/**
 * Marketing data ingestion endpoints (Phase 1).
 *
 *   POST /api/ingest/:source        receive a file (Power Automate token OR a
 *                                   GUI upload) -> R2 inbox + audit row + queue
 *   GET  /api/ingest                list recent ingestions (internal/admin)
 *   GET  /api/ingest/:id            one ingestion (internal/admin)
 *   POST /api/ingest/:id/reprocess  re-enqueue from the stored R2 key
 *
 * The registry (packages/shared/src/ingest/registry.ts) is the single source of
 * truth for which sources exist, their accepted file types, and size caps.
 */

/** Resolve the stored extension from the request content-type for a source. */
function resolveContentType(
  source: SourceDescriptor,
  rawContentType: string,
): { contentType: string; ext: string } {
  const ct = rawContentType.split(";")[0]!.trim().toLowerCase();
  if (source.acceptedContentTypes.includes(ct)) {
    return { contentType: ct, ext: source.defaultExt };
  }
  // Power Automate / generic senders often post application/octet-stream (or
  // nothing). Accept those and stamp the source's default content-type/ext so
  // the stored object is still typed correctly.
  if (ct === "" || ct === "application/octet-stream") {
    return {
      contentType: source.acceptedContentTypes[0] ?? "application/octet-stream",
      ext: source.defaultExt,
    };
  }
  return { contentType: ct, ext: "" }; // signals "unsupported"
}

/** Internal/admin guard for the read/reprocess endpoints. */
function isInternalOrAdmin(user: AuthedUser): boolean {
  return (
    user.status === "active" && (user.role === "internal" || user.role === "admin")
  );
}

/** Shape an ingestion row for the client (camelCase + the source label). */
function toIngestionResponse(row: IngestionRow) {
  const source = getSource(row.source);
  const variantLabel = source
    ? getVariant(source, row.variant ?? undefined)?.label ?? row.variant
    : row.variant;
  return {
    id: row.id,
    source: row.source,
    sourceLabel: source?.label ?? row.source,
    variant: row.variant,
    variantLabel,
    status: row.status,
    originalName: row.original_name,
    contentType: row.content_type,
    byteSize: row.byte_size,
    deliveredBy: row.delivered_by,
    rowCount: row.row_count,
    insertedCount: row.inserted_count,
    updatedCount: row.updated_count,
    closedCount: row.closed_count,
    errorCount: row.error_count,
    errors: row.errors_json ?? null,
    stats: row.stats_json ?? null,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Receive a data file. Accepts the Power Automate shared token OR a Supabase
 * session (requireIngestAuth); the body is the raw bytes, like uploads.ts.
 */
ingestRoutes.post("/:source", requireIngestAuth, async (c) => {
  const source = getSource(c.req.param("source"));
  if (!source || !source.ingestable) {
    return c.json({ error: "unknown source" }, 404);
  }

  const user = c.get("user");
  const isTokenCaller = user.id === INGEST_TOKEN_USER_ID;

  // Per-source authorization. Pricing is a manual, ADMIN-ONLY GUI upload — the
  // shared token (synthetic internal user) is intentionally rejected there.
  if (source.authMode === "manual") {
    if (user.role !== "admin") {
      return c.json({ error: "admin access required" }, 403);
    }
  } else if (!isInternalOrAdmin(user)) {
    return c.json({ error: "internal access required" }, 403);
  }

  // Variant handling (e.g. pricing price books).
  const variant = c.req.query("variant");
  if (source.variants) {
    if (!variant || !getVariant(source, variant)) {
      return c.json({ error: "missing or invalid ?variant" }, 400);
    }
  }

  const { contentType, ext } = resolveContentType(
    source,
    c.req.header("content-type") ?? "",
  );
  if (!ext) {
    return c.json(
      {
        error: `unsupported content-type; expected one of ${source.acceptedContentTypes.join(", ")}`,
      },
      415,
    );
  }

  const lenHeader = c.req.header("content-length");
  if (lenHeader && Number(lenHeader) > source.maxBytes) {
    return c.json({ error: `file exceeds max size (${source.maxBytes} bytes)` }, 413);
  }

  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return c.json({ error: "empty body" }, 400);
  if (bytes.byteLength > source.maxBytes) {
    return c.json({ error: `file exceeds max size (${source.maxBytes} bytes)` }, 413);
  }

  const res = await createIngestion(c.env, serviceSupabase(c.env), {
    source: source.key,
    variant: variant ?? undefined,
    originalName: c.req.query("filename") ?? undefined,
    contentType,
    ext,
    bytes,
    deliveredBy: isTokenCaller ? "power-automate" : user.email,
  });
  if (!res.ok) return c.json({ error: res.error }, 500);

  return c.json(
    { ingestionId: res.row.id, r2Key: res.row.r2_key, status: res.row.status },
    201,
  );
});

/** List recent ingestions across all sources (internal/admin). */
ingestRoutes.get("/", requireAuth, async (c) => {
  if (!isInternalOrAdmin(c.get("user"))) {
    return c.json({ error: "internal access required" }, 403);
  }
  const source = c.req.query("source");
  const rows = await listIngestions(serviceSupabase(c.env), { source });
  return c.json({ ingestions: rows.map(toIngestionResponse) });
});

/** One ingestion (internal/admin). */
ingestRoutes.get("/:id", requireAuth, async (c) => {
  if (!isInternalOrAdmin(c.get("user"))) {
    return c.json({ error: "internal access required" }, 403);
  }
  const row = await getIngestion(serviceSupabase(c.env), c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(toIngestionResponse(row));
});

/** Re-enqueue an ingestion from its stored R2 key (internal/admin). */
ingestRoutes.post("/:id/reprocess", requireAuth, async (c) => {
  if (!isInternalOrAdmin(c.get("user"))) {
    return c.json({ error: "internal access required" }, 403);
  }
  const res = await reprocessIngestion(
    c.env,
    serviceSupabase(c.env),
    c.req.param("id"),
  );
  if (!res.ok) {
    return c.json({ error: res.error }, res.error === "not found" ? 404 : 500);
  }
  return c.json(toIngestionResponse(res.row));
});
