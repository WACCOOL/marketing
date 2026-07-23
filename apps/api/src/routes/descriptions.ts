import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  DESC_SLOTS,
  DescImageKeySchema,
  ImportPayloadSchema,
  MASTER_SUPPLEMENT,
  SUPPLEMENT_MASTER,
  SupplementPayloadSchema,
  buildSupplementOverlay,
  clearFeatureOverlay,
  computeCommitDiff,
  contentRowEdited,
  isDescMasterSlot,
  isDescSlot,
  isDescSupplementSlot,
  matchSupplementUnits,
  overlayFeatures,
  slugKey,
  type DescMasterSlot,
  type DescSlot,
  type DescSupplementSlot,
  type ParsedProduct,
} from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { requireAuth, requireFeature } from "../auth.js";
import { emailsForUserIds, serviceSupabase, userSupabase } from "../supabase.js";

/**
 * Descriptions — new-product master-list import + copy review (plan Stage 1).
 *
 * The browser does ALL binary parsing (SheetJS) and posts a zod-validated
 * JSON ImportPayload; this Worker archives the raw file (magic bytes + size
 * cap), validates the payload against the SAME shared schema, and runs the
 * two-phase commit: dryRun reports {new, updated, removed, orphaned} with the
 * model-base relink applied BEFORE removed is computed; the real commit
 * replaces the slot's products wholesale, relinks desc_content keys, and
 * deletes only content with no human work — edited/approved copy is orphaned,
 * never destroyed (plan decisions 1/4).
 *
 * RLS scopes the tables to active internal/admin users — the rep guard below
 * exists to return a friendlier 403 (productinfo.ts pattern). Reads run on
 * the user client so RLS applies; only the commit/replace machinery uses the
 * service role.
 */
export const descriptionsRoutes = new Hono<AppBindings>();

descriptionsRoutes.use("*", requireAuth, requireFeature("product"), async (c, next) => {
  if (c.get("user").role === "rep") {
    return c.json(
      { error: "Descriptions is available to internal users only" },
      403,
    );
  }
  await next();
});

const MAX_RAW_BYTES = 30 * 1024 * 1024; // 30 MB, mirrors MAX_PPTX_BYTES

/** Per-slot file shape: extension, stored content type, magic-byte family. */
const SLOT_FILES: Record<DescSlot, { ext: string; contentType: string; magic: "zip" | "pdf" }> = {
  dweled_master: {
    ext: "xlsx",
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    magic: "zip",
  },
  mf_master: {
    ext: "xlsx",
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    magic: "zip",
  },
  schonbek_master: {
    ext: "xlsx",
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    magic: "zip",
  },
  dweled_pptx: {
    ext: "pptx",
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    magic: "zip",
  },
  mf_pdf: { ext: "pdf", contentType: "application/pdf", magic: "pdf" },
  schonbek_pdf: { ext: "pdf", contentType: "application/pdf", magic: "pdf" },
};

function magicOk(bytes: ArrayBuffer, kind: "zip" | "pdf"): boolean {
  const b = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  if (b.length < 4) return false;
  if (kind === "zip") {
    return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  }
  // %PDF
  return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

/** Sniff a raster image's type from magic bytes (client blobs are untrusted). */
function sniffImage(bytes: ArrayBuffer): { ext: "jpg" | "png" | "webp"; contentType: string } | null {
  const b = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { ext: "jpg", contentType: "image/jpeg" };
  }
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { ext: "png", contentType: "image/png" };
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // WEBP
  ) {
    return { ext: "webp", contentType: "image/webp" };
  }
  return null;
}

function imageContentType(key: string): string {
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

/** Verify every referenced image key exists in R2 before any DB write. */
async function missingImageKeys(
  bucket: R2Bucket,
  keys: Iterable<string>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const key of new Set(keys)) {
    const head = await bucket.head(key);
    if (!head) missing.push(key);
  }
  return missing;
}

interface ImportRow {
  id: string;
  slot: DescSlot;
  filename: string;
  r2_key: string;
  bytes: number;
  sha256: string;
  status: "uploaded" | "committed" | "failed";
  parse_report: Record<string, unknown> | null;
  uploaded_by: string | null;
  uploaded_at: string;
  committed_at: string | null;
}

const IMPORT_COLS =
  "id, slot, filename, r2_key, bytes, sha256, status, parse_report, uploaded_by, uploaded_at, committed_at";

interface ProductRow extends ParsedProduct {
  id: string;
  slot: DescSlot;
  import_id: string;
}

const PRODUCT_COLS =
  "id, slot, import_id, brand, collection, year, content_key, name, family, product_type, diffuser_type, finishes, sizes, cct, model_numbers, model_bases, features, attributes, source_rows, sort_order";

