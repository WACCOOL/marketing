import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../auth.js";
import { requireAuth, requireFeature } from "../auth.js";
import { serviceSupabase } from "../supabase.js";

/**
 * Admin knowledge uploads (Thom lighting-expert plan, Prong C.1) — education
 * PDFs (energy codes, design guides, lighting fundamentals) uploaded by
 * marketing/admin into the Thom RAG store. The PDF lands in R2
 * (kb/admin_uploads/{uuid}.pdf) with a kb_documents row in 'pending_extract';
 * the nightly docs-ingest run (11:00 UTC) extracts per page, chunks, embeds,
 * and flips it to 'active'.
 *
 * Same auth posture as thomContent.ts (requireAuth + requireFeature
 * ("thom-content") + internal/admin only); kb_documents/kb_chunks are
 * service-role-write, so all kb operations use the service client.
 *
 * LICENSING (plan D, hard rule): licensed standards (IES/ASHRAE/ICC) are NEVER
 * uploaded — their knowledge enters via the curated-distillation route. Scope
 * defaults to 'internal'; 'public' requires the C.4 review confirmation
 * ("checked for third-party brand names; content verified"), both at upload
 * and on the scope-flip endpoint.
 */

export const thomUploadRoutes = new Hono<AppBindings>();

export const ADMIN_UPLOAD_SOURCE = "admin_upload";
export const EDUCATION_DOC_TYPE = "education";
/** Dimming-compatibility charts (dimming plan §A.5): admin-uploaded files
 *  beyond the PIM (rep-desk master charts, SharePoint) land in the SAME
 *  pending_extract + `--dimming` structured-extraction queue — NEVER the
 *  chunk/embed path (docs-ingest Step B excludes this doc_type, DC7). Zip
 *  uploads are accepted for THIS doc_type only. */
export const DIMMING_UPLOAD_DOC_TYPE = "dimming_report";
/** Authority tier stamped on education docs (plan R9) — inert while
 *  THOM_AUTHORITY is off, correct the day it flips on. */
export const EDUCATION_AUTHORITY = 0.9;
export const MAX_PDF_BYTES = 30 * 1024 * 1024; // 30 MB, mirrors ppt templates
/** R2 metadata key carrying the force-vision toggle to the ingest branch
 *  (kb_documents has no column for it). MUST match docs-ingest/adminUpload. */
export const FORCE_VISION_META_KEY = "force-vision";

/** Internal + admin only — reps are walled off from Thom's knowledge base
 *  (same guard as thomContent.ts). */
const requireInternal = createMiddleware<AppBindings>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "internal" && user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
});

thomUploadRoutes.use("*", requireAuth, requireFeature("thom-content"), requireInternal);

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export type UploadScope = "public" | "internal";

/** %PDF magic bytes — an arbitrary blob can't be stored as a knowledge doc. */
export function isPdfMagic(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false;
  const m = new Uint8Array(bytes, 0, 4);
  return m[0] === 0x25 && m[1] === 0x50 && m[2] === 0x44 && m[3] === 0x46;
}

/** PK\x03\x04 zip magic — accepted ONLY for dimming_report uploads (the PIM
 *  ships per-size dimming charts as zips; dimming plan §A.5). */
export function isZipMagic(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false;
  const m = new Uint8Array(bytes, 0, 4);
  return m[0] === 0x50 && m[1] === 0x4b && m[2] === 0x03 && m[3] === 0x04;
}

/** Size/emptiness/magic checks for the uploaded bytes. `%PDF` always; zip only
 *  for the dimming_report doc_type. */
export function checkPdfBytes(
  bytes: ArrayBuffer,
  docType: string = EDUCATION_DOC_TYPE,
): { ok: true } | { ok: false; error: string } {
  if (bytes.byteLength === 0) return { ok: false, error: "empty file" };
  if (bytes.byteLength > MAX_PDF_BYTES) {
    return { ok: false, error: `file exceeds max size (${MAX_PDF_BYTES} bytes)` };
  }
  if (isPdfMagic(bytes)) return { ok: true };
  if (docType === DIMMING_UPLOAD_DOC_TYPE && isZipMagic(bytes)) return { ok: true };
  return {
    ok: false,
    error:
      docType === DIMMING_UPLOAD_DOC_TYPE
        ? "file is not a valid PDF or zip (missing %PDF / PK header)"
        : "file is not a valid PDF (missing %PDF header)",
  };
}

