import { Hono } from "hono";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FIELD_LIMITS,
  NORMALIZERS,
  NORMALIZE_FIELDS,
  PRODUCT_CONTENT_FIELDS,
  SEO_CONSTANTS,
  SEO_FIELDS,
  SEO_LIMITS,
  brandSite,
  buildOrganizationJsonLd,
  defaultOgImage,
  defaultSeoTitle,
  normalizeBrand,
  buildProductPageJsonLd,
  canonicalUrlFor,
  classifyCctType,
  isCctNoValue,
  slugifyName,
  toCsv,
  truncateAtWord,
  type NormalizeField,
  type ProductContentField,
  type SeoIssue,
} from "@wac/shared";
import type { AppBindings } from "../auth.js";
import type { Env } from "../env.js";
import { requireAuth } from "../auth.js";
import { geminiText } from "../gemini.js";
import { serviceSupabase, userSupabase } from "../supabase.js";

/**
 * Phase 2 — Product Information (PRD §6). Romance copy and SEO attach at the
 * PPID (product-page) level — the products cache is keyed by the Sales Layer
 * product_id, which mirrors the upstream zppid. Normalization runs at BOTH
 * levels: one row per variant SKU (the PIM stores CCT/beam/voltage on
 * variants) plus a product-level roll-up row (sku = '') for the PPID page.
 *
 * The App DB (product_content) is the system of record; CSV export is the
 * interim hand-off. RLS scopes the table to active internal/admin users — the
 * rep guard here only exists to return a friendlier 403.
 */
export const productInfoRoutes = new Hono<AppBindings>();

productInfoRoutes.use("*", requireAuth, async (c, next) => {
  if (c.get("user").role === "rep") {
    return c.json({ error: "Product Information is internal-only" }, 403);
  }
  await next();
});

interface ContentRow {
  id: string;
  ppid: string;
  /** '' = product/PPID-level row; otherwise the variant SKU (matnr). */
  sku: string;
  field: ProductContentField;
  existing_value: string | null;
  ai_value: string | null;
  approved_value: string | null;
  status: "none" | "generated" | "in_review" | "approved";
  flagged: boolean;
  note: string | null;
  reviewed_by: string | null;
  updated_at: string;
}

const CONTENT_COLS =
  "id, ppid, sku, field, existing_value, ai_value, approved_value, status, flagged, note, reviewed_by, updated_at";
const CONTENT_CONFLICT = "ppid,sku,field";

const FieldSchema = z.enum(PRODUCT_CONTENT_FIELDS);

/** Workflow groups exposed to the UI: each expands to its content fields. */
type Workflow = "romance_copy" | "seo" | "normalize";
const WorkflowSchema = z.enum(["romance_copy", "seo", "normalize"]);

function expandFields(workflow: Workflow): string[] {
  if (workflow === "seo") return [...SEO_FIELDS];
  if (workflow === "normalize") return [...NORMALIZE_FIELDS];
  return ["romance_copy"];
}

interface VariantSlim {
  sku: string | null;
  finish: string | null;
  name: string | null;
  cct_code?: string | null;
  cct_desc?: string | null;
  beam_desc?: string | null;
  volt_in?: string | null;
  cri?: string | null;
  watts?: string | null;
  lumens?: string | null;
  ip_rating?: string | null;
}

/** Slim the inline variants jsonb down to what the normalization UI needs. */
function slimVariants(variants: unknown): VariantSlim[] {
  if (!Array.isArray(variants)) return [];
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  return (variants as Record<string, unknown>[]).map((v) => ({
    sku: text(v.sku),
    finish: text(v.finish),
    name: text(v.name),
    cct_code: text(v.cct_code),
    cct_desc: text(v.cct_desc),
    beam_desc: text(v.beam_desc),
    volt_in: text(v.volt_in),
    cri: text(v.cri),
    watts: text(v.watts),
    lumens: text(v.lumens),
    ip_rating: text(v.ip_rating),
  }));
}

// ---------------------------------------------------------------------------
// List: products (PPIDs) + their content rows for one workflow
// ---------------------------------------------------------------------------

