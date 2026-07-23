import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  DESC_META_RANGE,
  DESC_SLOTS,
  DESC_VOICE_DEFAULTS,
  DescImageKeySchema,
  ImportPayloadSchema,
  MASTER_SUPPLEMENT,
  SUPPLEMENT_MASTER,
  SupplementPayloadSchema,
  buildDescriptionPrompt,
  buildMetaPrompt,
  buildSupplementOverlay,
  clampMetaDescription,
  clearFeatureOverlay,
  computeCommitDiff,
  contentRowEdited,
  countPreservedContent,
  extractExistingCopy,
  firstSentence,
  isDescMasterSlot,
  isDescSlot,
  isDescSupplementSlot,
  matchSupplementUnits,
  overlayFeatures,
  slugKey,
  structureSeed,
  titleFor,
  type DescContentStatus,
  type DescMasterSlot,
  type DescSlot,
  type DescSupplementSlot,
  type ParsedProduct,
} from "@wac/shared";
import {
  anthropicConfigured,
  claudeMessages,
  claudeModel,
  claudeRouterModel,
} from "../anthropic.js";
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
  wac_master: {
    ext: "xlsx",
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    magic: "zip",
  },
  wacarch_master: {
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
  wac_pptx: {
    ext: "pptx",
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    magic: "zip",
  },
  wacarch_pptx: {
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
  /** Editor's corrected product name (0073) — display/title/prompt input. */
  name_override: string | null;
  status: "none" | "generated" | "in_review" | "approved";
  note: string | null;
  reviewed_by: string | null;
  model: string | null;
  prompt_hash: string | null;
  generated_at: string | null;
  updated_at: string;
}

const CONTENT_COLS =
  "id, slot, content_key, description_ai, description_final, meta_ai, meta_final, title_override, name_override, status, note, reviewed_by, model, prompt_hash, generated_at, updated_at";

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
  let path: string;
  try {
    path = decodeURIComponent(new URL(c.req.url).pathname);
  } catch {
    return c.json({ error: "not found" }, 404); // malformed % sequence
  }
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

/**
 * Pure guard for tray reassignment (unit-tested): only Schonbek tray images
 * move, and only onto Schonbek master products — a tray page assigned onto a
 * Dweled/MF row would silently cross brands.
 */
export function trayAssignError(
  image: { slot: string } | null,
  target: { found: boolean; slot?: string } | null,
): { error: string; status: 400 | 404 } | null {
  if (!image) return { error: "image not found", status: 404 };
  if (image.slot !== "schonbek_pdf") {
    return { error: "only Schonbek tray images can be reassigned", status: 400 };
  }
  if (target) {
    if (!target.found) return { error: "product not found", status: 404 };
    if (target.slot !== "schonbek_master") {
      return {
        error: "tray pages can only be assigned to Schonbek master products",
        status: 400,
      };
    }
  }
  return null;
}

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

  let target: { found: boolean; slot?: string } | null = null;
  if (parsed.data.product_id) {
    const { data: prod, error: perr } = await sb
      .from("desc_products")
      .select("id, slot")
      .eq("id", parsed.data.product_id)
      .maybeSingle();
    if (perr) return c.json({ error: perr.message }, 500);
    target = prod
      ? { found: true, slot: (prod as { slot: string }).slot }
      : { found: false };
  }

  const guard = trayAssignError(img as ImageRow | null, target);
  if (guard) return c.json({ error: guard.error }, guard.status);
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
// POST /tray/match — read the product name off each unassigned Schonbek tray
// page with Claude vision and auto-assign unambiguous matches. The pages are
// rasterized (pdf.js finds zero text items), so the name in large letters
// top-left is only readable from the rendered JPEG.
// ---------------------------------------------------------------------------

/** Vision-call cap per request; the client re-runs for a bigger tray. */
const TRAY_MATCH_LIMIT = 40;

export const TRAY_VISION_SYSTEM =
  "You read product names off rendered catalog slides for WAC Group. Respond with the name only.";
export const TRAY_VISION_USER =
  "Read the product name printed in large letters near the top-left of this slide. Return ONLY the name, or NONE if there is no name.";

/**
 * Pure response parser (unit-tested): trims wrapping quotes/punctuation,
 * folds NONE/empty to null, and rejects chatty answers that cannot be a
 * product name (too long / too many words).
 */
export function parseTrayVisionName(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/^["'`]+/, "")
    .replace(/["'`.]+$/, "")
    .trim();
  if (!cleaned) return null;
  if (/^none$/i.test(cleaned)) return null;
  if (cleaned.length > 60 || cleaned.split(/\s+/).length > 5) return null;
  return cleaned;
}

/**
 * Pure match resolution (unit-tested): the read name against the Schonbek
 * master products via the shared matcher (case-fold exact, then Levenshtein
 * ≤2 / prefix ≥5; every ambiguity stays unmatched — never guess).
 */
export function resolveTrayMatch(
  nameRead: string,
  products: readonly { id: string; content_key: string; name: string | null }[],
): { id: string; content_key: string; name: string | null } | null {
  const [match] = matchSupplementUnits(
    [{ name: nameRead, modelBases: [] as string[] }],
    products.map((p) => ({
      content_key: p.content_key,
      name: p.name,
      model_bases: [],
    })),
  );
  const key =
    match && match.content_keys.length === 1 ? match.content_keys[0]! : null;
  if (!key) return null;
  return products.find((p) => p.content_key === key) ?? null;
}

/** Workers-safe base64 (chunked so large JPEGs don't blow the arg limit). */
function base64FromBytes(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < arr.length; i += CHUNK) {
    binary += String.fromCharCode(...arr.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

descriptionsRoutes.post("/tray/match", async (c) => {
  if (!anthropicConfigured(c.env)) {
    return c.json(
      { error: "Claude is not configured (set the ANTHROPIC_API_KEY secret)" },
      503,
    );
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const [imgRes, prodRes] = await Promise.all([
    sb
      .from("desc_product_images")
      .select("id, r2_key")
      .eq("slot", "schonbek_pdf")
      .is("product_id", null) // existing assignments are never touched
      .order("sort_order", { ascending: true })
      .limit(1000),
    sb
      .from("desc_products")
      .select("id, content_key, name")
      .eq("slot", "schonbek_master")
      .limit(2000),
  ]);
  if (imgRes.error) return c.json({ error: imgRes.error.message }, 500);
  if (prodRes.error) return c.json({ error: prodRes.error.message }, 500);
  const allImages = (imgRes.data ?? []) as { id: string; r2_key: string }[];
  const products = (prodRes.data ?? []) as {
    id: string;
    content_key: string;
    name: string | null;
  }[];
  const images = allImages.slice(0, TRAY_MATCH_LIMIT);
  if (images.length === 0) {
    return c.json({ assigned: [], unreadable: 0, unmatched: [], errors: [], remaining: 0 });
  }
  if (products.length === 0) {
    return c.json({ error: "no Schonbek master products to match against" }, 400);
  }

  const model = claudeRouterModel(c.env);
  const assigned: {
    image: string;
    name: string;
    product: { id: string; content_key: string; name: string | null };
  }[] = [];
  const unmatched: { image: string; name_read: string }[] = [];
  const errors: { image: string; error: string }[] = [];
  let unreadable = 0;

  for (const img of images) {
    // Per-image isolation: one bad page (missing object, model hiccup) never
    // sinks the rest of the run.
    try {
      const obj = await c.env.ASSETS_BUCKET.get(img.r2_key);
      if (!obj) {
        unreadable++;
        continue;
      }
      const data = base64FromBytes(await obj.arrayBuffer());
      const mediaType = imageContentType(img.r2_key) as
        | "image/jpeg"
        | "image/png"
        | "image/webp";
      const res = await claudeMessages(c.env, {
        system: [{ type: "text", text: TRAY_VISION_SYSTEM }],
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data } },
              { type: "text", text: TRAY_VISION_USER },
            ],
          },
        ],
        model,
        maxTokens: 30,
      });
      const nameRead = parseTrayVisionName(claudeText(res));
      if (!nameRead) {
        unreadable++;
        continue;
      }
      const product = resolveTrayMatch(nameRead, products);
      if (!product) {
        unmatched.push({ image: img.r2_key, name_read: nameRead });
        continue;
      }
      const upd = await sb
        .from("desc_product_images")
        .update({ product_id: product.id })
        .eq("id", img.id)
        .is("product_id", null); // a concurrent manual assign wins
      if (upd.error) throw new Error(upd.error.message);
      assigned.push({ image: img.r2_key, name: nameRead, product });
    } catch (e) {
      errors.push({
        image: img.r2_key,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return c.json({
    assigned,
    unreadable,
    unmatched,
    errors,
    remaining: allImages.length - images.length,
  });
});

// ---------------------------------------------------------------------------
// PATCH /content/:target — save copy fields (Stage 3: title override; the
// route already accepts description/meta so the Stage 4 editors reuse it).
// desc_content rows are created lazily: a product may have no content row
// until its first save, so this endpoint upserts by (slot, content_key).
// ---------------------------------------------------------------------------

const ContentPatchSchema = z.object({
  action: z.enum(["save", "approve", "reopen"]),
  title_override: z.string().max(300).nullable().optional(),
  name_override: z.string().max(120).nullable().optional(),
  description: z.string().max(6000).nullable().optional(),
  meta: z.string().max(600).nullable().optional(),
});
type ContentPatch = z.infer<typeof ContentPatchSchema>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const norm = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/**
 * Pure field mapper for `action: "save"` (unit-tested): trims values, folds
 * empty strings to null, and bumps an untouched/generated row to `in_review`
 * only when the description or meta actually changed by hand. A title
 * override on its own never moves the status — status tracks the description
 * lifecycle (plan decision 11). Approved rows are LOCKED: every save
 * (including title overrides) is rejected until the row is reopened, so an
 * approval means exactly what was on screen when it was granted.
 */
export function applyContentSave(
  current: { status: DescContentStatus } | null,
  patch: Pick<ContentPatch, "title_override" | "name_override" | "description" | "meta">,
): { fields: Record<string, string | null>; error?: string } {
  const fields: Record<string, string | null> = {};
  if (patch.title_override !== undefined) {
    fields.title_override = norm(patch.title_override);
  }
  if (patch.name_override !== undefined) {
    // Like the title: a name correction never moves the review status.
    fields.name_override = norm(patch.name_override);
  }
  if (patch.description !== undefined) {
    fields.description_final = norm(patch.description);
  }
  if (patch.meta !== undefined) {
    fields.meta_final = norm(patch.meta);
  }
  if (Object.keys(fields).length === 0) {
    return { fields, error: "nothing to save" };
  }
  if (current?.status === "approved") {
    return { fields: {}, error: "this row is approved; reopen it before editing" };
  }
  const status = current?.status ?? "none";
  const editedCopy = !!(fields.description_final || fields.meta_final);
  if (editedCopy && (status === "none" || status === "generated")) {
    fields.status = "in_review";
  }
  return { fields };
}

/**
 * Pure field mapper for `action: "approve"` (unit-tested). Approval covers
 * the WHOLE row (description + meta + title — one status per row, plan
 * decision 11) and requires a non-empty effective description
 * (final ?? ai, after folding in any edits sent along with the approval —
 * the RomanceEditor "approve with edits" pattern).
 */
export function applyContentApprove(
  current: {
    status: DescContentStatus;
    description_ai: string | null;
    description_final: string | null;
  } | null,
  patch: Pick<ContentPatch, "title_override" | "name_override" | "description" | "meta">,
): { fields: Record<string, string | null>; error?: string } {
  const hasEdits =
    patch.title_override !== undefined ||
    patch.name_override !== undefined ||
    patch.description !== undefined ||
    patch.meta !== undefined;
  if (current?.status === "approved" && hasEdits) {
    // Approve-with-edits must not bypass the approved lock: an already
    // approved row only changes after an explicit reopen. A plain re-approve
    // (no fields) stays a harmless no-op.
    return {
      fields: {},
      error: "this row is already approved; reopen it before editing",
    };
  }
  const fields: Record<string, string | null> = {};
  if (patch.title_override !== undefined) {
    fields.title_override = norm(patch.title_override);
  }
  if (patch.name_override !== undefined) {
    fields.name_override = norm(patch.name_override);
  }
  if (patch.description !== undefined) {
    fields.description_final = norm(patch.description);
  }
  if (patch.meta !== undefined) {
    fields.meta_final = norm(patch.meta);
  }
  const description =
    patch.description !== undefined
      ? fields.description_final
      : (current?.description_final ?? current?.description_ai ?? null);
  if (!description) {
    return {
      fields: {},
      error: "nothing to approve; write or generate a description first",
    };
  }
  fields.status = "approved";
  return { fields };
}

/**
 * Resolve a PATCH/POST target to (slot, content_key): a desc_content id, a
 * desc_products id, or a bare content_key (must be unambiguous across
 * slots — keys are content-derived, so cross-slot collisions are possible
 * in principle).
 */
async function resolveContentTarget(
  sb: ReturnType<typeof userSupabase>,
  target: string,
): Promise<
  | { ok: true; slot: string; contentKey: string }
  | { ok: false; error: string; status: 400 | 404 | 500 }
> {
  if (UUID_RE.test(target)) {
    const { data: byContent, error: cErr } = await sb
      .from("desc_content")
      .select("slot, content_key")
      .eq("id", target)
      .maybeSingle();
    if (cErr) return { ok: false, error: cErr.message, status: 500 };
    if (byContent) {
      return {
        ok: true,
        slot: (byContent as { slot: string }).slot,
        contentKey: (byContent as { content_key: string }).content_key,
      };
    }
    const { data: byProduct, error: pErr } = await sb
      .from("desc_products")
      .select("slot, content_key")
      .eq("id", target)
      .maybeSingle();
    if (pErr) return { ok: false, error: pErr.message, status: 500 };
    if (byProduct) {
      return {
        ok: true,
        slot: (byProduct as { slot: string }).slot,
        contentKey: (byProduct as { content_key: string }).content_key,
      };
    }
    return { ok: false, error: "product not found", status: 404 };
  }
  const { data: byKey, error: kErr } = await sb
    .from("desc_products")
    .select("slot, content_key")
    .eq("content_key", target)
    .limit(2);
  if (kErr) return { ok: false, error: kErr.message, status: 500 };
  const hits = (byKey ?? []) as { slot: string; content_key: string }[];
  if (hits.length > 1) {
    return {
      ok: false,
      error: "content key exists in more than one slot; use the product id",
      status: 400,
    };
  }
  if (hits.length === 1) {
    return { ok: true, slot: hits[0]!.slot, contentKey: hits[0]!.content_key };
  }
  return { ok: false, error: "product not found", status: 404 };
}

descriptionsRoutes.patch("/content/:target", async (c) => {
  const parsed = ContentPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }

  const sb = userSupabase(c.env, c.get("jwt"));
  const resolved = await resolveContentTarget(sb, c.req.param("target"));
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  const { slot, contentKey } = resolved;

  const { data: existing, error: exErr } = await sb
    .from("desc_content")
    .select(CONTENT_COLS)
    .eq("slot", slot)
    .eq("content_key", contentKey)
    .maybeSingle();
  if (exErr) return c.json({ error: exErr.message }, 500);
  const current = existing as ContentRow | null;

  let fields: Record<string, string | null>;
  if (parsed.data.action === "approve") {
    const res = applyContentApprove(current, parsed.data);
    if (res.error) return c.json({ error: res.error }, 400);
    fields = { ...res.fields, reviewed_by: c.get("user").id };
  } else if (parsed.data.action === "reopen") {
    if (current?.status !== "approved") {
      return c.json({ error: "only approved rows can be reopened" }, 400);
    }
    fields = { status: "in_review", reviewed_by: c.get("user").id };
  } else {
    const res = applyContentSave(current, parsed.data);
    if (res.error) return c.json({ error: res.error }, 400);
    fields = res.fields;
  }

  if (current) {
    const { data: updated, error: uErr } = await sb
      .from("desc_content")
      .update(fields)
      .eq("id", current.id)
      .select(CONTENT_COLS)
      .single();
    if (uErr) return c.json({ error: uErr.message }, 500);
    return c.json({ content: updated });
  }
  const insertRow = { slot, content_key: contentKey, status: "none", ...fields };
  const { data: inserted, error: iErr } = await sb
    .from("desc_content")
    .insert(insertRow)
    .select(CONTENT_COLS)
    .single();
  if (iErr && iErr.code === "23505") {
    // Lost a create race — fall back to updating the row that beat us.
    const { data: updated, error: rErr } = await sb
      .from("desc_content")
      .update(fields)
      .eq("slot", slot)
      .eq("content_key", contentKey)
      .select(CONTENT_COLS)
      .single();
    if (rErr) return c.json({ error: rErr.message }, 500);
    return c.json({ content: updated });
  }
  if (iErr) return c.json({ error: iErr.message }, 500);
  return c.json({ content: inserted }, 201);
});

// ---------------------------------------------------------------------------
// Orphan management (Stage 5) — POST /content/:id/attach, DELETE /content/:id
// Orphans are desc_content rows whose (slot, content_key) no longer matches a
// product after a re-import. Attach moves the preserved copy onto a chosen
// product of the SAME slot; delete discards a draft the user is sure about.
// ---------------------------------------------------------------------------

const AttachContentSchema = z.object({
  content_key: z.string().min(1).max(200),
});

/** True when a content row holds no text and no review state at all — a
 * placeholder created by a stray save, safe to replace during an attach. */
function contentRowEmpty(row: {
  status: string;
  description_ai: string | null;
  description_final: string | null;
  meta_ai: string | null;
  meta_final: string | null;
  title_override: string | null;
  name_override?: string | null;
}): boolean {
  return (
    row.status === "none" &&
    !row.description_ai &&
    !row.description_final &&
    !row.meta_ai &&
    !row.meta_final &&
    !row.title_override &&
    !row.name_override
  );
}

/**
 * Pure guard for orphan attach (unit-tested). Rules: the source content row
 * must exist and actually be an orphan (its own product is gone), the target
 * key must belong to a product in the SAME slot, and the target must not
 * already hold copy — an empty placeholder row is replaced, anything with
 * text or review state rejects with a clear error (plan Stage 5 merge rule).
 */
export function attachContentError(
  content: { content_key: string } | null,
  sourceProductExists: boolean,
  targetProduct: { content_key: string } | null,
  targetContent: Parameters<typeof contentRowEmpty>[0] | null,
):
  | { error: string; status: 400 | 404 | 409 }
  | { ok: true; replaceEmptyTarget: boolean } {
  if (!content) return { error: "content row not found", status: 404 };
  if (sourceProductExists) {
    return {
      error:
        "this copy is still attached to a product; only orphaned copy can be moved",
      status: 400,
    };
  }
  if (!targetProduct) {
    return {
      error: "no product with that key in this file; pick one from the list",
      status: 404,
    };
  }
  if (targetProduct.content_key === content.content_key) {
    return { error: "the copy is already attached to that product", status: 400 };
  }
  if (targetContent && !contentRowEmpty(targetContent)) {
    return {
      error:
        "the target product already has copy of its own; edit or delete that copy first",
      status: 409,
    };
  }
  return { ok: true, replaceEmptyTarget: !!targetContent };
}

descriptionsRoutes.post("/content/:id/attach", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "content row not found" }, 404);
  const parsed = AttachContentSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }

  const sb = userSupabase(c.env, c.get("jwt"));
  const { data: row, error } = await sb
    .from("desc_content")
    .select(CONTENT_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  const content = row as ContentRow | null;

  let sourceProductExists = false;
  let targetProduct: { content_key: string } | null = null;
  let targetContent: ContentRow | null = null;
  if (content) {
    const [srcRes, tgtRes, tgtContentRes] = await Promise.all([
      sb
        .from("desc_products")
        .select("id")
        .eq("slot", content.slot)
        .eq("content_key", content.content_key)
        .maybeSingle(),
      sb
        .from("desc_products")
        .select("content_key")
        .eq("slot", content.slot)
        .eq("content_key", parsed.data.content_key)
        .maybeSingle(),
      sb
        .from("desc_content")
        .select(CONTENT_COLS)
        .eq("slot", content.slot)
        .eq("content_key", parsed.data.content_key)
        .maybeSingle(),
    ]);
    for (const res of [srcRes, tgtRes, tgtContentRes]) {
      if (res.error) return c.json({ error: res.error.message }, 500);
    }
    sourceProductExists = !!srcRes.data;
    targetProduct = tgtRes.data as { content_key: string } | null;
    targetContent = tgtContentRes.data as ContentRow | null;
  }

  const guard = attachContentError(
    content,
    sourceProductExists,
    targetProduct,
    targetContent,
  );
  if ("error" in guard) return c.json({ error: guard.error }, guard.status);

  // The empty placeholder on the target (if any) must vanish before the move
  // or unique(slot, content_key) rejects the update. RLS delete is admin-only
  // by design, so this single surgical delete runs on the service role after
  // the guard proved the row holds no work at all.
  if (guard.replaceEmptyTarget && targetContent) {
    const admin = serviceSupabase(c.env);
    const del = await admin.from("desc_content").delete().eq("id", targetContent.id);
    if (del.error) return c.json({ error: del.error.message }, 500);
  }

  const { data: updated, error: uErr } = await sb
    .from("desc_content")
    .update({ content_key: parsed.data.content_key, note: null })
    .eq("id", id)
    .select(CONTENT_COLS)
    .single();
  if (uErr) return c.json({ error: uErr.message }, 500);
  return c.json({ content: updated });
});

descriptionsRoutes.delete("/content/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "content row not found" }, 404);
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data: row, error } = await sb
    .from("desc_content")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!row) return c.json({ error: "content row not found" }, 404);
  const status = (row as { status: string }).status;
  if (status === "approved" && c.req.query("confirm") !== "approved") {
    return c.json(
      {
        error:
          "this copy is approved; deleting it needs an explicit confirmation (confirm=approved)",
      },
      400,
    );
  }
  // RLS restricts DELETE to admins; the endpoint is for every internal user
  // (plan Stage 5), so the delete itself runs on the service role after the
  // user-client read above proved visibility + the approved confirm.
  const admin = serviceSupabase(c.env);
  const del = await admin.from("desc_content").delete().eq("id", id);
  if (del.error) return c.json({ error: del.error.message }, 500);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /products/delete — remove products (and their images + copy) outright.
// Explicit user deletion, confirmed client-side: unlike a re-import, this
// deletes desc_content rows of ANY status. A master re-import recreates the
// products wholesale, so nothing here is unrecoverable beyond the copy.
// ---------------------------------------------------------------------------

const DeleteProductsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(400),
});