interface ContentRow {
  id: string;
  slot: DescSlot;
  content_key: string;
  description_ai: string | null;
  description_final: string | null;
  meta_ai: string | null;
  meta_final: string | null;
  title_override: string | null;
  status: "none" | "generated" | "in_review" | "approved";
  note: string | null;
  reviewed_by: string | null;
  model: string | null;
  generated_at: string | null;
  updated_at: string;
}

const CONTENT_COLS =
  "id, slot, content_key, description_ai, description_final, meta_ai, meta_final, title_override, status, note, reviewed_by, model, generated_at, updated_at";

interface ImageRow {
  id: string;
  product_id: string | null;
  slot: DescSlot;
  r2_key: string;
  source: string;
  sort_order: number;
}

// ---------------------------------------------------------------------------
// GET / — the full dataset (~150 rows; no pagination by design)
// ---------------------------------------------------------------------------

descriptionsRoutes.get("/", async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const [products, content, images] = await Promise.all([
    sb
      .from("desc_products")
      .select(PRODUCT_COLS)
      .order("sort_order", { ascending: true })
      .limit(2000),
    sb.from("desc_content").select(CONTENT_COLS).limit(4000),
    sb
      .from("desc_product_images")
      .select("id, product_id, slot, r2_key, source, sort_order")
      .order("sort_order", { ascending: true })
      .limit(4000),
  ]);
  for (const res of [products, content, images]) {
    if (res.error) return c.json({ error: res.error.message }, 500);
  }
  const productRows = (products.data ?? []) as unknown as ProductRow[];
  const contentRows = (content.data ?? []) as ContentRow[];
  const imageRows = (images.data ?? []) as ImageRow[];

  const contentByKey = new Map(
    contentRows.map((r) => [`${r.slot} ${r.content_key}`, r]),
  );
  const imagesByProduct = new Map<string, ImageRow[]>();
  const tray: ImageRow[] = [];
  for (const img of imageRows) {
    if (!img.product_id) {
      // Unassigned tray (Schonbek pdf pages awaiting manual attach).
      if (img.slot === "schonbek_pdf") tray.push(img);
      continue;
    }
    const list = imagesByProduct.get(img.product_id) ?? [];
    list.push(img);
    imagesByProduct.set(img.product_id, list);
  }

  const productKeys = new Set(
    productRows.map((p) => `${p.slot} ${p.content_key}`),
  );
  const orphans = contentRows.filter(
    (r) => !productKeys.has(`${r.slot} ${r.content_key}`),
  );

  return c.json({
    products: productRows.map((p) => ({
      ...p,
      content: contentByKey.get(`${p.slot} ${p.content_key}`) ?? null,
      images: imagesByProduct.get(p.id) ?? [],
    })),
    tray,
    orphans,
  });
});

// ---------------------------------------------------------------------------
// GET /files — latest import per slot (the slot cards)
// ---------------------------------------------------------------------------

descriptionsRoutes.get("/files", async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("desc_imports")
    .select(IMPORT_COLS)
    .order("uploaded_at", { ascending: false })
    .limit(200);
  if (error) return c.json({ error: error.message }, 500);
  const rows = (data ?? []) as ImportRow[];

  // The live file per slot = latest COMMITTED row (rows are newest-first);
  // an abandoned "uploaded"/"failed" attempt never masks a good import.
  const committedBySlot = new Map<string, ImportRow>();
  const newestBySlot = new Map<string, ImportRow>();
  for (const row of rows) {
    if (!newestBySlot.has(row.slot)) newestBySlot.set(row.slot, row);
    if (row.status === "committed" && !committedBySlot.has(row.slot)) {
      committedBySlot.set(row.slot, row);
    }
  }

  const emails = await emailsForUserIds(
    c.env,
    rows.map((r) => r.uploaded_by ?? "").filter(Boolean),
  );

  const files = DESC_SLOTS.map((slot) => {
    const present = committedBySlot.get(slot) ?? newestBySlot.get(slot) ?? null;
    return {
      slot,
      latest: present
        ? {
            id: present.id,
            filename: present.filename,
            bytes: present.bytes,
            status: present.status,
            uploaded_at: present.uploaded_at,
            committed_at: present.committed_at,
            parse_report: present.parse_report,
            uploaded_by_email: present.uploaded_by
              ? (emails.get(present.uploaded_by) ?? null)
              : null,
          }
        : null,
    };
  });
  return c.json({ files });
});

// ---------------------------------------------------------------------------
// POST /files/:slot/raw — archive the original file (multipart)
// ---------------------------------------------------------------------------