const ListQuerySchema = z.object({
  field: WorkflowSchema.default("romance_copy"),
  q: z.string().trim().optional(),
  // Accessories (connectors, channels…) are hidden by default — they don't
  // need copy/SEO/normalization. Pass accessories=include to see them.
  accessories: z.enum(["hide", "include"]).default("hide"),
  status: z
    .enum(["none", "generated", "in_review", "approved", "flagged"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

productInfoRoutes.get("/", async (c) => {
  const parsed = ListQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
  }
  const { field, q, status, limit, offset, accessories } = parsed.data;
  const fields = expandFields(field);
  const sb = userSupabase(c.env, c.get("jwt"));
  const productCols =
    field === "normalize"
      ? "sku, name, brand, category, family, is_accessory, primary_image_url, variants"
      : "sku, name, brand, category, family, is_accessory, primary_image_url";

  // With a status filter we drive from product_content (the filter lives
  // there); otherwise we drive from the products list so untouched products
  // (no content rows yet) still appear.
  if (status) {
    let cq = sb
      .from("product_content")
      .select(CONTENT_COLS, { count: "exact" })
      .in("field", fields)
      .order("ppid", { ascending: true })
      .order("sku", { ascending: true })
      .range(offset, offset + limit - 1);
    cq = status === "flagged" ? cq.eq("flagged", true) : cq.eq("status", status);
    if (q) cq = cq.ilike("ppid", `%${q.replace(/[(),]/g, " ").trim()}%`);
    const { data: content, error, count } = await cq;
    if (error) return c.json({ error: error.message }, 500);
    const rows = (content ?? []) as ContentRow[];

    const ppids = [...new Set(rows.map((r) => r.ppid))];
    const products = ppids.length
      ? await sb.from("products").select(productCols).in("sku", ppids)
      : { data: [], error: null };
    if (products.error) return c.json({ error: products.error.message }, 500);
    const byPpid = new Map(
      ((products.data ?? []) as unknown as Record<string, unknown>[]).map((p) => [
        p.sku as string,
        p,
      ]),
    );
    const items = ppids
      .filter((ppid) => {
        const p = byPpid.get(ppid);
        return accessories === "include" || !(p?.is_accessory as boolean);
      })
      .map((ppid) => {
        const p = byPpid.get(ppid);
        return {
          ppid,
          name: (p?.name as string) ?? ppid,
          brand: (p?.brand as string | null) ?? null,
          category: (p?.category as string | null) ?? null,
          family: (p?.family as string | null) ?? null,
          primary_image_url: (p?.primary_image_url as string | null) ?? null,
          variants: field === "normalize" ? slimVariants(p?.variants) : undefined,
          content: rows.filter((r) => r.ppid === ppid),
        };
      });
    return c.json({ items, total: count ?? items.length });
  }

  let pq = sb
    .from("products")
    .select(productCols, { count: "exact" })
    .order("family", { ascending: true, nullsFirst: false })
    .order("name", { ascending: true })
    .range(offset, offset + limit - 1);
  if (accessories === "hide") pq = pq.eq("is_accessory", false);
  if (q) {
    const safe = q.replace(/[(),]/g, " ").trim();
    if (safe) {
      pq = pq.or(
        `name.ilike.%${safe}%,brand.ilike.%${safe}%,sku.ilike.%${safe}%,variant_search.ilike.%${safe}%`,
      );
    }
  }
  const { data: products, error, count } = await pq;
  if (error) return c.json({ error: error.message }, 500);
  const rows = (products ?? []) as unknown as Record<string, unknown>[];
  const ppids = rows.map((p) => p.sku as string);
  const { data: content, error: cerr } = ppids.length
    ? await sb
        .from("product_content")
        .select(CONTENT_COLS)
        .in("field", fields)
        .in("ppid", ppids)
    : { data: [], error: null };
  if (cerr) return c.json({ error: cerr.message }, 500);
  const contentRows = (content ?? []) as ContentRow[];
  const items = rows.map((p) => ({
    ppid: p.sku as string,
    name: p.name as string,
    brand: (p.brand as string | null) ?? null,
    category: (p.category as string | null) ?? null,
    family: (p.family as string | null) ?? null,
    primary_image_url: (p.primary_image_url as string | null) ?? null,
    variants: field === "normalize" ? slimVariants(p.variants) : undefined,
    content: contentRows.filter((r) => r.ppid === (p.sku as string)),
  }));
  return c.json({ items, total: count ?? items.length });
});

// ---------------------------------------------------------------------------
// Product details for the editors: image + primary attributes + existing
// PIM copy. You can't write or judge copy without seeing the product.
// ---------------------------------------------------------------------------

/** Curated PIM attributes (confirmed well-populated in WAC's connector). */
const ATTRIBUTE_FIELDS: [key: string, label: string][] = [
  ["zbrand", "Brand"],
  ["zzfamily", "Family"],
  ["zprdtyp", "Product type"],
  ["zprdstyp", "Subtype"],
  ["zmntyp", "Mount type"],
  ["zmounting", "Mounting"],
  ["zconstruct", "Construction"],
  ["zlght_source", "Light source"],
  ["zdimm_type", "Dimming"],
  ["zinout", "Indoor/Outdoor"],
  ["zcuttable", "Cuttable"],
  ["zlist", "Certifications"],
  ["zwarranty", "Warranty"],
  ["zweb", "Collection"],
  ["zmodel", "Model"],
];

function presentValue(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  if (!s || isCctNoValue(s)) return null;
  return s;
}

interface ProductRow {
  sku: string;
  name: string;
  brand: string | null;
  category: string | null;
  dimensions_mm: Record<string, number>;
  primary_image_url: string | null;
  image_urls: string[];
  variants: unknown;
  raw_json: Record<string, unknown>;
}

const PRODUCT_DETAIL_COLS =
  "sku, name, brand, category, dimensions_mm, primary_image_url, image_urls, variants, raw_json";

/** WAC's connector stores romance copy in `zromnce` (confirmed against the
 * live schema); the regex is a fallback for renamed/added fields. An env
 * override (SALES_LAYER_ROMANCE_FIELD) pins it explicitly. */
const ROMANCE_FIELD_CANDIDATES = ["zromnce", "romance_copy", "romance"];
const ROMANCE_KEY_RE =
  /romance|long[ _-]?desc|marketing[ _-]?desc|web[ _-]?desc/i;

function extractExistingCopy(
  raw: Record<string, unknown>,
  preferredKey?: string,
): string | null {
  const get = (key: string): string | null => {
    const v = raw[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  if (preferredKey) return get(preferredKey);
  for (const key of ROMANCE_FIELD_CANDIDATES) {
    const hit = get(key);
    if (hit) return hit;
  }
  let best: string | null = null;
  for (const key of Object.keys(raw)) {
    if (!ROMANCE_KEY_RE.test(key)) continue;
    const value = get(key);
    // Prefer the longest match — long descriptions beat one-line blurbs.
    if (value && (!best || value.length > best.length)) best = value;
  }
  return best;
}

function productDetails(p: ProductRow, env: Env) {
  const raw = p.raw_json ?? {};
  const attributes: { label: string; value: string }[] = [];
  for (const [key, label] of ATTRIBUTE_FIELDS) {
    const value = presentValue(raw[key]);
    if (value) attributes.push({ label, value });
  }
  const dims = Object.entries(p.dimensions_mm ?? {})
    .map(([k, v]) => `${k} ${Math.round(v)}mm`)
    .join(" · ");
  if (dims) attributes.push({ label: "Dimensions", value: dims });

  const features: string[] = [];
  for (let i = 1; i <= 9; i++) {
    const value = presentValue(raw[`zfeature${i}`]);
    if (value) features.push(value);
  }

  const variants = slimVariants(p.variants);
  const finishes = [...new Set(variants.map((v) => v.finish).filter(Boolean))] as string[];
  if (finishes.length) {
    attributes.push({
      label: "Finishes",
      value: finishes.slice(0, 8).join(", ") + (finishes.length > 8 ? "…" : ""),
    });
  }

  return {
    ppid: p.sku,
    name: p.name,
    brand: p.brand,
    category: p.category,
    image_url: p.primary_image_url,
    image_urls: (p.image_urls ?? []).slice(0, 12),
    attributes,
    features,
    variant_count: variants.length,
    existing: {
      romance_copy: extractExistingCopy(raw, env.SALES_LAYER_ROMANCE_FIELD),
      // No true SEO fields exist in the PIM; these are the closest baselines.
      seo_title: presentValue(raw.zprdtitle) ?? p.name,
      seo_meta_description:
        presentValue(raw.zppid_description) ?? presentValue(raw.product_description),
    },
  };
}

async function loadProduct(
  sb: SupabaseClient,
  ppid: string,
): Promise<ProductRow | null> {
  const { data, error } = await sb
    .from("products")
    .select(PRODUCT_DETAIL_COLS)
    .eq("sku", ppid)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as ProductRow | null) ?? null;
}

productInfoRoutes.get("/details/:ppid", async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const product = await loadProduct(sb, c.req.param("ppid"));
  if (!product) return c.json({ error: "product not found" }, 404);
  return c.json(productDetails(product, c.env));
});

// ---------------------------------------------------------------------------
// AI generation (romance copy / SEO) — Gemini text, directly from the Worker
// ---------------------------------------------------------------------------

const BRAND_VOICE =
  "Voice: premium architectural lighting brand (WAC Group — WAC Lighting, Modern Forms, Schonbek, WAC Landscape). Confident, precise, design-forward. Lead with the experience the product creates, support with concrete specifics (form, finish, light quality, craftsmanship, installation flexibility). No hype words (\"amazing\", \"revolutionary\"), no exclamation marks, no invented specs — only use the attributes provided.";

/** Compact, prompt-safe summary of the product's scalar PIM attributes. */
function attributeSummary(p: ProductRow): string {
  const d = productDetails(p, {} as Env);
  const lines = [
    `PPID: ${p.sku}`,
    `Name: ${p.name}`,
    ...d.attributes.map((a) => `${a.label}: ${a.value}`),
    ...d.features.map((f) => `Feature: ${f}`),
  ];
  return lines.join("\n").slice(0, 4000);
}

async function upsertContent(
  sb: SupabaseClient,
  rows: Partial<ContentRow>[],
): Promise<ContentRow[]> {
  const { data, error } = await sb
    .from("product_content")
    .upsert(rows, { onConflict: CONTENT_CONFLICT })
    .select(CONTENT_COLS);
  if (error) throw new Error(error.message);
  return (data ?? []) as ContentRow[];
}

/** Generate romance or SEO content for one product and upsert the rows.
 * Shared by the single-product and batch endpoints. */
async function generateFor(
  env: Env,
  sb: SupabaseClient,
  product: ProductRow,
  kind: "romance" | "seo",
): Promise<ContentRow[]> {
  const ppid = product.sku;
  const summary = attributeSummary(product);
  const details = productDetails(product, env);
  const existingCopy = details.existing.romance_copy;

  if (kind === "romance") {
    const text = await geminiText(env, {
      // Quality matters most for romance copy — default to the strongest
      // text model; SEO metadata stays on the cheaper flash default.
      model: env.GEMINI_ROMANCE_MODEL || "gemini-3.1-pro-preview",
      system: BRAND_VOICE,
      prompt: [
        "Write romance copy (a detailed marketing description) for this lighting product page: 2 short paragraphs, 80-140 words total, plain text only (no markdown, no headings).",
        existingCopy
          ? `Existing copy for reference (improve on it, do not repeat it verbatim):\n${existingCopy}`
          : "",
        `Product data:\n${summary}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    return upsertContent(sb, [
      {
        ppid,
        sku: "",
        field: "romance_copy",
        existing_value: existingCopy,
        ai_value: text.trim(),
        status: "generated",
      },
    ]);
  }

  // SEO: one call returns all text fields as JSON, then limits are enforced
  // deterministically (the model is asked, but never trusted, to stay short).
  // og_image is not AI — it defaults to the catalog's image #1 (hero angle).
  // Title tags follow the house format with the canonical customer-facing
  // brand name (never raw PIM brand strings or sub-brand labels).
  const canonicalBrand = normalizeBrand(product.brand, product.name);
  const titleTemplate = defaultSeoTitle({
    name: product.name,
    category: product.category,
    brand: product.brand,
  });
  const raw = await geminiText(env, {
    system: BRAND_VOICE,
    json: true,
    prompt: [
      `Write SEO metadata for this lighting product page as JSON: {"seo_title": string (50-${SEO_LIMITS.seo_title} chars, MUST follow the format "{Product Name} – {Key Differentiator/Category} | {Brand}" — brand is exactly "${canonicalBrand ?? "(omit the brand segment)"}", pick the key differentiator from the product data (fall back to the category), e.g. "${titleTemplate}"), "seo_meta_description": string (150-${SEO_LIMITS.seo_meta_description} chars, compelling and specific), "og_title": string (max ${SEO_LIMITS.og_title} chars, social-share headline), "og_description": string (max ${SEO_LIMITS.og_description} chars, social-share blurb)}.`,
      existingCopy ? `Product description:\n${existingCopy}` : "",
      `Product data:\n${summary}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  let seo: Record<string, string>;
  try {
    seo = JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error("AI returned malformed SEO JSON; try again");
  }
  const fields: { field: ProductContentField; value: string; existing: string | null }[] = [
    {
      field: "seo_title",
      value: truncateAtWord(seo.seo_title ?? "", SEO_LIMITS.seo_title),
      existing: details.existing.seo_title,
    },
    {
      field: "seo_meta_description",
      value: truncateAtWord(seo.seo_meta_description ?? "", SEO_LIMITS.seo_meta_description),
      existing: details.existing.seo_meta_description,
    },
    {
      field: "og_title",
      value: truncateAtWord(seo.og_title ?? seo.seo_title ?? "", SEO_LIMITS.og_title),
      existing: null,
    },
    {
      field: "og_description",
      value: truncateAtWord(
        seo.og_description ?? seo.seo_meta_description ?? "",
        SEO_LIMITS.og_description,
      ),
      existing: null,
    },
  ];
  if (fields.some((f) => !f.value)) {
    throw new Error("AI returned empty SEO fields; try again");
  }
  const rows: Partial<ContentRow>[] = fields.map((f) => ({
    ppid,
    sku: "",
    field: f.field,
    existing_value: f.existing,
    ai_value: f.value,
    status: "generated" as const,
  }));
  const ogImage = defaultOgImage(product.image_urls ?? []) ?? details.image_url;
  if (ogImage) {
    rows.push({
      ppid,
      sku: "",
      field: "og_image",
      ai_value: ogImage,
      status: "generated",
    });
  }
  // Deterministic head fields — never AI: slug from the name, canonical from
  // the brand site + slug (editable before approval), robots defaults to index.
  const slug = slugifyName(product.name);
  rows.push(
    { ppid, sku: "", field: "url_slug", ai_value: slug, status: "generated" },
    {
      ppid,
      sku: "",
      field: "canonical_url",
      ai_value: canonicalUrlFor(product.brand, slug),
      status: "generated",
    },
    { ppid, sku: "", field: "meta_robots", ai_value: "index", status: "generated" },
  );
  return upsertContent(sb, rows);
}

const GenerateSchema = z.object({
  ppid: z.string().min(1),
  kind: z.enum(["romance", "seo"]),
});

productInfoRoutes.post("/generate", async (c) => {
  const parsed = GenerateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const product = await loadProduct(sb, parsed.data.ppid);
  if (!product) return c.json({ error: "product not found" }, 404);
  try {
    const rows = await generateFor(c.env, sb, product, parsed.data.kind);
    return c.json({ content: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, msg.includes("not configured") ? 503 : 502);
  }
});

// ---------------------------------------------------------------------------
// Batch generation — scopes: all (everything not yet approved), missing
// (no generated content yet), selected (explicit PPIDs). Each call processes
// up to `limit` products and reports what's left, so the client loops with
// visible progress instead of one multi-minute request. Approved content is
// never overwritten by a batch — only a manual per-product Regenerate is.
// ---------------------------------------------------------------------------

const BatchSchema = z.object({
  kind: z.enum(["romance", "seo"]),
  scope: z.enum(["all", "missing", "selected"]),
  ppids: z.array(z.string().min(1)).max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(15).default(8),
});

/** Key field whose row presence/status decides a product's batch eligibility. */
function keyFieldFor(kind: "romance" | "seo"): string {
  return kind === "romance" ? "romance_copy" : "seo_title";
}

async function eligiblePpids(
  sb: SupabaseClient,
  kind: "romance" | "seo",
  scope: "all" | "missing" | "selected",
  ppids: string[] | undefined,
): Promise<string[]> {
  const keyField = keyFieldFor(kind);
  const PAGE = 1000;

  const all: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let pq = sb
      .from("products")
      .select("sku")
      .eq("is_accessory", false)
      .order("sku", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (scope === "selected" && ppids?.length) pq = pq.in("sku", ppids);
    const { data, error } = await pq;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as { sku: string }[];
    all.push(...page.map((p) => p.sku));
    if (page.length < PAGE) break;
  }

  const states = new Map<string, { status: string }>();
  for (let i = 0; i < all.length; i += PAGE) {
    const { data, error } = await sb
      .from("product_content")
      .select("ppid, status")
      .eq("field", keyField)
      .eq("sku", "")
      .in("ppid", all.slice(i, i + PAGE));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { ppid: string; status: string }[]) {
      states.set(r.ppid, r);
    }
  }

  return all.filter((ppid) => {
    const state = states.get(ppid);
    if (state?.status === "approved") return false; // batches never clobber approved
    if (scope === "missing") return !state;
    return true;
  });
}

productInfoRoutes.post("/generate-batch", async (c) => {
  const parsed = BatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const { kind, scope, ppids, limit } = parsed.data;
  if (scope === "selected" && !ppids?.length) {
    return c.json({ error: "scope=selected requires ppids" }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));

  let eligible: string[];
  try {
    eligible = await eligiblePpids(sb, kind, scope, ppids);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }

  const slice = eligible.slice(0, limit);
  const processed: string[] = [];
  const failed: { ppid: string; error: string }[] = [];
  for (const ppid of slice) {
    try {
      const product = await loadProduct(sb, ppid);
      if (!product) throw new Error("product not found");
      await generateFor(c.env, sb, product, kind);
      processed.push(ppid);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failed.push({ ppid, error: msg });
      // Config problems fail every product the same way — stop immediately.
      if (msg.includes("not configured")) break;
    }
  }
  return c.json({
    processed,
    failed,
    remaining: Math.max(0, eligible.length - slice.length),
  });
});

// ---------------------------------------------------------------------------
// Review: edit / approve / reopen a content row
// ---------------------------------------------------------------------------

const UpdateSchema = z.object({
  action: z.enum(["save", "approve", "reopen"]),
  ai_value: z.string().optional(),
  approved_value: z.string().optional(),
});

productInfoRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const parsed = UpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data: row, error } = await sb
    .from("product_content")
    .select(CONTENT_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!row) return c.json({ error: "not found" }, 404);
  const current = row as ContentRow;

  const { action, ai_value, approved_value } = parsed.data;
  let updates: Partial<ContentRow>;
  if (action === "approve") {
    const value =
      approved_value ?? ai_value ?? current.ai_value ?? current.existing_value;
    if (!value || !value.trim()) {
      return c.json({ error: "nothing to approve — no value present" }, 400);
    }
    // Length limits are enforced at approval too, so a hand-edit can't sneak past.
    const limit = FIELD_LIMITS[current.field];
    if (limit && value.trim().length > limit) {
      return c.json(
        { error: `${current.field} exceeds the ${limit}-character limit` },
        400,
      );
    }
    updates = {
      ...(ai_value !== undefined ? { ai_value } : {}),
      approved_value: value.trim(),
      status: "approved",
      flagged: false,
      note: null,
      reviewed_by: c.get("user").id,
    };
  } else if (action === "save") {
    updates = {
      ...(ai_value !== undefined ? { ai_value } : {}),
      ...(approved_value !== undefined ? { approved_value } : {}),
      ...(current.status === "approved" ? {} : { status: "in_review" as const }),
    };
  } else {
    updates = { status: "in_review", reviewed_by: c.get("user").id };
  }

  const { data: updated, error: uerr } = await sb
    .from("product_content")
    .update(updates)
    .eq("id", id)
    .select(CONTENT_COLS)
    .single();
  if (uerr) return c.json({ error: uerr.message }, 500);
  return c.json({ content: updated });
});

const BulkApproveSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});

productInfoRoutes.post("/bulk-approve", async (c) => {
  const parsed = BulkApproveSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("product_content")
    .select(CONTENT_COLS)
    .in("id", parsed.data.ids);
  if (error) return c.json({ error: error.message }, 500);

  let approved = 0;
  let skipped = 0;
  for (const row of (data ?? []) as ContentRow[]) {
    // Flagged rows need manual resolution; rows with no value can't approve.
    const value = row.approved_value ?? row.ai_value;
    const limit = FIELD_LIMITS[row.field];
    if (row.flagged || !value || !value.trim() || (limit && value.trim().length > limit)) {
      skipped++;
      continue;
    }
    const { error: uerr } = await sb
      .from("product_content")
      .update({
        approved_value: value.trim(),
        status: "approved",
        reviewed_by: c.get("user").id,
      })
      .eq("id", row.id);
    if (uerr) skipped++;
    else approved++;
  }
  return c.json({ approved, skipped });
});

// ---------------------------------------------------------------------------
// Normalization (PRD §6.3) — deterministic, no AI, registry-driven (CCT, beam,
// input voltage). Values live on variants, so each variant SKU gets a row plus
// a product-level roll-up row (sku='') for the PPID page. Approved rows are
// never clobbered unless their raw value changed; unparseable values are
// flagged, not mangled.
// ---------------------------------------------------------------------------

const NormalizeSchema = z.object({
  fields: z.array(z.enum(NORMALIZE_FIELDS)).min(1).default([...NORMALIZE_FIELDS]),
  scope: z.enum(["all", "missing", "selected"]).default("all"),
  ppids: z.array(z.string().min(1)).max(2000).optional(),
});

productInfoRoutes.post("/normalize", async (c) => {
  const parsed = NormalizeSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const { fields, scope, ppids } = parsed.data;
  if (scope === "selected" && !ppids?.length) {
    return c.json({ error: "scope=selected requires ppids" }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));

  const stats = {
    products: 0,
    skuRows: 0,
    parsed: 0,
    flagged: 0,
    skippedApproved: 0,
    skippedExisting: 0,
    noValue: 0,
  };
  const upserts: Partial<ContentRow>[] = [];
  const PAGE = 500;

  for (let offset = 0; ; offset += PAGE) {
    let pq = sb
      .from("products")
      .select("sku, variants")
      .eq("is_accessory", false)
      .order("sku", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (scope === "selected" && ppids?.length) pq = pq.in("sku", ppids);
    const { data: products, error } = await pq;
    if (error) return c.json({ error: error.message }, 500);
    const page = (products ?? []) as { sku: string; variants: unknown }[];
    if (page.length === 0) break;

    // Existing rows for this page: approved rows whose raw value hasn't
    // changed are left alone; scope=missing leaves ANY existing row alone.
    const { data: existing, error: eerr } = await sb
      .from("product_content")
      .select("ppid, sku, field, status, existing_value")
      .in("field", fields)
      .in("ppid", page.map((p) => p.sku));
    if (eerr) return c.json({ error: eerr.message }, 500);
    const priorByKey = new Map(
      (existing ?? []).map((r) => {
        const row = r as { ppid: string; sku: string; field: string; status: string; existing_value: string | null };
        return [`${row.ppid} ${row.sku} ${row.field}`, row];
      }),
    );

    const push = (
      ppid: string,
      sku: string,
      field: NormalizeField,
      raw: string,
      result: ReturnType<(typeof NORMALIZERS)["cct"]["parse"]>,
    ) => {
      const prior = priorByKey.get(`${ppid} ${sku} ${field}`);
      if (prior) {
        if (scope === "missing") {
          stats.skippedExisting++;
          return;
        }
        if (prior.status === "approved" && prior.existing_value === raw) {
          stats.skippedApproved++;
          return;
        }
      }
      if (result.ok) stats.parsed++;
      else stats.flagged++;
      upserts.push({
        ppid,
        sku,
        field,
        existing_value: raw,
        ai_value: result.ok ? result.normalized : null,
        flagged: !result.ok,
        note: result.ok ? null : result.reason,
        status: "generated",
      });
    };

    for (const product of page) {
      stats.products++;
      const variants = slimVariants(product.variants);
      let any = false;

      for (const field of fields) {
        const spec = NORMALIZERS[field];
        if (field === "cct_type") {
          // Classified from BOTH the zcct code and zcct_desc, so it bypasses
          // the generic single-raw-string path.
          const types: string[] = [];
          const raws: string[] = [];
          for (const v of variants) {
            const code = v.cct_code ?? null;
            const desc = v.cct_desc ?? null;
            if (!v.sku || (isCctNoValue(code) && isCctNoValue(desc))) continue;
            const raw = code && desc ? `${code} (${desc})` : code ?? desc ?? "";
            const result = classifyCctType(code, desc);
            if (result.ok) types.push(result.normalized);
            raws.push(raw);
            stats.skuRows++;
            push(product.sku, v.sku, field, raw, result);
            any = true;
          }
          if (raws.length === 0) continue;
          push(
            product.sku,
            "",
            field,
            [...new Set(raws)].join(", "),
            spec.combine(types),
          );
          continue;
        }
        const values: string[] = [];
        for (const v of variants) {
          const raw = (v as unknown as Record<string, unknown>)[spec.variantKey];
          if (!v.sku || typeof raw !== "string" || isCctNoValue(raw)) continue;
          values.push(raw);
          stats.skuRows++;
          push(product.sku, v.sku, field, raw, spec.parse(raw));
          any = true;
        }
        if (values.length === 0) continue;
        const uniqueRaws = [...new Set(values)];
        push(
          product.sku,
          "",
          field,
          uniqueRaws.join(", "),
          spec.combine(uniqueRaws),
        );
      }
      if (!any) stats.noValue++;
    }
    if (page.length < PAGE) break;
  }

  for (let i = 0; i < upserts.length; i += PAGE) {
    const { error } = await sb
      .from("product_content")
      .upsert(upserts.slice(i, i + PAGE), { onConflict: CONTENT_CONFLICT });
    if (error) return c.json({ error: error.message }, 500);
  }
  return c.json(stats);
});

// ---------------------------------------------------------------------------
// SEO payload (head fields + JSON-LD) per product page, with validation.
// Approved values win; falls back to AI drafts, then PIM baselines.
// ---------------------------------------------------------------------------

async function buildSeoPayload(
  sb: SupabaseClient,
  env: Env,
  product: ProductRow,
): Promise<{ head: Record<string, unknown>; jsonld: object[]; issues: SeoIssue[] }> {
  const ppid = product.sku;
  const { data, error } = await sb
    .from("product_content")
    .select(CONTENT_COLS)
    .eq("ppid", ppid);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ContentRow[];
  const pageValue = (field: string): string | null => {
    const row = rows.find((r) => r.field === field && r.sku === "");
    return row?.approved_value ?? row?.ai_value ?? null;
  };
  const skuValue = (field: string, sku: string): string | null => {
    const row = rows.find((r) => r.field === field && r.sku === sku);
    return row?.approved_value ?? row?.ai_value ?? null;
  };

  const details = productDetails(product, env);
  const slug = pageValue("url_slug") ?? slugifyName(product.name);
  const canonical = pageValue("canonical_url") ?? canonicalUrlFor(product.brand, slug);
  const description =
    pageValue("romance_copy") ??
    details.existing.romance_copy ??
    pageValue("seo_meta_description") ??
    details.existing.seo_meta_description;

  const variants = slimVariants(product.variants)
    .filter((v) => v.sku)
    .map((v) => ({
      sku: v.sku!,
      finish: v.finish,
      cct: skuValue("cct", v.sku!) ?? v.cct_desc,
      image: v.sku ? null : null,
      specs: {
        Lumens: v.lumens ?? "",
        Wattage: v.watts ?? "",
        CCT: skuValue("cct", v.sku!) ?? v.cct_desc ?? "",
        CRI: v.cri ?? "",
        "IP Rating": v.ip_rating ?? "",
        Voltage: skuValue("voltage", v.sku!) ?? v.volt_in ?? "",
        Dimming: (product.raw_json?.zdimm_type as string) ?? "",
        Finish: v.finish ?? "",
      },
    }));

  const { jsonld, issues } = buildProductPageJsonLd({
    ppid,
    name: product.name,
    description,
    brand: product.brand,
    canonicalUrl: canonical,
    images: details.image_urls,
    category: product.category,
    siteBase: brandSite(product.brand),
    variants,
  });

  const title = pageValue("seo_title");
  const meta = pageValue("seo_meta_description");
  const h1 = pageValue("h1");
  if (!title) issues.push({ level: "error", message: "missing title tag" });
  if (!meta) issues.push({ level: "error", message: "missing meta description" });
  if (title && h1 && title.trim().toLowerCase() === h1.trim().toLowerCase()) {
    issues.push({ level: "warn", message: "H1 should be distinct from the title tag" });
  }

  const head = {
    title,
    meta_description: meta,
    canonical_url: canonical,
    meta_robots: pageValue("meta_robots") ?? "index",
    url_slug: slug,
    h1,
    og_title: pageValue("og_title"),
    og_description: pageValue("og_description"),
    og_url: canonical,
    og_type: SEO_CONSTANTS.og_type,
    og_image: pageValue("og_image") ?? details.image_url,
    twitter_card: SEO_CONSTANTS.twitter_card,
  };
  return { head, jsonld, issues };
}

productInfoRoutes.get("/jsonld/:ppid", async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const product = await loadProduct(sb, c.req.param("ppid"));
  if (!product) return c.json({ error: "product not found" }, 404);
  const payload = await buildSeoPayload(sb, c.env, product);
  return c.json({
    ...payload,
    organization: buildOrganizationJsonLd({
      name: product.brand ?? "WAC Lighting",
      url: brandSite(product.brand),
    }),
  });
});

// Bulk JSON-LD export: every product that has SEO content. Paged (the full
// payload per product is heavy) — the client downloads page by page.
const JsonLdExportSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

productInfoRoutes.get("/export.jsonld", async (c) => {
  const parsed = JsonLdExportSchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));

  // Distinct PPIDs that have any SEO-workflow content.
  const ppids = new Set<string>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb
      .from("product_content")
      .select("ppid")
      .in("field", [...SEO_FIELDS])
      .order("ppid", { ascending: true })
      .range(offset, offset + 999);
    if (error) return c.json({ error: error.message }, 500);
    for (const r of (data ?? []) as { ppid: string }[]) ppids.add(r.ppid);
    if (!data || data.length < 1000) break;
  }
  const ordered = [...ppids].sort();
  const page = ordered.slice(parsed.data.offset, parsed.data.offset + parsed.data.limit);

  const pages: object[] = [];
  for (const ppid of page) {
    const product = await loadProduct(sb, ppid);
    if (!product) continue;
    const payload = await buildSeoPayload(sb, c.env, product);
    pages.push({ ppid, ...payload });
  }
  return c.json({ pages, total: ordered.length, offset: parsed.data.offset });
});