/**
 * Pure planner for POST /products/delete (unit-tested): requires at least one
 * requested product to exist, reports how many ids were unknown (stale client
 * state after a re-import), and groups the doomed (slot, content_key) pairs
 * per slot so the copy delete runs as one IN-list per slot.
 */
export function deleteProductsPlan(
  requested: string[],
  found: { id: string; slot: string; content_key: string }[],
):
  | { error: string; status: 404 }
  | { keysBySlot: Map<string, string[]>; missing: number } {
  if (found.length === 0) {
    return { error: "no matching products found", status: 404 };
  }
  const keysBySlot = new Map<string, string[]>();
  for (const p of found) {
    const list = keysBySlot.get(p.slot) ?? [];
    list.push(p.content_key);
    keysBySlot.set(p.slot, list);
  }
  return { keysBySlot, missing: requested.length - found.length };
}

descriptionsRoutes.post("/products/delete", async (c) => {
  const parsed = DeleteProductsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const ids = [...new Set(parsed.data.ids)];
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("desc_products")
    .select("id, slot, content_key")
    .in("id", ids);
  if (error) return c.json({ error: error.message }, 500);
  const found = (data ?? []) as { id: string; slot: string; content_key: string }[];
  const plan = deleteProductsPlan(ids, found);
  if ("error" in plan) return c.json({ error: plan.error }, plan.status);

  // RLS restricts DELETE to admins; the deletes run on the service role after
  // the user-client read above proved visibility. Image rows are deleted
  // EXPLICITLY — the ON DELETE SET NULL FK would otherwise drop the deleted
  // products' renders into the unassigned tray as ghosts. R2 objects stay
  // (content-hash keys are shared/deduped across imports).
  const admin = serviceSupabase(c.env);
  const foundIds = found.map((p) => p.id);
  const delImgs = await admin
    .from("desc_product_images")
    .delete()
    .in("product_id", foundIds)
    .select("id");
  if (delImgs.error) return c.json({ error: delImgs.error.message }, 500);

  let contentDeleted = 0;
  for (const [slot, keys] of plan.keysBySlot) {
    const delContent = await admin
      .from("desc_content")
      .delete()
      .eq("slot", slot)
      .in("content_key", keys)
      .select("id");
    if (delContent.error) return c.json({ error: delContent.error.message }, 500);
    contentDeleted += (delContent.data ?? []).length;
  }

  const delProducts = await admin
    .from("desc_products")
    .delete()
    .in("id", foundIds)
    .select("id");
  if (delProducts.error) return c.json({ error: delProducts.error.message }, 500);

  return c.json({
    deleted: (delProducts.data ?? []).length,
    images: (delImgs.data ?? []).length,
    content: contentDeleted,
    missing: plan.missing,
    ids: foundIds,
  });
});