descriptionsRoutes.post("/files/:slot/raw", async (c) => {
  const slot = c.req.param("slot");
  if (!isDescSlot(slot)) return c.json({ error: "unknown file slot" }, 404);
  const spec = SLOT_FILES[slot];

  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "expected multipart/form-data with a file part" }, 400);
  }
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: 'missing "file" part' }, 400);
  if (file.size > MAX_RAW_BYTES) {
    return c.json({ error: `file exceeds max size (${MAX_RAW_BYTES} bytes)` }, 413);
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) return c.json({ error: "empty file" }, 400);
  if (bytes.byteLength > MAX_RAW_BYTES) {
    return c.json({ error: `file exceeds max size (${MAX_RAW_BYTES} bytes)` }, 413);
  }
  if (!magicOk(bytes, spec.magic)) {
    return c.json(
      { error: `file is not a valid .${spec.ext} (bad ${spec.magic === "zip" ? "zip" : "PDF"} header)` },
      400,
    );
  }

  const sha256 = await sha256Hex(bytes);
  const r2Key = `descriptions/raw/${slot}/${sha256}.${spec.ext}`;
  await c.env.ASSETS_BUCKET.put(r2Key, bytes, {
    httpMetadata: { contentType: spec.contentType },
  });

  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("desc_imports")
    .insert({
      slot,
      filename: file.name.slice(0, 300),
      r2_key: r2Key,
      bytes: bytes.byteLength,
      sha256,
      status: "uploaded",
      uploaded_by: c.get("user").id,
    })
    .select(IMPORT_COLS)
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ import_id: (data as ImportRow).id }, 201);
});

// ---------------------------------------------------------------------------
// POST /files/:slot/images — upload downscaled images (content-hash keys)
// ---------------------------------------------------------------------------

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES_PER_REQUEST = 10;

descriptionsRoutes.post("/files/:slot/images", async (c) => {
  const slot = c.req.param("slot");
  if (!isDescSlot(slot)) return c.json({ error: "unknown file slot" }, 404);

  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch {
    return c.json({ error: "expected multipart/form-data with file parts" }, 400);
  }
  const raw = body.file;
  const files = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(
    (f): f is File => f instanceof File,
  );
  if (files.length === 0) return c.json({ error: 'missing "file" part(s)' }, 400);
  if (files.length > MAX_IMAGES_PER_REQUEST) {
    return c.json({ error: `too many images (max ${MAX_IMAGES_PER_REQUEST} per request)` }, 400);
  }

  const out: { name: string; r2_key: string; bytes: number; deduped: boolean }[] = [];
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      return c.json({ error: `image "${file.name}" exceeds ${MAX_IMAGE_BYTES} bytes` }, 413);
    }
    const bytes = await file.arrayBuffer();
    const kind = sniffImage(bytes);
    if (!kind) {
      return c.json({ error: `image "${file.name}" is not a JPEG, PNG or WebP` }, 400);
    }
    const hash = await sha256Hex(bytes);
    const r2Key = `descriptions/img/${slot}/${hash}.${kind.ext}`;
    // Content-hash dedup: an existing object short-circuits the write, which
    // also makes re-imports of an unchanged file upload nothing.
    const existing = await c.env.ASSETS_BUCKET.head(r2Key);
    if (!existing) {
      await c.env.ASSETS_BUCKET.put(r2Key, bytes, {
        httpMetadata: { contentType: kind.contentType },
      });
    }
    out.push({
      name: file.name,
      r2_key: r2Key,
      bytes: bytes.byteLength,
      deduped: !!existing,
    });
  }
  return c.json({ images: out }, 201);
});

// ---------------------------------------------------------------------------
// GET /images/* — auth-gated R2 read (assets.ts pattern; these are
// unreleased products, so images are NEVER publicly served)
// ---------------------------------------------------------------------------

descriptionsRoutes.get("/images/*", async (c) => {
  const marker = "/images/";
  const path = decodeURIComponent(new URL(c.req.url).pathname);
  const key = path.slice(path.indexOf(marker) + marker.length);
  if (!DescImageKeySchema.safeParse(key).success) {
    return c.json({ error: "not found" }, 404);
  }
  const obj = await c.env.ASSETS_BUCKET.get(key);
  if (!obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": imageContentType(key),
      // Keys are content hashes — safe to cache privately for a long time.
      "cache-control": "private, max-age=86400, immutable",
    },
  });
});

// ---------------------------------------------------------------------------
// PATCH /images/:id — Schonbek tray assign/unassign
// ---------------------------------------------------------------------------

const AssignImageSchema = z.object({ product_id: z.string().uuid().nullable() });