// ---------------------------------------------------------------------------
// Product overview — the "window into the PIM" for the Products hub: details
// plus every content row (romance, SEO, normalization) for the PPID.
// ---------------------------------------------------------------------------

productInfoRoutes.get("/overview/:ppid", async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const product = await loadProduct(sb, c.req.param("ppid"));
  if (!product) return c.json({ error: "product not found" }, 404);
  const { data, error } = await sb
    .from("product_content")
    .select(CONTENT_COLS)
    .eq("ppid", product.sku)
    .order("field", { ascending: true })
    .order("sku", { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({
    details: productDetails(product, c.env),
    content: (data ?? []) as ContentRow[],
  });
});

// ---------------------------------------------------------------------------
// Families — sibling PPIDs grouped by the PIM's zzfamily. The family summary
// is AI-generated from the members and stored as a product_content row keyed
// ppid = "family:<name>" so it flows through the same review/approve/export.
// ---------------------------------------------------------------------------

const familyKey = (family: string) => `family:${family}`;

productInfoRoutes.get("/families", async (c) => {
  const q = (new URL(c.req.url).searchParams.get("q") ?? "").trim().toLowerCase();
  const sb = userSupabase(c.env, c.get("jwt"));
  const counts = new Map<string, { count: number; brands: Set<string>; image: string | null; categories: Set<string> }>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb
      .from("products")
      .select("family, brand, category, primary_image_url")
      .eq("is_accessory", false)
      .not("family", "is", null)
      .range(offset, offset + 999);
    if (error) return c.json({ error: error.message }, 500);
    const page = (data ?? []) as { family: string | null; brand: string | null; category: string | null; primary_image_url: string | null }[];
    for (const r of page) {
      if (!r.family) continue;
      const entry =
        counts.get(r.family) ??
        { count: 0, brands: new Set<string>(), image: null, categories: new Set<string>() };
      entry.count++;
      if (r.brand) entry.brands.add(r.brand);
      if (r.category) entry.categories.add(r.category);
      if (!entry.image && r.primary_image_url) entry.image = r.primary_image_url;
      counts.set(r.family, entry);
    }
    if (page.length < 1000) break;
  }
  const families = [...counts.entries()]
    .filter(([name]) => !q || name.toLowerCase().includes(q))
    .map(([name, v]) => ({
      family: name,
      count: v.count,
      brands: [...v.brands],
      categories: [...v.categories].slice(0, 3),
      image: v.image,
    }))
    .sort((a, b) => a.family.localeCompare(b.family));
  return c.json({ families });
});