// ---------------------------------------------------------------------------
// Generation — POST /generate, POST /regenerate-meta, POST /bulk-approve
// (plan decisions 7/8/11)
// ---------------------------------------------------------------------------

const GenerateSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(6),
  /** Openings produced by earlier chunks of the same client run, threaded
   * through so a 40-product batch stays self-diversifying across requests. */
  priorOpenings: z.array(z.string().max(200)).max(24).default([]),
  /** Opening words of metas from earlier chunks — same threading, so meta
   * verbs keep varying across request boundaries. */
  priorMetaOpenings: z.array(z.string().max(60)).max(24).default([]),
  /** False (batch default): rows holding manual edits (description_final or
   * meta_final) are skipped per-id so a batch never silently buries human
   * work. True (per-row Regenerate after an explicit confirm): the edits are
   * CLEARED so the fresh AI copy is actually visible (final ?? ai). */
  overwriteEdits: z.boolean().default(false),
});

const RegenerateMetaSchema = z.object({ id: z.string().uuid() });

const BulkApproveSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(400),
});

interface GenerateResult {
  id: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  description?: string;
  meta?: string;
  /** firstSentence of the generated description — the client threads these
   * into the next chunk's priorOpenings. */
  opening?: string;
  /** First word of the generated meta — threads into priorMetaOpenings. */
  metaOpening?: string;
  content?: ContentRow;
}