descriptionsRoutes.patch("/images/:id", async (c) => {
  const id = c.req.param("id");
  const parsed = AssignImageSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data: img, error } = await sb
    .from("desc_product_images")
    .select("id, slot, product_id, r2_key, source, sort_order")
    .eq("id", id)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!img) return c.json({ error: "image not found" }, 404);
  if ((img as ImageRow).slot !== "schonbek_pdf") {
    return c.json({ error: "only Schonbek tray images can be reassigned" }, 400);
  }
  if (parsed.data.product_id) {
    const { data: prod, error: perr } = await sb
      .from("desc_products")
      .select("id")
      .eq("id", parsed.data.product_id)
      .maybeSingle();
    if (perr) return c.json({ error: perr.message }, 500);
    if (!prod) return c.json({ error: "product not found" }, 404);
  }
  const { data: updated, error: uerr } = await sb
    .from("desc_product_images")
    .update({ product_id: parsed.data.product_id })
    .eq("id", id)
    .select("id, product_id, slot, r2_key, source, sort_order")
    .single();
  if (uerr) return c.json({ error: uerr.message }, 500);
  return c.json({ image: updated });
});

// ---------------------------------------------------------------------------
// POST /files/:slot/commit — two-phase import (dryRun diff, then commit)
// ---------------------------------------------------------------------------

const CommitSchema = z.object({
  import_id: z.string().uuid(),
  dryRun: z.boolean().default(false),
  payload: ImportPayloadSchema,
});

const CommitSupplementSchema = z.object({
  import_id: z.string().uuid(),
  payload: SupplementPayloadSchema,
});

interface EnrichmentRow {
  id: string;
  import_id: string;
  slot: DescSupplementSlot;
  match_key: string;
  name: string | null;
  model_numbers: string[];
  model_bases: string[];
  bullets: string[];
  image_keys: string[];
  matched: boolean;
  matched_content_key: string | null;
}

const ENRICHMENT_COLS =
  "id, import_id, slot, match_key, name, model_numbers, model_bases, bullets, image_keys, matched, matched_content_key";

/** Supplement sort order starts here so its images always follow xlsx renders. */
const SUPPLEMENT_SORT_BASE = 1000;

/**
 * Run the shared matcher over stored enrichment units and produce the
 * feature/image overlay plus per-row matched flags.
 */
function matchEnrichmentRows(
  rows: EnrichmentRow[],
  groups: { content_key: string; name: string | null; model_bases: string[] }[],
) {
  const matches = matchSupplementUnits(
    rows.map((r) => ({
      row: r,
      name: r.name,
      modelBases: r.model_bases,
    })),
    groups,
  );
  const overlay = buildSupplementOverlay(
    matches.flatMap((m) =>
      m.content_keys.map((key) => ({
        content_key: key,
        ref: m.unit.row.match_key,
        bullets: m.unit.row.bullets,
        imageKeys: m.unit.row.image_keys,
      })),
    ),
  );
  return { matches, overlay };
}

descriptionsRoutes.post("/files/:slot/commit", async (c) => {
  const slot = c.req.param("slot");
  if (isDescMasterSlot(slot)) return commitMaster(c, slot);
  if (isDescSupplementSlot(slot)) return commitSupplement(c, slot);
  return c.json({ error: "unknown file slot" }, 404);
});

type Ctx = Context<AppBindings>;

async function loadImport(
  c: Ctx,
  importId: string,
  slot: DescSlot,
): Promise<{ ok: true; imp: ImportRow } | { ok: false; res: Response }> {
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data: importRow, error: impErr } = await sb
    .from("desc_imports")
    .select(IMPORT_COLS)
    .eq("id", importId)
    .maybeSingle();
  if (impErr) return { ok: false, res: c.json({ error: impErr.message }, 500) };
  const imp = importRow as ImportRow | null;
  if (!imp) {
    return { ok: false, res: c.json({ error: "import not found; upload the file first" }, 404) };
  }
  if (imp.slot !== slot) {
    return { ok: false, res: c.json({ error: "import belongs to a different slot" }, 400) };
  }
  return { ok: true, imp };
}