const STANDARDS_TITLE_RE =
  /\b(standards?|codes?|title\s*24|ashrae|iecc|ansi|icc|nec|energy|ja8|90\.1|rp-\d+|lm-\d+|ls-\d+|ordinance)\b/i;
const EDITION_RE = /\b(19|20)\d{2}\b|\bedition\b|\bed\.|\bv\d/i;

/**
 * Standards/codes must carry edition/year in the title (plan R13) so citations
 * are unambiguous — a NON-BLOCKING nudge returned as `warning` on upload.
 */
export function titleEditionWarning(title: string): string | null {
  if (STANDARDS_TITLE_RE.test(title) && !EDITION_RE.test(title)) {
    return (
      "This looks like a standard or code document. Include the edition or year " +
      'in the title (e.g. "CA Title 24 Part 6 (2025)") so citations are unambiguous.'
    );
  }
  return null;
}

export interface UploadFields {
  title: string;
  brand: string | null;
  scope: UploadScope;
  forceVision: boolean;
  /** 'education' (default) or 'dimming_report' (§A.5 — routed to the
   *  --dimming structured-extraction queue, never chunk/embed). */
  docType: string;
}

/**
 * Validate the non-file multipart fields. Scope DEFAULTS to internal; 'public'
 * at upload requires the same review confirmation as the scope flip (C.4) —
 * otherwise the gate would be trivially bypassed by uploading public directly.
 */
export function parseUploadFields(
  body: Record<string, unknown>,
): { ok: true; fields: UploadFields } | { ok: false; error: string } {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return { ok: false, error: 'missing "title" field' };
  if (title.length > 300) return { ok: false, error: "title too long (max 300 chars)" };
  const scopeRaw = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : "internal";
  if (scopeRaw !== "public" && scopeRaw !== "internal") {
    return { ok: false, error: 'scope must be "public" or "internal"' };
  }
  const confirmed = body.confirmed === true || body.confirmed === "true" || body.confirmed === "1";
  if (scopeRaw === "public" && !confirmed) {
    return {
      ok: false,
      error:
        "Uploading as Public requires the review confirmation (checked for " +
        "third-party brand names; content verified). Upload as Internal, review, " +
        "then flip to Public.",
    };
  }
  const brand = typeof body.brand === "string" && body.brand.trim() ? body.brand.trim() : null;
  const forceVision = body.force_vision === "true" || body.force_vision === "1" || body.force_vision === true;
  const docTypeRaw =
    typeof body.doc_type === "string" && body.doc_type.trim() ? body.doc_type.trim() : EDUCATION_DOC_TYPE;
  if (docTypeRaw !== EDUCATION_DOC_TYPE && docTypeRaw !== DIMMING_UPLOAD_DOC_TYPE) {
    return { ok: false, error: 'doc_type must be "education" or "dimming_report"' };
  }
  return { ok: true, fields: { title, brand, scope: scopeRaw, forceVision, docType: docTypeRaw } };
}

/** Does a Supabase insert error mean "same content already uploaded"? The 0059
 *  partial unique index (content_hash where source_system='admin_upload' and
 *  status <> 'superseded') makes the duplicate check race-free. */
export function isDuplicateUploadError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === "23505" && (err.message ?? "").includes("kb_documents_admin_upload_hash_uniq");
}

/** The C.4 review gate for scope changes: flipping to public requires the
 *  explicit confirmation; flipping back to internal never needs one. */
export function scopeFlipAllowed(
  target: UploadScope,
  confirmed: boolean,
): { ok: true } | { ok: false; error: string } {
  if (target === "public" && !confirmed) {
    return {
      ok: false,
      error:
        "Making a document public requires the review confirmation: checked for " +
        "third-party brand names; content verified.",
    };
  }
  return { ok: true };
}

/** The ingest records chunk-cap truncation as a WARNING-prefixed last_error
 *  (status stays active) — this is the UI's truncation flag. */
export function isTruncationWarning(lastError: string | null | undefined): boolean {
  return typeof lastError === "string" && lastError.startsWith("WARNING");
}

/** sha256 hex of the raw bytes — the kb_documents.content_hash dedup key. */
export async function sha256HexBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Multipart intake
// ---------------------------------------------------------------------------

type PdfUpload =
  | { ok: true; bytes: ArrayBuffer; fields: UploadFields }
  | { ok: false; error: string };