/** First whitespace-delimited word (meta opening verb) — avoid-list entry. */
function firstWord(text: string): string {
  return text.trim().split(/\s+/)[0] ?? "";
}

/**
 * Pure profile picker (unit-tested): exact brand+collection match first, then
 * any same-brand profile (seed order preferred) as the brand fallback.
 */
export function pickVoiceProfile<
  T extends { brand: string; collection: string },
>(profiles: readonly T[], brand: string, collection: string): T | null {
  const b = brand.trim().toLowerCase();
  const col = collection.trim().toLowerCase();
  const exact = profiles.find(
    (p) => p.brand.toLowerCase() === b && p.collection.toLowerCase() === col,
  );
  if (exact) return exact;
  const sameBrand = profiles
    .filter((p) => p.brand.toLowerCase() === b)
    .sort(
      (x, y) =>
        (VOICE_ORDER.get(`${x.brand}|${x.collection}`) ?? 99) -
        (VOICE_ORDER.get(`${y.brand}|${y.collection}`) ?? 99),
    );
  return sameBrand[0] ?? null;
}

async function sha256HexText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  return sha256Hex(bytes.buffer as ArrayBuffer);
}

/** Concatenated text blocks of a Claude response, trimmed. */
function claudeText(res: { content: { type: string }[] }): string {
  return (res.content as ({ type: string } & { text?: string })[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();
}

/** The effective HTML title (override ?? formula) used for meta keywording. */
/** Product with the editor's corrected name (0073) folded in — feeds the
 * title formula and the generation fact sheet so the corrected name is what
 * the copy talks about. */
function withNameOverride(
  product: ProductRow,
  content: ContentRow | null,
): ProductRow {
  return content?.name_override
    ? { ...product, name: content.name_override }
    : product;
}

function effectiveTitle(product: ProductRow, content: ContentRow | null): string {
  const p = withNameOverride(product, content);
  return (
    content?.title_override ??
    titleFor({
      brand: p.brand,
      collection: p.collection,
      name: p.name,
      productType: p.product_type,
      modelBases: p.model_bases,
    })
  );
}

/**
 * One meta call with a single corrective retry in EITHER direction: under the
 * 50-char floor → ask for a fuller meta; over the 160 cap → ask for a
 * shorter one with complete sentences. Whatever remains over-length after the
 * retry is clamped by clampMetaDescription (last complete sentence that
 * fits, else word-boundary cut with no dangling conjunction) so a persisted
 * meta never ends mid-fragment. Returns the built prompt too, so the caller
 * can fold it into prompt_hash.
 */
async function generateMetaText(
  env: Ctx["env"],
  product: ProductRow,
  title: string,
  description: string,
  avoidMetas: readonly string[],
): Promise<{ meta: string; prompt: ReturnType<typeof buildMetaPrompt> }> {
  const prompt = buildMetaPrompt({ product, title, description, avoidMetas });
  const opts = {
    system: prompt.system,
    messages: [{ role: "user" as const, content: prompt.user }],
    model: claudeModel(env),
    maxTokens: 250,
  };
  const retryWith = async (complaint: string): Promise<string> =>
    claudeText(
      await claudeMessages(env, {
        ...opts,
        messages: [
          { role: "user" as const, content: `${prompt.user}\n\n${complaint}` },
        ],
      }),
    );

  let meta = claudeText(await claudeMessages(env, opts));
  if (meta.length < DESC_META_RANGE.min) {
    const second = await retryWith(
      `Your previous attempt ("${meta}") was under ${DESC_META_RANGE.min} characters. Write a fuller meta description between ${DESC_META_RANGE.min} and ${DESC_META_RANGE.max} characters.`,
    );
    if (second.length >= meta.length) meta = second;
  } else if (meta.length > DESC_META_RANGE.max) {
    const second = await retryWith(
      `Your previous attempt ("${meta}") was too long at ${meta.length} characters. Shorten it to under ${DESC_META_RANGE.max} characters, complete sentences only.`,
    );
    if (second && second.length < meta.length) meta = second;
  }
  return { meta: clampMetaDescription(meta), prompt };
}

/**
 * Upsert the generated copy by (slot, content_key), racing-insert safe.
 * Updates carry a `.neq(status, approved)` guard so a row approved BETWEEN
 * the eligibility check and this write is never clobbered (TOCTOU); a null
 * return means exactly that — the caller reports it as an approved-skip.
 */
async function persistGenerated(
  sb: ReturnType<typeof userSupabase>,
  product: ProductRow,
  current: ContentRow | null,
  fields: Record<string, string | null>,
): Promise<ContentRow | null> {
  if (current) {
    const { data, error } = await sb
      .from("desc_content")
      .update(fields)
      .eq("id", current.id)
      .neq("status", "approved")
      .select(CONTENT_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as ContentRow | null) ?? null;
  }
  const { data, error } = await sb
    .from("desc_content")
    .insert({ slot: product.slot, content_key: product.content_key, ...fields })
    .select(CONTENT_COLS)
    .single();
  if (error && error.code === "23505") {
    const { data: updated, error: rErr } = await sb
      .from("desc_content")
      .update(fields)
      .eq("slot", product.slot)
      .eq("content_key", product.content_key)
      .neq("status", "approved")
      .select(CONTENT_COLS)
      .maybeSingle();
    if (rErr) throw new Error(rErr.message);
    return (updated as ContentRow | null) ?? null;
  }
  if (error) throw new Error(error.message);
  return data as ContentRow;
}

/** The 8 most recent generated openings (description first sentences) and
 * meta opening words in the product's brand+collection. desc_content has no
 * FK to desc_products, so keys resolve through the sibling products'
 * (slot, content_key) pairs. */
async function recentSiblingOpenings(
  sb: ReturnType<typeof userSupabase>,
  product: ProductRow,
): Promise<{ openings: string[]; metaOpenings: string[] }> {
  const { data: keyRows, error: kErr } = await sb
    .from("desc_products")
    .select("content_key")
    .eq("slot", product.slot)
    .eq("brand", product.brand)
    .eq("collection", product.collection)
    .limit(500);
  if (kErr) throw new Error(kErr.message);
  const keys = ((keyRows ?? []) as { content_key: string }[]).map(
    (r) => r.content_key,
  );
  if (keys.length === 0) return { openings: [], metaOpenings: [] };
  const { data: recent, error: rErr } = await sb
    .from("desc_content")
    .select("description_ai, meta_ai, generated_at")
    .eq("slot", product.slot)
    .in("content_key", keys)
    .not("generated_at", "is", null)
    .order("generated_at", { ascending: false })
    .limit(8);
  if (rErr) throw new Error(rErr.message);
  const rows = (recent ?? []) as {
    description_ai: string | null;
    meta_ai: string | null;
  }[];
  return {
    openings: rows
      .map((r) => firstSentence(r.description_ai ?? ""))
      .filter(Boolean),
    metaOpenings: rows.map((r) => firstWord(r.meta_ai ?? "")).filter(Boolean),
  };
}

descriptionsRoutes.post("/generate", async (c) => {
  const parsed = GenerateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  if (!anthropicConfigured(c.env)) {
    return c.json(
      { error: "Claude is not configured (set the ANTHROPIC_API_KEY secret)" },
      503,
    );
  }
  const sb = userSupabase(c.env, c.get("jwt"));

  const [prodRes, profRes] = await Promise.all([
    sb.from("desc_products").select(PRODUCT_COLS).in("id", parsed.data.ids),
    sb.from("desc_voice_profiles").select(VOICE_COLS).limit(50),
  ]);
  if (prodRes.error) return c.json({ error: prodRes.error.message }, 500);
  if (profRes.error) return c.json({ error: profRes.error.message }, 500);
  const byId = new Map(
    ((prodRes.data ?? []) as unknown as ProductRow[]).map((p) => [p.id, p]),
  );
  const profiles = (profRes.data ?? []) as VoiceRow[];
  const model = claudeModel(c.env);

  const results: GenerateResult[] = [];
  // Openings/metas produced in THIS request — product N avoids its N-1
  // siblings' openings even before anything is persisted.
  const runOpenings: string[] = [];
  const runMetas: string[] = [];

  for (const id of parsed.data.ids) {
    const product = byId.get(id);
    if (!product) {
      results.push({ id, ok: false, error: "product not found" });
      continue;
    }
    try {
      const { data: contentRow, error: cErr } = await sb
        .from("desc_content")
        .select(CONTENT_COLS)
        .eq("slot", product.slot)
        .eq("content_key", product.content_key)
        .maybeSingle();
      if (cErr) throw new Error(cErr.message);
      const current = contentRow as ContentRow | null;
      if (current?.status === "approved") {
        results.push({
          id,
          ok: false,
          skipped: true,
          error: "approved; reopen the row to regenerate",
        });
        continue;
      }
      const hasManualEdits = !!(
        current?.description_final || current?.meta_final
      );
      if (hasManualEdits && !parsed.data.overwriteEdits) {
        // A batch run must never bury human edits under fresh AI text (the
        // UI shows final ?? ai, so the new copy would be invisible anyway).
        // The per-row Regenerate button opts in via overwriteEdits.
        results.push({
          id,
          ok: false,
          skipped: true,
          error: "has manual edits; use the row's Regenerate to overwrite them",
        });
        continue;
      }

      const profile = pickVoiceProfile(
        profiles,
        product.brand,
        product.collection,
      );
      if (!profile) {
        results.push({
          id,
          ok: false,
          error: `no voice profile for brand "${product.brand}"`,
        });
        continue;
      }

      // Reference romance copy for the profile's picked products (missing
      // SKUs are silently skipped — the PIM sync may lag the picker).
      let referenceCopy: { name: string; copy: string }[] = [];
      if (profile.reference_skus.length > 0) {
        const { data: refRows, error: refErr } = await sb
          .from("products")
          .select("sku, name, raw_json")
          // PIM SKUs are uppercase; legacy profiles may hold pasted lowercase.
          .in("sku", profile.reference_skus.slice(0, 5).map((s) => s.toUpperCase()));
        if (refErr) throw new Error(refErr.message);
        referenceCopy = (
          (refRows ?? []) as {
            sku: string;
            name: string;
            raw_json: Record<string, unknown> | null;
          }[]
        )
          .map((p) => ({
            name: p.name,
            copy:
              extractExistingCopy(
                p.raw_json ?? {},
                c.env.SALES_LAYER_ROMANCE_FIELD,
              ) ?? "",
          }))
          .filter((r) => !!r.copy);
      }

      const siblings = await recentSiblingOpenings(sb, product);
      const avoidOpenings = [
        ...new Set([
          ...siblings.openings,
          ...parsed.data.priorOpenings,
          ...runOpenings,
        ]),
      ].slice(-32);
      const avoidMetas = [
        ...new Set([
          ...siblings.metaOpenings,
          ...parsed.data.priorMetaOpenings,
          ...runMetas,
        ]),
      ].slice(-32);

      const prompt = buildDescriptionPrompt({
        profile,
        product: withNameOverride(product, current),
        referenceCopy,
        avoidOpenings,
        // Rotation keyed to run position so chunked client batches keep
        // advancing instead of restarting at seed 0 every request.
        structureSeed: structureSeed(
          parsed.data.priorOpenings.length + runOpenings.length,
        ),
      });
      const res = await claudeMessages(c.env, {
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        model,
        maxTokens: 700,
      });
      const description = claudeText(res);
      if (!description) throw new Error("Claude returned an empty description");

      const title = effectiveTitle(product, current);
      const { meta, prompt: metaPrompt } = await generateMetaText(
        c.env,
        withNameOverride(product, current),
        title,
        description,
        avoidMetas,
      );

      // The hash covers BOTH assembled prompts, so the stored hash always
      // matches the stored description AND meta.
      const promptHash = await sha256HexText(
        JSON.stringify({ description: prompt, meta: metaPrompt }),
      );
      const fields: Record<string, string | null> = {
        description_ai: description,
        meta_ai: meta,
        status: "generated",
        model,
        prompt_hash: promptHash,
        generated_at: new Date().toISOString(),
      };
      if (parsed.data.overwriteEdits && hasManualEdits) {
        // The row's editor confirmed the overwrite: clear the stale human
        // edits so the fresh AI copy is what final ?? ai resolves to.
        fields.description_final = null;
        fields.meta_final = null;
      }
      const saved = await persistGenerated(sb, product, current, fields);
      if (!saved) {
        results.push({
          id,
          ok: false,
          skipped: true,
          error: "approved while generating; nothing was overwritten",
        });
        continue;
      }

      const opening = firstSentence(description);
      runOpenings.push(opening);
      runMetas.push(meta);
      results.push({
        id,
        ok: true,
        description,
        meta,
        opening,
        metaOpening: firstWord(meta),
        content: saved,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id, ok: false, error: msg });
    }
  }

  return c.json({ results });
});

descriptionsRoutes.post("/regenerate-meta", async (c) => {
  const parsed = RegenerateMetaSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  if (!anthropicConfigured(c.env)) {
    return c.json(
      { error: "Claude is not configured (set the ANTHROPIC_API_KEY secret)" },
      503,
    );
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const resolved = await resolveContentTarget(sb, parsed.data.id);
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);

  const { data: prodRow, error: pErr } = await sb
    .from("desc_products")
    .select(PRODUCT_COLS)
    .eq("slot", resolved.slot)
    .eq("content_key", resolved.contentKey)
    .maybeSingle();
  if (pErr) return c.json({ error: pErr.message }, 500);
  const product = prodRow as unknown as ProductRow | null;
  if (!product) return c.json({ error: "product not found" }, 404);

  const { data: contentRow, error: cErr } = await sb
    .from("desc_content")
    .select(CONTENT_COLS)
    .eq("slot", resolved.slot)
    .eq("content_key", resolved.contentKey)
    .maybeSingle();
  if (cErr) return c.json({ error: cErr.message }, 500);
  const current = contentRow as ContentRow | null;
  if (current?.status === "approved") {
    return c.json({ error: "this row is approved; reopen it first" }, 400);
  }
  // The CURRENT description feeds the meta — a human edit (description_final)
  // wins over the AI draft, so regenerate-meta after editing "just works".
  const description = current?.description_final ?? current?.description_ai;
  if (!description) {
    return c.json(
      { error: "no description yet; generate or write one first" },
      400,
    );
  }

  try {
    // Sibling meta opening verbs keep single-row regenerations from echoing
    // the collection's recent metas.
    const siblings = await recentSiblingOpenings(sb, product);
    const { meta, prompt: metaPrompt } = await generateMetaText(
      c.env,
      withNameOverride(product, current),
      effectiveTitle(product, current),
      description,
      siblings.metaOpenings,
    );
    const fields: Record<string, string | null> = {
      meta_ai: meta,
      model: claudeModel(c.env),
      // Meta-only regeneration: the stored hash must match the stored meta.
      prompt_hash: await sha256HexText(JSON.stringify({ meta: metaPrompt })),
      generated_at: new Date().toISOString(),
    };
    // A none-status row becomes generated; edited/generated statuses stay.
    if (!current || current.status === "none") fields.status = "generated";
    const saved = await persistGenerated(sb, product, current, fields);
    if (!saved) {
      return c.json(
        { error: "this row was approved while generating; reopen it first" },
        409,
      );
    }
    return c.json({ content: saved, meta });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      502,
    );
  }
});

descriptionsRoutes.post("/bulk-approve", async (c) => {
  const parsed = BulkApproveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data: prodData, error: pErr } = await sb
    .from("desc_products")
    .select("id, slot, content_key")
    .in("id", parsed.data.ids);
  if (pErr) return c.json({ error: pErr.message }, 500);
  const products = (prodData ?? []) as {
    id: string;
    slot: string;
    content_key: string;
  }[];

  // Content rows resolve per slot (no FK — mirror the GET / join).
  const bySlot = new Map<string, string[]>();
  for (const p of products) {
    const list = bySlot.get(p.slot) ?? [];
    list.push(p.content_key);
    bySlot.set(p.slot, list);
  }
  const contentByKey = new Map<string, ContentRow>();
  for (const [slot, keys] of bySlot) {
    const { data, error } = await sb
      .from("desc_content")
      .select(CONTENT_COLS)
      .eq("slot", slot)
      .in("content_key", keys);
    if (error) return c.json({ error: error.message }, 500);
    for (const row of (data ?? []) as ContentRow[]) {
      contentByKey.set(`${row.slot} ${row.content_key}`, row);
    }
  }

  // Mirror productinfo bulk semantics: approve generated/in_review rows that
  // actually hold a description; everything else (none, approved, empty) is
  // skipped, never errored.
  let approved = 0;
  let skipped = 0;
  for (const p of products) {
    const row = contentByKey.get(`${p.slot} ${p.content_key}`) ?? null;
    const description = row?.description_final ?? row?.description_ai ?? null;
    const eligible =
      row &&
      (row.status === "generated" || row.status === "in_review") &&
      !!description;
    if (!row || !eligible) {
      skipped++;
      continue;
    }
    const { error } = await sb
      .from("desc_content")
      .update({ status: "approved", reviewed_by: c.get("user").id })
      .eq("id", row.id);
    if (error) skipped++;
    else approved++;
  }
  // Unknown ids (stale selection after a re-import) count as skipped too.
  skipped += parsed.data.ids.length - products.length;
  return c.json({ approved, skipped });
});