async function commitMaster(c: Ctx, slot: DescMasterSlot): Promise<Response> {
  const parsed = CommitSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const { import_id, dryRun, payload } = parsed.data;
  if (payload.slot !== slot) {
    return c.json({ error: "payload slot does not match the URL slot" }, 400);
  }

  const loaded = await loadImport(c, import_id, slot);
  if (!loaded.ok) return loaded.res;

  const sb = userSupabase(c.env, c.get("jwt"));
  // Current state (user client — RLS applies to reads).
  const [oldRes, contentRes] = await Promise.all([
    sb
      .from("desc_products")
      .select("id, content_key, name, model_bases")
      .eq("slot", slot)
      .limit(2000),
    sb
      .from("desc_content")
      .select("content_key, status, description_final, meta_final, title_override")
      .eq("slot", slot)
      .limit(4000),
  ]);
  if (oldRes.error) return c.json({ error: oldRes.error.message }, 500);
  if (contentRes.error) return c.json({ error: contentRes.error.message }, 500);

  const oldProducts = (oldRes.data ?? []) as {
    id: string;
    content_key: string;
    name: string | null;
    model_bases: string[];
  }[];
  const contentRows = (contentRes.data ?? []) as {
    content_key: string;
    status: string;
    description_final: string | null;
    meta_final: string | null;
    title_override: string | null;
  }[];

  // Model-base relink runs FIRST; removed is computed after (decision 4).
  const diff = computeCommitDiff(
    oldProducts,
    payload.products.map((p) => ({
      content_key: p.content_key,
      name: p.name,
      model_bases: p.model_bases,
    })),
    contentRows.map((r) => ({
      content_key: r.content_key,
      edited: contentRowEdited(r),
    })),
  );

  const summary = {
    products: payload.products.length,
    images: payload.images.length,
    new: diff.added.map((a) => a.name ?? a.content_key),
    updated: diff.updated.length,
    removed: diff.removed.map((r) => r.name ?? r.content_key),
    relinked: diff.relinks.length,
    orphaned: diff.orphaned,
    warnings: payload.warnings,
    sheets: payload.sheets,
  };

  if (dryRun) return c.json({ dryRun: true, ...summary });

  // Referenced image keys must already exist in R2 (uploaded via
  // /files/:slot/images) before anything is written.
  const missing = await missingImageKeys(
    c.env.ASSETS_BUCKET,
    payload.images.map((i) => i.r2_key),
  );
  if (missing.length > 0) {
    return c.json(
      { error: `missing uploaded images: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}` },
      400,
    );
  }

  // The paired supplemental slot's committed units re-apply to the fresh
  // products (features overlay computed BEFORE insert; images re-linked
  // after). schonbek_pdf has no matcher — its manual tray assignments are
  // snapshotted by content_key and restored after the replace.
  const supSlot = MASTER_SUPPLEMENT[slot];
  const supMaster = SUPPLEMENT_MASTER[supSlot];
  let enrichmentRows: EnrichmentRow[] = [];
  if (supMaster === slot) {
    const { data: enr, error: enrErr } = await sb
      .from("desc_enrichment")
      .select(ENRICHMENT_COLS)
      .eq("slot", supSlot)
      .limit(500);
    if (enrErr) return c.json({ error: enrErr.message }, 500);
    enrichmentRows = (enr ?? []) as EnrichmentRow[];
  }
  const { matches, overlay } = matchEnrichmentRows(
    enrichmentRows,
    payload.products.map((p) => ({
      content_key: p.content_key,
      name: p.name,
      model_bases: p.model_bases,
    })),
  );

  // Manual tray assignments (Schonbek): r2_key → old content_key.
  const oldIdToKey = new Map(oldProducts.map((p) => [p.id, p.content_key]));
  let traySnapshot: { r2_key: string; content_key: string }[] = [];
  if (slot === "schonbek_master") {
    const { data: trayRows, error: trayErr } = await sb
      .from("desc_product_images")
      .select("r2_key, product_id")
      .eq("slot", "schonbek_pdf")
      .not("product_id", "is", null)
      .limit(1000);
    if (trayErr) return c.json({ error: trayErr.message }, 500);
    traySnapshot = ((trayRows ?? []) as { r2_key: string; product_id: string }[])
      .map((r) => ({ r2_key: r.r2_key, content_key: oldIdToKey.get(r.product_id) ?? "" }))
      .filter((r) => r.content_key);
  }

  // Commit — service role (bulk replace + relink). Deliberately
  // NON-transactional: Supabase's REST API has no cross-statement
  // transactions, so this is sequenced delete → insert → relink → prune →
  // status-flip, with the import-status flip LAST. A mid-flight failure
  // marks the import "failed" and leaves the slot partially populated;
  // simply re-running the import heals it (products are replaced wholesale,
  // image hashes dedupe). desc_content rows with human work are never in the
  // destructive window — they are only ever relinked or flagged, and the
  // prune deletes untouched drafts alone.
  const admin = serviceSupabase(c.env);
  try {
    const del = await admin.from("desc_products").delete().eq("slot", slot);
    if (del.error) throw new Error(del.error.message);

    // Old image links: the slot's own xlsx renders are replaced outright;
    // the paired supplement's links are re-derived from the fresh matcher
    // run (except the Schonbek tray, whose rows survive and re-attach).
    const delImgs = await admin.from("desc_product_images").delete().eq("slot", slot);
    if (delImgs.error) throw new Error(delImgs.error.message);
    if (supSlot !== "schonbek_pdf") {
      const delSup = await admin.from("desc_product_images").delete().eq("slot", supSlot);
      if (delSup.error) throw new Error(delSup.error.message);
    }

    const keyToId = new Map<string, string>();
    const CHUNK = 100;
    for (let i = 0; i < payload.products.length; i += CHUNK) {
      const rows = payload.products.slice(i, i + CHUNK).map((raw) => {
        const ov = overlay.get(raw.content_key);
        const p = ov ? overlayFeatures(raw, ov.bullets) : raw;
        return {
          import_id,
          slot,
          brand: p.brand,
          collection: p.collection,
          year: p.year,
          content_key: p.content_key,
          name: p.name,
          family: p.family,
          product_type: p.product_type,
          diffuser_type: p.diffuser_type,
          finishes: p.finishes,
          sizes: p.sizes,
          cct: p.cct,
          model_numbers: p.model_numbers,
          model_bases: p.model_bases,
          features: p.features,
          attributes: p.attributes,
          source_rows: p.source_rows,
          sort_order: p.sort_order,
        };
      });
      const ins = await admin
        .from("desc_products")
        .insert(rows)
        .select("id, content_key");
      if (ins.error) throw new Error(ins.error.message);
      for (const row of (ins.data ?? []) as { id: string; content_key: string }[]) {
        keyToId.set(row.content_key, row.id);
      }
    }

    // xlsx-anchored renders.
    const imageRows = payload.images
      .filter((img) => keyToId.has(img.content_key))
      .map((img) => ({
        product_id: keyToId.get(img.content_key)!,
        import_id,
        slot,
        r2_key: img.r2_key,
        source: "xlsx" as const,
        sort_order: img.sort_order,
      }));
    for (let i = 0; i < imageRows.length; i += CHUNK) {
      const ins = await admin
        .from("desc_product_images")
        .insert(imageRows.slice(i, i + CHUNK));
      if (ins.error) throw new Error(ins.error.message);
    }

    // Supplement images re-attach after the xlsx renders.
    if (supSlot !== "schonbek_pdf" && overlay.size > 0) {
      const supImportId = enrichmentRows[0]?.import_id;
      const supImages: {
        product_id: string;
        import_id: string;
        slot: DescSupplementSlot;
        r2_key: string;
        source: "pptx" | "pdf";
        sort_order: number;
      }[] = [];
      for (const [key, ov] of overlay) {
        const productId = keyToId.get(key);
        if (!productId || !supImportId) continue;
        ov.imageKeys.forEach((r2Key, i) => {
          supImages.push({
            product_id: productId,
            import_id: supImportId,
            slot: supSlot,
            r2_key: r2Key,
            source: supSlot === "dweled_pptx" ? "pptx" : "pdf",
            sort_order: SUPPLEMENT_SORT_BASE + i,
          });
        });
      }
      for (let i = 0; i < supImages.length; i += CHUNK) {
        const ins = await admin
          .from("desc_product_images")
          .insert(supImages.slice(i, i + CHUNK));
        if (ins.error) throw new Error(ins.error.message);
      }
    }

    // Refresh per-unit matched flags on the stored enrichment rows.
    for (const m of matches) {
      const upd = await admin
        .from("desc_enrichment")
        .update({
          matched: m.content_keys.length > 0,
          matched_content_key: m.content_keys[0] ?? null,
        })
        .eq("id", m.unit.row.id);
      if (upd.error) throw new Error(upd.error.message);
    }

    // Restore Schonbek tray assignments for products that still exist.
    for (const snap of traySnapshot) {
      const productId = keyToId.get(snap.content_key);
      if (!productId) continue; // product vanished → image returns to tray
      const upd = await admin
        .from("desc_product_images")
        .update({ product_id: productId })
        .eq("slot", "schonbek_pdf")
        .eq("r2_key", snap.r2_key);
      if (upd.error) throw new Error(upd.error.message);
    }

    for (const { from, to } of diff.relinks) {
      const upd = await admin
        .from("desc_content")
        .update({ content_key: to })
        .eq("slot", slot)
        .eq("content_key", from);
      if (upd.error) throw new Error(upd.error.message);
    }

    if (diff.deletableContentKeys.length > 0) {
      const delContent = await admin
        .from("desc_content")
        .delete()
        .eq("slot", slot)
        .in("content_key", diff.deletableContentKeys);
      if (delContent.error) throw new Error(delContent.error.message);
    }

    // Orphans (edited/approved text whose product vanished) keep their rows;
    // flag them with a note so the UI can explain the state.
    if (diff.orphaned.length > 0) {
      const flag = await admin
        .from("desc_content")
        .update({ note: "orphaned by re-import; product no longer in the master list" })
        .eq("slot", slot)
        .in("content_key", diff.orphaned);
      if (flag.error) throw new Error(flag.error.message);
    }

    const fin = await admin
      .from("desc_imports")
      .update({
        status: "committed",
        committed_at: new Date().toISOString(),
        parse_report: summary,
      })
      .eq("id", import_id);
    if (fin.error) throw new Error(fin.error.message);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin
      .from("desc_imports")
      .update({ status: "failed", parse_report: { error: msg } })
      .eq("id", import_id);
    return c.json({ error: `commit failed: ${msg}` }, 500);
  }

  return c.json({ dryRun: false, ...summary });
}

