import { Hono } from "hono";
import { z } from "zod";
import {
  DESC_SLOTS,
  ImportPayloadSchema,
  computeCommitDiff,
  contentRowEdited,
  isDescMasterSlot,
  isDescSlot,
  type DescSlot,
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
  for (const img of imageRows) {
    if (!img.product_id) continue;
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
// POST /files/:slot/commit — two-phase import (dryRun diff, then commit)
// ---------------------------------------------------------------------------

const CommitSchema = z.object({
  import_id: z.string().uuid(),
  dryRun: z.boolean().default(false),
  payload: ImportPayloadSchema,
});

descriptionsRoutes.post("/files/:slot/commit", async (c) => {
  const slot = c.req.param("slot");
  if (!isDescMasterSlot(slot)) {
    return c.json({ error: "commit is only supported for master-list slots" }, 400);
  }
  const parsed = CommitSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const { import_id, dryRun, payload } = parsed.data;
  if (payload.slot !== slot) {
    return c.json({ error: "payload slot does not match the URL slot" }, 400);
  }

  const sb = userSupabase(c.env, c.get("jwt"));
  const { data: importRow, error: impErr } = await sb
    .from("desc_imports")
    .select(IMPORT_COLS)
    .eq("id", import_id)
    .maybeSingle();
  if (impErr) return c.json({ error: impErr.message }, 500);
  const imp = importRow as ImportRow | null;
  if (!imp) return c.json({ error: "import not found; upload the file first" }, 404);
  if (imp.slot !== slot) return c.json({ error: "import belongs to a different slot" }, 400);

  // Current state (user client — RLS applies to reads).
  const [oldRes, contentRes] = await Promise.all([
    sb
      .from("desc_products")
      .select("content_key, name, model_bases")
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
    new: diff.added.map((a) => a.name ?? a.content_key),
    updated: diff.updated.length,
    removed: diff.removed.map((r) => r.name ?? r.content_key),
    relinked: diff.relinks.length,
    orphaned: diff.orphaned,
    warnings: payload.warnings,
    sheets: payload.sheets,
  };

  if (dryRun) return c.json({ dryRun: true, ...summary });

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

    const CHUNK = 100;
    for (let i = 0; i < payload.products.length; i += CHUNK) {
      const rows = payload.products.slice(i, i + CHUNK).map((p) => ({
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
      }));
      const ins = await admin.from("desc_products").insert(rows);
      if (ins.error) throw new Error(ins.error.message);
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
});