// ---------------------------------------------------------------------------
// Voice profiles — GET /voice, PUT /voice/:id, POST /voice/:id/reset,
// POST /voice/derive (draft only; NEVER auto-saves)
// ---------------------------------------------------------------------------

const VOICE_COLS =
  "id, brand, collection, prompt, voice_guidance, reference_skus, updated_by, updated_at";

interface VoiceRow {
  id: string;
  brand: string;
  collection: string;
  prompt: string;
  voice_guidance: string;
  reference_skus: string[];
  updated_by: string | null;
  updated_at: string;
}

/** Tab order = the seeded defaults order (unknown rows sort last). */
const VOICE_ORDER = new Map(
  DESC_VOICE_DEFAULTS.map((d, i) => [`${d.brand}|${d.collection}`, i]),
);

const VoicePutSchema = z.object({
  prompt: z.string().trim().min(1, "prompt must not be empty").max(8000),
  voice_guidance: z.string().trim().max(8000).default(""),
  reference_skus: z
    .array(z.string().trim().min(1, "reference SKUs must not be empty").max(60))
    .max(5, "at most 5 reference products"),
});

/** Case-insensitive de-dup of reference SKUs, first occurrence wins
 * (unit-tested) — the UI caps at 5, but a pasted duplicate must not burn a
 * reference slot server-side. */