productInfoRoutes.get("/family/:name", async (c) => {
  const family = c.req.param("name");
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data: products, error } = await sb
    .from("products")
    .select("sku, name, brand, category, primary_image_url, variants, raw_json, dimensions_mm, image_urls")
    .eq("family", family)
    .eq("is_accessory", false)
    .order("name", { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  const members = (products ?? []) as unknown as ProductRow[];
  if (members.length === 0) return c.json({ error: "family not found" }, 404);

  const ppids = [...members.map((m) => m.sku), familyKey(family)];
  const { data: content, error: cerr } = await sb
    .from("product_content")
    .select(CONTENT_COLS)
    .in("ppid", ppids)
    .eq("sku", "");
  if (cerr) return c.json({ error: cerr.message }, 500);
  const rows = (content ?? []) as ContentRow[];

  return c.json({
    family,
    summary: rows.find((r) => r.ppid === familyKey(family) && r.field === "family_summary") ?? null,
    members: members.map((m) => {
      const romance = rows.find((r) => r.ppid === m.sku && r.field === "romance_copy");
      return {
        ppid: m.sku,
        name: m.name,
        brand: m.brand,
        category: m.category,
        primary_image_url: m.primary_image_url,
        variant_count: slimVariants(m.variants).length,
        romance: romance ?? null,
        existing_romance: extractExistingCopy(m.raw_json ?? {}, c.env.SALES_LAYER_ROMANCE_FIELD),
      };
    }),
  });
});

const FamilySummarySchema = z.object({ family: z.string().min(1) });

productInfoRoutes.post("/family-summary", async (c) => {
  const parsed = FamilySummarySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const { family } = parsed.data;
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data: products, error } = await sb
    .from("products")
    .select(PRODUCT_DETAIL_COLS)
    .eq("family", family)
    .eq("is_accessory", false)
    .order("name", { ascending: true })
    .limit(20);
  if (error) return c.json({ error: error.message }, 500);
  const members = (products ?? []) as unknown as ProductRow[];
  if (members.length === 0) return c.json({ error: "family not found" }, 404);

  const memberSummaries = members
    .map((m) => {
      const copy = extractExistingCopy(m.raw_json ?? {}, c.env.SALES_LAYER_ROMANCE_FIELD);
      return [
        `--- ${m.name} (PPID ${m.sku}) ---`,
        attributeSummary(m),
        copy ? `Romance copy: ${copy}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  try {
    const text = await geminiText(c.env, {
      model: c.env.GEMINI_ROMANCE_MODEL || "gemini-3.1-pro-preview",
      system: BRAND_VOICE,
      prompt: [
        `Write a detailed family summary for the "${family}" product family: 2-3 short paragraphs, 120-200 words total, plain text. Open with the shared design story, then walk the line-up — what each member is and where it fits (sizes, mounting types, applications). No markdown.`,
        `Family members:\n${memberSummaries}`,
      ].join("\n\n"),
    });
    const rows = await upsertContent(sb, [
      {
        ppid: familyKey(family),
        sku: "",
        field: "family_summary",
        ai_value: text.trim(),
        status: "generated",
      },
    ]);
    return c.json({ content: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, msg.includes("not configured") ? 503 : 502);
  }
});

// ---------------------------------------------------------------------------
// CSV export — the interim hand-off (PRD §3/§6). Excel-friendly (UTF-8 BOM).
// ---------------------------------------------------------------------------

const ExportQuerySchema = z.object({
  field: z.union([WorkflowSchema, FieldSchema]).optional(),
  status: z.enum(["generated", "in_review", "approved"]).optional(),
});

productInfoRoutes.get("/export.csv", async (c) => {
  const parsed = ExportQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const fieldParam = parsed.data.field;
  const fieldFilter = fieldParam
    ? WorkflowSchema.safeParse(fieldParam).success
      ? expandFields(fieldParam as Workflow)
      : [fieldParam]
    : null;

  const rows: ContentRow[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    let q = sb
      .from("product_content")
      .select(CONTENT_COLS)
      .order("ppid", { ascending: true })
      .order("sku", { ascending: true })
      .order("field", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (fieldFilter) q = q.in("field", fieldFilter);
    if (parsed.data.status) q = q.eq("status", parsed.data.status);
    const { data, error } = await q;
    if (error) return c.json({ error: error.message }, 500);
    rows.push(...((data ?? []) as ContentRow[]));
    if (!data || data.length < PAGE) break;
  }

  // Hydrate product names + reviewer emails (emails via the service client —
  // the users table is self/admin-read under RLS, but reviewer attribution in
  // an export is not sensitive).
  const ppids = [...new Set(rows.map((r) => r.ppid))];
  const names = new Map<string, string>();
  for (let i = 0; i < ppids.length; i += PAGE) {
    const { data } = await sb
      .from("products")
      .select("sku, name")
      .in("sku", ppids.slice(i, i + PAGE));
    for (const p of (data ?? []) as { sku: string; name: string }[]) {
      names.set(p.sku, p.name);
    }
  }
  const reviewerIds = [...new Set(rows.map((r) => r.reviewed_by).filter(Boolean))] as string[];
  const reviewers = new Map<string, string>();
  if (reviewerIds.length) {
    const { data } = await serviceSupabase(c.env)
      .from("users")
      .select("id, email")
      .in("id", reviewerIds);
    for (const u of (data ?? []) as { id: string; email: string }[]) {
      reviewers.set(u.id, u.email);
    }
  }

  const csv = toCsv(
    [
      "ppid",
      "sku",
      "product_name",
      "field",
      "existing_value",
      "ai_value",
      "approved_value",
      "status",
      "flagged",
      "note",
      "reviewed_by",
      "updated_at",
    ],
    rows.map((r) => [
      r.ppid,
      r.sku,
      names.get(r.ppid) ?? "",
      r.field,
      r.existing_value,
      r.ai_value,
      r.approved_value,
      r.status,
      r.flagged ? "true" : "false",
      r.note,
      r.reviewed_by ? reviewers.get(r.reviewed_by) ?? r.reviewed_by : "",
      r.updated_at,
    ]),
  );
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `product-info_${fieldParam ?? "all"}_${stamp}.csv`;
  return new Response("\uFEFF" + csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
    },
  });
});