async function readPdfUpload(c: Context<AppBindings>): Promise<PdfUpload> {
  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody();
  } catch {
    return { ok: false, error: "expected multipart/form-data with a file part" };
  }
  const file = body.file;
  if (!(file instanceof File)) return { ok: false, error: 'missing "file" part' };
  const fields = parseUploadFields(body);
  if (!fields.ok) return { ok: false, error: fields.error };
  const isDimming = fields.fields.docType === DIMMING_UPLOAD_DOC_TYPE;
  // Zip uploads are accepted for dimming_report ONLY (§A.5).
  if (isDimming ? !/\.(pdf|zip)$/i.test(file.name) : !/\.pdf$/i.test(file.name)) {
    return { ok: false, error: isDimming ? "file must be a .pdf or .zip" : "file must be a .pdf" };
  }
  if (file.size > MAX_PDF_BYTES) {
    return { ok: false, error: `file exceeds max size (${MAX_PDF_BYTES} bytes)` };
  }
  const bytes = await file.arrayBuffer();
  const check = checkPdfBytes(bytes, fields.fields.docType);
  if (!check.ok) return { ok: false, error: check.error };
  return { ok: true, bytes, fields: fields.fields };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const DOC_COLS = "id, title, brand, scope, status, last_error, extracted_at, created_at, r2_key";

interface UploadDocRow {
  id: string;
  title: string | null;
  brand: string | null;
  scope: UploadScope;
  status: string;
  last_error: string | null;
  extracted_at: string | null;
  created_at: string;
  r2_key: string | null;
  kb_chunks?: { count: number }[];
}

async function loadUploadDoc(
  c: Context<AppBindings>,
  id: string,
): Promise<UploadDocRow | null> {
  const admin = serviceSupabase(c.env);
  const { data, error } = await admin
    .from("kb_documents")
    .select(DOC_COLS)
    .eq("id", id)
    .eq("source_system", ADMIN_UPLOAD_SOURCE)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as UploadDocRow | null) ?? null;
}

/** Upload a new education PDF. */
thomUploadRoutes.post("/", async (c) => {
  const upload = await readPdfUpload(c);
  if (!upload.ok) return c.json({ error: upload.error }, 400);
  const { bytes, fields } = upload;

  const id = crypto.randomUUID();
  const isZip = isZipMagic(bytes);
  const r2Key = `kb/admin_uploads/${id}.${isZip ? "zip" : "pdf"}`;
  const hash = await sha256HexBytes(bytes);
  const admin = serviceSupabase(c.env);

  // Insert FIRST: the 0059 partial unique index turns a duplicate content_hash
  // into an insert conflict — race-free dedup before any R2 write. Dimming
  // charts share this queue but are picked up by `--dimming` (Step B excludes
  // the doc_type at the SQL level — DC7), so they are never chunked/embedded.
  const { error } = await admin
    .from("kb_documents")
    .insert({
      source_system: ADMIN_UPLOAD_SOURCE,
      external_id: id,
      doc_type: fields.docType,
      scope: fields.scope,
      title: fields.title,
      brand: fields.brand,
      url: null,
      r2_key: r2Key,
      content_hash: hash,
      status: "pending_extract",
      authority: fields.docType === EDUCATION_DOC_TYPE ? EDUCATION_AUTHORITY : null,
    })
    .select("id")
    .single();
  if (error) {
    if (isDuplicateUploadError(error)) {
      const { data: dup } = await admin
        .from("kb_documents")
        .select("title")
        .eq("source_system", ADMIN_UPLOAD_SOURCE)
        .eq("content_hash", hash)
        .neq("status", "superseded")
        .limit(1)
        .maybeSingle();
      const dupTitle = (dup?.title as string | null) ?? "an existing document";
      return c.json({ error: `This PDF is already uploaded as "${dupTitle}".` }, 409);
    }
    return c.json({ error: error.message }, 500);
  }

  try {
    await c.env.ASSETS_BUCKET.put(r2Key, bytes, {
      httpMetadata: { contentType: isZip ? "application/zip" : "application/pdf" },
      customMetadata: fields.forceVision ? { [FORCE_VISION_META_KEY]: "1" } : undefined,
    });
  } catch (e) {
    // Don't leave a pending row pointing at nothing.
    await admin.from("kb_documents").delete().eq("id", id);
    return c.json({ error: `upload storage failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }

  return c.json({ id, ok: true, warning: titleEditionWarning(fields.title) }, 201);
});

/** List uploads (superseded = deleted, hidden) with chunk counts + truncation flag. */
thomUploadRoutes.get("/", async (c) => {
  const admin = serviceSupabase(c.env);
  const { data, error } = await admin
    .from("kb_documents")
    .select(`${DOC_COLS}, kb_chunks(count)`)
    .eq("source_system", ADMIN_UPLOAD_SOURCE)
    .neq("status", "superseded")
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  const items = ((data ?? []) as UploadDocRow[]).map((r) => ({
    id: r.id,
    title: r.title,
    brand: r.brand,
    scope: r.scope,
    status: r.status,
    last_error: r.last_error,
    truncated: isTruncationWarning(r.last_error),
    chunk_count: r.kb_chunks?.[0]?.count ?? 0,
    extracted_at: r.extracted_at,
    created_at: r.created_at,
  }));
  return c.json({ items });
});

/** Requeue a document for the nightly ingest (re-extract + re-embed). */
thomUploadRoutes.post("/:id/reingest", async (c) => {
  const admin = serviceSupabase(c.env);
  const { data, error } = await admin
    .from("kb_documents")
    .update({ status: "pending_extract", last_error: null })
    .eq("id", c.req.param("id"))
    .eq("source_system", ADMIN_UPLOAD_SOURCE)
    .neq("status", "superseded")
    .select("id")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

/** Stream the stored PDF (internal auth — the R2 key is never exposed raw). */
thomUploadRoutes.get("/:id/file", async (c) => {
  let doc: UploadDocRow | null;
  try {
    doc = await loadUploadDoc(c, c.req.param("id"));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
  if (!doc || !doc.r2_key) return c.json({ error: "not found" }, 404);
  const obj = await c.env.ASSETS_BUCKET.get(doc.r2_key);
  if (!obj) return c.json({ error: "file missing from storage" }, 404);
  const name = (doc.title ?? "document").replace(/[^\w .-]+/g, "_");
  return new Response(obj.body, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${name}.pdf"`,
    },
  });
});