// ---------------------------------------------------------------------------
// Supplemental commit (dweled_pptx / mf_pdf / schonbek_pdf)
// ---------------------------------------------------------------------------

async function commitSupplement(c: Ctx, slot: DescSupplementSlot): Promise<Response> {
  const parsed = CommitSupplementSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const { import_id, payload } = parsed.data;
  if (payload.slot !== slot) {
    return c.json({ error: "payload slot does not match the URL slot" }, 400);
  }

  const loaded = await loadImport(c, import_id, slot);
  if (!loaded.ok) return loaded.res;

  // Referenced image keys must exist in R2 before any DB write.
  const missing = await missingImageKeys(
    c.env.ASSETS_BUCKET,
    payload.units.flatMap((u) => u.image_keys),
  );
  if (missing.length > 0) {
    return c.json(
      { error: `missing uploaded images: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}` },
      400,
    );
  }

  const sb = userSupabase(c.env, c.get("jwt"));
  const masterSlot = SUPPLEMENT_MASTER[slot];

  // Unique match_key per unit (table constraint): model base, else name
  // slug, else the unit ref; duplicates get a stable ordinal suffix.
  const usedKeys = new Set<string>();
  const units = payload.units.map((u) => {
    let base = u.model_bases[0]
      ? slugKey(u.model_bases[0])
      : u.name
        ? slugKey(u.name)
        : slugKey(u.ref);
    if (!base) base = slugKey(u.ref) || "unit";
    let key = base;
    let n = 2;
    while (usedKeys.has(key)) key = `${base}:${n++}`;
    usedKeys.add(key);
    return { ...u, match_key: key };
  });

  // Matched against the paired master (schonbek_pdf has no matcher: pages
  // land in the unassigned tray).
  let masterProducts: {
    id: string;
    content_key: string;
    name: string | null;
    model_bases: string[];
    features: string[];
    attributes: Record<string, unknown>;
  }[] = [];
  if (masterSlot) {
    const { data, error } = await sb
      .from("desc_products")
      .select("id, content_key, name, model_bases, features, attributes")
      .eq("slot", masterSlot)
      .limit(2000);
    if (error) return c.json({ error: error.message }, 500);
    masterProducts = (data ?? []) as typeof masterProducts;
  }

  const matches = matchSupplementUnits(
    units.map((u) => ({ unit: u, name: u.name, modelBases: u.model_bases })),
    masterProducts.map((p) => ({
      content_key: p.content_key,
      name: p.name,
      model_bases: p.model_bases,
    })),
  );
  const overlay = buildSupplementOverlay(
    matches.flatMap((m) =>
      m.content_keys.map((key) => ({
        content_key: key,
        ref: m.unit.unit.ref,
        bullets: m.unit.unit.bullets,
        imageKeys: m.unit.unit.image_keys,
      })),
    ),
  );
  const unmatched = masterSlot
    ? matches
        .filter((m) => m.content_keys.length === 0)
        .map((m) => ({
          ref: m.unit.unit.ref,
          name: m.unit.unit.name,
          reason: m.reason ?? "no match",
        }))
    : [];

  const matchedByUnitRef = new Map<string, string[]>();
  for (const m of matches) matchedByUnitRef.set(m.unit.unit.ref, m.content_keys);

  const summary = {
    units: units.length,
    matched: masterSlot ? matches.filter((m) => m.content_keys.length > 0).length : 0,
    unmatched,
    skipped: payload.skipped,
    warnings: payload.warnings,
    images: units.reduce((n, u) => n + u.image_keys.length, 0),
  };

  // Existing tray assignments survive a re-render of an unchanged page
  // (content-hash keys): snapshot r2_key → product_id before the replace.
  const traySnapshot = new Map<string, string>();
  if (slot === "schonbek_pdf") {
    const { data: trayRows, error: trayErr } = await sb
      .from("desc_product_images")
      .select("r2_key, product_id")
      .eq("slot", slot)
      .not("product_id", "is", null)
      .limit(1000);
    if (trayErr) return c.json({ error: trayErr.message }, 500);
    for (const r of (trayRows ?? []) as { r2_key: string; product_id: string }[]) {
      if (!traySnapshot.has(r.r2_key)) traySnapshot.set(r.r2_key, r.product_id);
    }
  }

  // Same sequencing rationale as the master commit: non-transactional,
  // wholesale replace per slot, import-status flip last, re-run to heal.
  const admin = serviceSupabase(c.env);
  try {
    const delEnr = await admin.from("desc_enrichment").delete().eq("slot", slot);
    if (delEnr.error) throw new Error(delEnr.error.message);
    const delImgs = await admin.from("desc_product_images").delete().eq("slot", slot);
    if (delImgs.error) throw new Error(delImgs.error.message);

    const CHUNK = 100;
    for (let i = 0; i < units.length; i += CHUNK) {
      const rows = units.slice(i, i + CHUNK).map((u) => {
        const keys = matchedByUnitRef.get(u.ref) ?? [];
        return {
          import_id,
          slot,
          match_key: u.match_key,
          name: u.name,
          model_numbers: u.model_numbers,
          model_bases: u.model_bases,
          bullets: u.bullets,
          image_keys: u.image_keys,
          matched: keys.length > 0,
          matched_content_key: keys[0] ?? null,
        };
      });
      const ins = await admin.from("desc_enrichment").insert(rows);
      if (ins.error) throw new Error(ins.error.message);
    }

    if (masterSlot) {
      const idByKey = new Map(masterProducts.map((p) => [p.content_key, p.id]));
      // Image links for matched units (after the xlsx renders).
      const supImages: {
        product_id: string;
        import_id: string;
        slot: DescSupplementSlot;
        r2_key: string;
        source: "pptx" | "pdf";
        sort_order: number;
      }[] = [];
      for (const [key, ov] of overlay) {
        const productId = idByKey.get(key);
        if (!productId) continue;
        ov.imageKeys.forEach((r2Key, i) => {
          supImages.push({
            product_id: productId,
            import_id,
            slot,
            r2_key: r2Key,
            source: slot === "dweled_pptx" ? "pptx" : "pdf",
            sort_order: SUPPLEMENT_SORT_BASE + i,
          });
        });
      }
      for (let i = 0; i < supImages.length; i += CHUNK) {
        const ins = await admin
          .from("desc_product_images")
          .insert(supImages.slice(i, i + CHUNK));
        if (ins.error) throw new Error(ins.error.message);
      }

      // Feature overlay: matched products get the unit bullets (sheet
      // originals preserved); previously-overlaid products that no longer
      // match get their sheet features back.
      for (const p of masterProducts) {
        const ov = overlay.get(p.content_key);
        const next = ov ? overlayFeatures(p, ov.bullets) : clearFeatureOverlay(p);
        if (
          next.features === p.features &&
          next.attributes === p.attributes
        ) {
          continue; // untouched (no overlay before or now)
        }
        const upd = await admin
          .from("desc_products")
          .update({ features: next.features, attributes: next.attributes })
          .eq("id", p.id);
        if (upd.error) throw new Error(upd.error.message);
      }
    } else {
      // Schonbek pdf: every page image lands in the tray (or back on the
      // product a human previously assigned the same page image to).
      const trayImages = units.flatMap((u, ui) =>
        u.image_keys.map((r2Key, i) => ({
          product_id: traySnapshot.get(r2Key) ?? null,
          import_id,
          slot,
          r2_key: r2Key,
          source: "pdf" as const,
          sort_order: SUPPLEMENT_SORT_BASE + ui * 10 + i,
        })),
      );
      for (let i = 0; i < trayImages.length; i += CHUNK) {
        const ins = await admin
          .from("desc_product_images")
          .insert(trayImages.slice(i, i + CHUNK));
        if (ins.error) throw new Error(ins.error.message);
      }
    }

    const fin = await admin
      .from("desc_imports")
      .update({
        status: "committed",
        committed_at: new Date().toISOString(),
        parse_report: summary,
      })
      .eq("id", import_id);
    if (fin.error) throw new Error(fin.error.message);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin
      .from("desc_imports")
      .update({ status: "failed", parse_report: { error: msg } })
      .eq("id", import_id);
    return c.json({ error: `commit failed: ${msg}` }, 500);
  }

  return c.json({ dryRun: false, ...summary });
}