export function dedupSkus(skus: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sku of skus) {
    const key = sku.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sku);
  }
  return out;
}

function voiceJson(row: VoiceRow, email: string | null) {
  return {
    id: row.id,
    brand: row.brand,
    collection: row.collection,
    prompt: row.prompt,
    voice_guidance: row.voice_guidance,
    reference_skus: row.reference_skus,
    updated_at: row.updated_at,
    updated_by_email: email,
  };
}

descriptionsRoutes.get("/voice", async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("desc_voice_profiles")
    .select(VOICE_COLS)
    .limit(50);
  if (error) return c.json({ error: error.message }, 500);
  const rows = ((data ?? []) as VoiceRow[]).slice().sort((a, b) => {
    const ai = VOICE_ORDER.get(`${a.brand}|${a.collection}`) ?? 99;
    const bi = VOICE_ORDER.get(`${b.brand}|${b.collection}`) ?? 99;
    return ai - bi || a.brand.localeCompare(b.brand) || a.collection.localeCompare(b.collection);
  });
  const emails = await emailsForUserIds(
    c.env,
    rows.map((r) => r.updated_by ?? "").filter(Boolean),
  );
  return c.json({
    profiles: rows.map((r) =>
      voiceJson(r, r.updated_by ? (emails.get(r.updated_by) ?? null) : null),
    ),
  });
});