const ScopePatchSchema = z.object({
  scope: z.enum(["public", "internal"]),
  confirmed: z.boolean().optional(),
});

/**
 * Flip a document's scope. Public requires the C.4 review confirmation; the
 * flip re-stamps the DENORMALIZED kb_chunks.scope too (kb_search filters on
 * the chunk column — a stale chunk scope would leak or hide content).
 */
thomUploadRoutes.patch("/:id", async (c) => {
  const parsed = ScopePatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const gate = scopeFlipAllowed(parsed.data.scope, parsed.data.confirmed === true);
  if (!gate.ok) return c.json({ error: gate.error }, 400);

  const admin = serviceSupabase(c.env);
  const { data, error } = await admin
    .from("kb_documents")
    .update({ scope: parsed.data.scope })
    .eq("id", c.req.param("id"))
    .eq("source_system", ADMIN_UPLOAD_SOURCE)
    .neq("status", "superseded")
    .select("id")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "not found" }, 404);

  const { error: chunkErr } = await admin
    .from("kb_chunks")
    .update({ scope: parsed.data.scope })
    .eq("document_id", c.req.param("id"));
  if (chunkErr) return c.json({ error: `chunk scope restamp failed: ${chunkErr.message}` }, 500);
  return c.json({ ok: true });
});

/** Delete (admin only, same posture as thomContent): supersede the row (the
 *  0059 partial index then frees the hash for re-upload), drop its chunks, and
 *  delete the R2 object. */
thomUploadRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "admin only" }, 403);
  const id = c.req.param("id");
  let doc: UploadDocRow | null;
  try {
    doc = await loadUploadDoc(c, id);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
  if (!doc) return c.json({ error: "not found" }, 404);

  const admin = serviceSupabase(c.env);
  const { error: chunkErr } = await admin.from("kb_chunks").delete().eq("document_id", id);
  if (chunkErr) return c.json({ error: chunkErr.message }, 500);
  const { error } = await admin
    .from("kb_documents")
    .update({ status: "superseded" })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 500);
  if (doc.r2_key) {
    try {
      await c.env.ASSETS_BUCKET.delete(doc.r2_key);
    } catch (e) {
      console.warn(`[thom] R2 delete failed for ${doc.r2_key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return c.json({ ok: true });
});