descriptionsRoutes.put("/voice/:id", async (c) => {
  const parsed = VoicePutSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("desc_voice_profiles")
    .update({
      prompt: parsed.data.prompt,
      voice_guidance: parsed.data.voice_guidance,
      // Normalized to uppercase (PIM SKUs are uppercase) so generation-time
      // romance lookups always resolve, then de-duped.
      reference_skus: dedupSkus(
        parsed.data.reference_skus.map((s) => s.toUpperCase()),
      ),
      updated_by: c.get("user").id,
    })
    .eq("id", c.req.param("id"))
    .select(VOICE_COLS)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "voice profile not found" }, 404);
  return c.json({ profile: voiceJson(data as VoiceRow, c.get("user").email) });
});

descriptionsRoutes.post("/voice/:id/reset", async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data: row, error } = await sb
    .from("desc_voice_profiles")
    .select(VOICE_COLS)
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!row) return c.json({ error: "voice profile not found" }, 404);
  const profile = row as VoiceRow;
  const seed = DESC_VOICE_DEFAULTS.find(
    (d) => d.brand === profile.brand && d.collection === profile.collection,
  );
  if (!seed) {
    return c.json({ error: "this profile has no seeded default" }, 400);
  }
  // Reset restores the seeded TEXT only; the picked reference products are
  // the editor's and survive a text reset.
  const { data: updated, error: uErr } = await sb
    .from("desc_voice_profiles")
    .update({
      prompt: seed.prompt,
      voice_guidance: seed.voice_guidance,
      updated_by: c.get("user").id,
    })
    .eq("id", profile.id)
    .select(VOICE_COLS)
    .single();
  if (uErr) return c.json({ error: uErr.message }, 500);
  return c.json({ profile: voiceJson(updated as VoiceRow, c.get("user").email) });
});

const VoiceDeriveSchema = z.object({
  brand: z.string().trim().min(1).max(60),
  collection: z.string().trim().min(1).max(60),
});

/** ilike pattern matching a voice-profile brand against the PIM's brand
 * strings (which drift: "WAC", "dwelLED", "Modern Forms Fans"…). */
export function brandLikePattern(brand: string): string {
  const word = brand.trim().split(/\s+/)[0] ?? brand;
  return `%${word}%`;
}

/**
 * Pure prompt builder for voice derivation (unit-tested): asks for a ~120
 * word voice profile from the references' existing romance copy. Draft only —
 * the caller returns it to the editor and never persists it.
 */
export function buildVoiceDeriveMessages(
  brand: string,
  collection: string,
  refs: { sku: string; name: string; copy: string }[],
): { system: string; user: string } {
  const system =
    "You are a senior brand copywriter at WAC Group. You analyze existing product copy and describe the brand voice so another writer can match it.";
  const blocks = refs
    .map((r) => `${r.name} (${r.sku}):\n${r.copy.slice(0, 1200)}`)
    .join("\n\n");
  const user = [
    `Existing ${brand} ${collection} product copy:`,
    blocks,
    "Describe this brand's copywriting voice in about 120 words: vocabulary, sentence rhythm, and what it never says. Write plain-text guidance addressed to a copywriter, no headings or lists. Do not use em dashes. When referring to the company, always write WAC Group, never WAC alone.",
  ].join("\n\n");
  return { system, user };
}

descriptionsRoutes.post("/voice/derive", async (c) => {
  const parsed = VoiceDeriveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  if (!anthropicConfigured(c.env)) {
    return c.json(
      { error: "Claude is not configured (set the ANTHROPIC_API_KEY secret)" },
      503,
    );
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data: row, error } = await sb
    .from("desc_voice_profiles")
    .select(VOICE_COLS)
    .eq("brand", parsed.data.brand)
    .eq("collection", parsed.data.collection)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!row) return c.json({ error: "voice profile not found" }, 404);
  const profile = row as VoiceRow;

  interface PimRow {
    sku: string;
    name: string;
    raw_json: Record<string, unknown> | null;
  }
  let pimRows: PimRow[] = [];
  if (profile.reference_skus.length > 0) {
    const { data: refRows, error: rErr } = await sb
      .from("products")
      .select("sku, name, raw_json")
      // PIM SKUs are uppercase; legacy profiles may hold pasted lowercase.
      .in("sku", profile.reference_skus.slice(0, 5).map((s) => s.toUpperCase()));
    if (rErr) return c.json({ error: rErr.message }, 500);
    pimRows = (refRows ?? []) as PimRow[];
  }
  let usedFallback = false;
  if (pimRows.length === 0) {
    // No saved references (or none resolve): fall back to the most recently
    // synced same-brand products that carry romance copy.
    usedFallback = true;
    const { data: fbRows, error: fErr } = await sb
      .from("products")
      .select("sku, name, raw_json")
      .ilike("brand", brandLikePattern(profile.brand))
      .order("synced_at", { ascending: false })
      .limit(40);
    if (fErr) return c.json({ error: fErr.message }, 500);
    pimRows = (fbRows ?? []) as PimRow[];
  }

  const refs = pimRows
    .map((p) => ({
      sku: p.sku,
      name: p.name,
      copy: extractExistingCopy(p.raw_json ?? {}, c.env.SALES_LAYER_ROMANCE_FIELD),
    }))
    .filter((r): r is { sku: string; name: string; copy: string } => !!r.copy)
    .slice(0, 8);
  if (refs.length === 0) {
    return c.json(
      {
        error:
          "No existing copy found for these references. Pick reference products that already have descriptions, save, and try again.",
      },
      400,
    );
  }

  const { system, user } = buildVoiceDeriveMessages(
    profile.brand,
    profile.collection,
    refs,
  );
  const res = await claudeMessages(c.env, {
    system: [{ type: "text", text: system }],
    messages: [{ role: "user", content: user }],
    model: claudeModel(c.env),
    maxTokens: 500,
  });
  const draft = res.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!draft) return c.json({ error: "Claude returned an empty draft" }, 502);
  // Draft only: the editor reviews it in the guidance textarea and saves
  // explicitly — this endpoint never writes to desc_voice_profiles.
  return c.json({
    draft,
    reference_skus: refs.map((r) => r.sku),
    used_fallback: usedFallback,
  });
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
      .select(
        "content_key, status, description_ai, description_final, meta_final, title_override, name_override",
      )
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
    description_ai: string | null;
    description_final: string | null;
    meta_final: string | null;
    title_override: string | null;
    name_override: string | null;
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
    // Content rows carrying a description that survive this commit (in place
    // or relinked) — the "descriptions kept on N products" summary line.
    kept: countPreservedContent(
      diff,
      contentRows.map((r) => ({
        content_key: r.content_key,
        hasCopy: !!(r.description_final ?? r.description_ai),
      })),
    ),
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
        // A matched unit with no bullets must not wipe the sheet features —
        // its images still attach below.
        const p = ov && ov.bullets.length > 0 ? overlayFeatures(raw, ov.bullets) : raw;
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
            source: supSlot.endsWith("_pptx") ? "pptx" : "pdf",
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
// Supplemental commit (pptx decks / mf_pdf / schonbek_pdf)
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
            source: slot.endsWith("_pptx") ? "pptx" : "pdf",
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
        // Bullet-less matches keep (or restore) the sheet features; their
        // images still attached above.
        const next =
          ov && ov.bullets.length > 0
            ? overlayFeatures(p, ov.bullets)
            : clearFeatureOverlay(p);
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
