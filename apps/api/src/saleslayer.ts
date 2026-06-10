import type { Env } from "./env.js";
import { serviceSupabase } from "./supabase.js";

/**
 * Sales Layer PIM adapter — legacy Connector API (api.saleslayer.com), the same
 * API the official PHP SDK uses. The rest of the app only knows about `sync()`
 * and `fetchSchema()`; it never sees the upstream wire format.
 *
 * Auth (per the PHP SDK): every request is signed with
 *   key256 = sha256(connectorId + secretKey + time + unique)
 * and sent as ?code=<id>&time=<t>&unique=<u>&key256=<hash>&ver=<version>.
 *
 * Wire format: the connector returns positional rows whose order is described by
 * `data_schema` (only present on the FIRST page; reused for every `next_page`).
 * Tables: `categories`, `products`, `variants`. A WAC product groups many
 * variants; the orderable SKU (matnr), most fixture dimensions, and many images
 * live at the VARIANT level. We fold variants into each product row and
 * aggregate every image so the user can access them all.
 *
 * Image fields are arrays of [STATUS, hash, URL, ...] entries; URLs are
 * CloudFront CDN links we store as-is (we never host product imagery).
 */

const DEFAULT_HOST = "api.saleslayer.com";
const DEFAULT_VERSION = "1.18";
const MAX_PAGES = 200; // safety cap

// Product-level image fields, in priority order (first = marketing primary).
const PRODUCT_IMAGE_FIELDS = ["image_url", "line_drawing", "top_line_drawing"];
// Variant-level image fields.
const VARIANT_IMAGE_FIELDS = [
  "images_url",
  "custom_thumbnail",
  "specs_image",
  "specs_s_images",
  "aesthetic_img",
  "specs_image_schonbek",
  "line_drawing",
  "top_line_drawing",
];
// Variant fixture-dimension fields → normalized key. Values are inches.
const VARIANT_DIM_FIELDS: Record<string, keyof DimsMm> = {
  zlength_fix: "length",
  zwidth_fix: "width",
  zheight_fix: "height",
  zbodydia: "diameter",
  zcnpydia: "diameter",
};

interface DimsMm {
  width?: number;
  height?: number;
  depth?: number;
  diameter?: number;
  length?: number;
}

interface VariantRow {
  variant_id: string;
  sku: string | null;
  finish: string | null;
  name: string | null;
  dimensions_mm: DimsMm;
  image_urls: string[];
  /** Photometric (.ies) file URL, when the variant carries one. */
  ies_url: string | null;
}

export interface ProductCacheRow {
  sku: string;
  sl_id: string | null;
  name: string;
  brand: string | null;
  category: string | null;
  dimensions_mm: DimsMm;
  primary_image_url: string | null;
  image_urls: string[];
  /**
   * Manufacturer IES photometry URL (Sales Layer CDN). The 3D App-Shot render
   * feeds it to Blender's add_ies_light for a physically-accurate light spill;
   * fixtures without one fall back to lamp + synthetic-fill lighting.
   */
  ies_url: string | null;
  variants: VariantRow[];
  variant_search: string | null;
  raw_json: Record<string, unknown>;
}

/**
 * Candidate Sales Layer product field names that may carry the brand, scanned
 * case-insensitively when no explicit SALES_LAYER_BRAND_FIELD override is set.
 * WAC's connector uses SAP-style `z*` field names, so several spellings are
 * covered; the first non-empty match wins.
 */
const BRAND_FIELD_CANDIDATES = [
  "brand",
  "brand_name",
  "brandname",
  "product_brand",
  "zbrand",
  "zbrandname",
  "zbrand_name",
  "zmarke",
  "zmarca",
  "marca",
  "manufacturer",
  "zmanufacturer",
  "zproductbrand",
  "zproductline",
  "product_line",
  "zdivision",
  "division",
];

export interface ProductAdapter {
  /** Pull the full catalog and refresh the local cache. */
  sync(): Promise<{ upserted: number; pruned: number; variants: number }>;
  /** Return the upstream field schema (types) for products/variants/categories. */
  fetchSchema(): Promise<unknown>;
}

type SchemaEntry = string | Record<string, unknown>;
interface ConnectorPage {
  error?: number;
  error_message?: string;
  data_schema?: Record<string, SchemaEntry[]>;
  data_schema_info?: Record<string, unknown>;
  data?: Record<string, unknown[][]>;
  next_page?: string;
}

export function makeProductAdapter(env: Env): ProductAdapter {
  const host = env.SALES_LAYER_API_HOST || DEFAULT_HOST;
  const version = env.SALES_LAYER_API_VERSION || DEFAULT_VERSION;
  const connectorId = env.SALES_LAYER_CONNECTOR_ID;
  const secretKey = env.SALES_LAYER_SECRET_KEY || env.SALES_LAYER_API_KEY;
  const dimFactor = unitToMm(env.SALES_LAYER_DIMENSION_UNIT ?? "in");
  const brandFieldOverride = env.SALES_LAYER_BRAND_FIELD?.trim() || undefined;

  function ensureCreds(): void {
    if (!connectorId || !secretKey) {
      throw new Error(
        "SALES_LAYER_CONNECTOR_ID and SALES_LAYER_SECRET_KEY (or SALES_LAYER_API_KEY) must be set",
      );
    }
  }

  async function firstPageUrl(): Promise<string> {
    const time = Math.floor(Date.now() / 1000).toString();
    const unique = Math.floor(Math.random() * 2 ** 31).toString();
    const key256 = await sha256hex(connectorId! + secretKey! + time + unique);
    const p = new URLSearchParams({
      code: connectorId!,
      time,
      unique,
      key256,
      ver: version,
    });
    return `https://${host}/?${p.toString()}`;
  }

  async function fetchPage(url: string): Promise<ConnectorPage> {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`Sales Layer ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as ConnectorPage;
    if (body.error) {
      throw new Error(
        `Sales Layer error ${body.error}: ${body.error_message ?? "unknown"}`,
      );
    }
    return body;
  }

  return {
    async fetchSchema() {
      ensureCreds();
      const page = await fetchPage(await firstPageUrl());
      return page.data_schema_info ?? {};
    },

    async sync() {
      ensureCreds();

      let schema: Record<string, SchemaEntry[]> | null = null;
      const categoryName = new Map<string, string>(); // internal ID -> name
      const products = new Map<string, ProductCacheRow>(); // internal ID -> row
      const variantsByProduct = new Map<string, VariantRow[]>();
      // Remember which field we pulled brand from, logged once for observability
      // so an admin can pin it via SALES_LAYER_BRAND_FIELD if discovery is wrong.
      let discoveredBrandField: string | null = null;

      let url: string | undefined = await firstPageUrl();
      for (let page = 0; page < MAX_PAGES && url; page++) {
        const body: ConnectorPage = await fetchPage(url);
        if (body.data_schema) schema = body.data_schema;
        if (!schema) throw new Error("Sales Layer: missing data_schema on first page");

        const data = body.data ?? {};

        for (const row of data.categories ?? []) {
          if (row[0] === "D") continue;
          const c = mapRow(row, schema.categories);
          const id = str(c.ID);
          const name = decodeEntities(str(c.category_name) ?? "");
          if (id && name) categoryName.set(id, name);
        }

        for (const row of data.products ?? []) {
          if (row[0] === "D") continue;
          const p = mapRow(row, schema.products);
          const id = str(p.ID);
          const sku = str(p.product_id);
          if (!id || !sku) continue;
          const brandHit = extractBrand(p, brandFieldOverride);
          if (brandHit && !discoveredBrandField) discoveredBrandField = brandHit.field;
          products.set(id, {
            sku,
            sl_id: id,
            name: decodeEntities(str(p.product_name) ?? sku),
            brand: brandHit?.value ?? null,
            category: str(p.ID_categories), // resolved to name after the loop
            dimensions_mm: {},
            primary_image_url: firstImage(p, PRODUCT_IMAGE_FIELDS),
            image_urls: collectImages(p, PRODUCT_IMAGE_FIELDS),
            ies_url: findIesUrl(p),
            variants: [],
            variant_search: null,
            raw_json: stripImages(p),
          });
        }

        for (const row of data.variants ?? []) {
          if (row[0] === "D") continue;
          const v = mapRow(row, schema.variants);
          const productId = str(v.ID_products);
          if (!productId) continue;
          const variant: VariantRow = {
            variant_id: str(v.variant_id) ?? str(v.ID) ?? "",
            sku: str(v.matnr),
            finish: cleanText(str(v.zfinish)),
            name: cleanText(decodeEntities(str(v.zprdtitle) ?? str(v.maktx) ?? "")),
            dimensions_mm: variantDims(v, dimFactor),
            image_urls: collectImages(v, VARIANT_IMAGE_FIELDS),
            ies_url: findIesUrl(v),
          };
          if (!variant.variant_id) continue;
          const list = variantsByProduct.get(productId) ?? [];
          list.push(variant);
          variantsByProduct.set(productId, list);
        }

        url = body.next_page;
      }

      // Stitch variants into products + finalize aggregate fields.
      for (const [id, product] of products) {
        const vlist = variantsByProduct.get(id) ?? [];
        product.variants = vlist;

        // Resolve category internal ID -> human name (fall back to the ref).
        product.category = product.category
          ? categoryName.get(product.category) ?? product.category
          : null;

        // Representative dims: first variant that has any.
        const repr = vlist.find((v) => Object.keys(v.dimensions_mm).length > 0);
        if (repr) product.dimensions_mm = repr.dimensions_mm;

        // Aggregate every image (product + all variants), de-duplicated.
        const all = new Set(product.image_urls);
        for (const v of vlist) for (const u of v.image_urls) all.add(u);
        product.image_urls = [...all];
        if (!product.primary_image_url && product.image_urls.length) {
          product.primary_image_url = product.image_urls[0]!;
        }

        // IES photometry: prefer the product-level file, else the first variant
        // that carries one (the photometric throw is shared across finishes).
        if (!product.ies_url) {
          product.ies_url = vlist.find((v) => v.ies_url)?.ies_url ?? null;
        }

        // Searchable text: variant SKUs / ids / finishes.
        const terms = new Set<string>();
        for (const v of vlist) {
          if (v.sku) terms.add(v.sku);
          if (v.variant_id) terms.add(v.variant_id);
          if (v.finish) terms.add(v.finish);
        }
        product.variant_search = terms.size ? [...terms].join(" ") : null;
      }

      // De-dupe by sku (product_id) so the upsert never hits the same conflict
      // key twice within one payload.
      const seen = new Set<string>();
      const rows: ProductCacheRow[] = [];
      for (const p of products.values()) {
        if (seen.has(p.sku)) continue;
        seen.add(p.sku);
        rows.push(p);
      }

      // Count variants on the deduped rows we actually store (not the raw
      // pre-dedup total, which double-counts regional duplicate products).
      const variantCount = rows.reduce((n, r) => n + r.variants.length, 0);

      // A 0-length pull almost always means a transient/auth error rather than
      // an empty catalog — bail without wiping the cache.
      if (rows.length === 0) return { upserted: 0, pruned: 0, variants: 0 };

      const brandCount = rows.filter((r) => r.brand).length;
      console.log(
        `[products] brand field: ${
          brandFieldOverride
            ? `${brandFieldOverride} (override)`
            : (discoveredBrandField ?? "none discovered")
        }; ${brandCount}/${rows.length} products have a brand`,
      );

      const iesCount = rows.filter((r) => r.ies_url).length;
      console.log(`[products] ${iesCount}/${rows.length} products have an IES file`);

      const admin = serviceSupabase(env);
      const syncedAt = new Date().toISOString();
      const CHUNK = 300;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK).map((r) => ({
          sku: r.sku,
          sl_id: r.sl_id,
          name: r.name,
          brand: r.brand,
          category: r.category,
          dimensions_mm: r.dimensions_mm,
          primary_image_url: r.primary_image_url,
          image_urls: r.image_urls,
          ies_url: r.ies_url,
          variants: r.variants,
          variant_search: r.variant_search,
          raw_json: r.raw_json,
          synced_at: syncedAt,
        }));
        const { error } = await admin
          .from("products")
          .upsert(chunk, { onConflict: "sku" });
        if (error) throw new Error(`products upsert failed: ${error.message}`);
      }

      const { data: pruned, error: pruneErr } = await admin
        .from("products")
        .delete()
        .lt("synced_at", syncedAt)
        .select("id");
      if (pruneErr) throw new Error(`products prune failed: ${pruneErr.message}`);

      return {
        upserted: rows.length,
        pruned: pruned?.length ?? 0,
        variants: variantCount,
      };
    },
  };
}

// -----------------------------------------------------------------------------
// Row / field helpers
// -----------------------------------------------------------------------------

/** Map a positional row to a { fieldName: value } object using its schema. */
function mapRow(
  row: unknown[],
  schema: SchemaEntry[] | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!schema) return out;
  for (let i = 0; i < schema.length; i++) {
    const entry = schema[i]!;
    const name = typeof entry === "string" ? entry : Object.keys(entry)[0]!;
    out[name] = row[i];
  }
  return out;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

/**
 * Pull the brand from a mapped product row. Uses the explicit override field if
 * given, else scans common brand field names case-insensitively against the
 * row's actual keys. Returns the matched field name (for logging) and the
 * cleaned value. The connector image arrays are skipped so we never mistake an
 * image field for a brand.
 */
function extractBrand(
  p: Record<string, unknown>,
  override?: string,
): { field: string; value: string } | null {
  const read = (field: string): string | null => {
    const raw = p[field];
    if (Array.isArray(raw)) return null; // image/multi-value fields aren't brands
    const v = cleanText(decodeEntities(str(raw) ?? ""));
    return v;
  };

  if (override) {
    const v = read(override);
    return v ? { field: override, value: v } : null;
  }

  // Case-insensitive lookup over the row's actual keys.
  const keyByLower = new Map<string, string>();
  for (const k of Object.keys(p)) keyByLower.set(k.toLowerCase(), k);

  for (const candidate of BRAND_FIELD_CANDIDATES) {
    const actualKey = keyByLower.get(candidate);
    if (!actualKey) continue;
    const v = read(actualKey);
    if (v) return { field: actualKey, value: v };
  }
  return null;
}

/** Drop "N/A"-style placeholders. */
function cleanText(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  if (!t || /^n\/?a$/i.test(t)) return null;
  return t;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(",", ".").replace(/[^0-9.]/g, "");
    if (!cleaned) return null;
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function unitToMm(unit: string): number {
  switch (unit.toLowerCase()) {
    case "cm":
      return 10;
    case "m":
      return 1000;
    case "mm":
      return 1;
    default:
      return 25.4; // inches
  }
}

function variantDims(
  v: Record<string, unknown>,
  factor: number,
): DimsMm {
  const dims: DimsMm = {};
  for (const [field, key] of Object.entries(VARIANT_DIM_FIELDS)) {
    if (dims[key] !== undefined) continue; // first match wins (e.g. body vs canopy dia)
    const n = asNumber(v[field]);
    if (n !== null && n > 0) dims[key] = round2(n * factor);
  }
  return dims;
}

/** First http(s) URL across the given image fields. */
function firstImage(
  row: Record<string, unknown>,
  fields: string[],
): string | null {
  for (const f of fields) {
    const urls = extractImageUrls(row[f]);
    if (urls.length) return urls[0]!;
  }
  return null;
}

/** All http(s) URLs across the given image fields, de-duplicated, in order. */
function collectImages(
  row: Record<string, unknown>,
  fields: string[],
): string[] {
  const out: string[] = [];
  for (const f of fields) out.push(...extractImageUrls(row[f]));
  return [...new Set(out)];
}

/**
 * The photometric-file URL from Sales Layer's dedicated `ies_files` field
 * (shape `[[STATUS, hash, URL], ...]`, like the image fields). WAC delivers the
 * IES as a CDN `.zip` (e.g. `.../4031_IES.zip`), NOT a raw `.ies`, so we store
 * the zip URL as-is; the render-worker downloads it and the Blender script
 * (composite.py) unzips + extracts the `.ies` before lighting. Returns the first
 * URL found, or null when the fixture ships no photometry.
 */
function findIesUrl(row: Record<string, unknown>): string | null {
  return extractImageUrls(row["ies_files"])[0] ?? null;
}

/** Recursively pull every http(s) string out of a connector image value. */
function extractImageUrls(v: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      if (/^https?:\/\//i.test(node)) out.push(node);
    } else if (Array.isArray(node)) {
      for (const item of node) visit(item);
    }
  };
  visit(v);
  return out;
}

/** Strip bulky image arrays from a row before storing it as raw_json. */
function stripImages(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(row)) {
    if (Array.isArray(val) && val.some((e) => Array.isArray(e))) continue;
    out[k] = val;
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};
function decodeEntities(s: string): string {
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/g, (m) => ENTITIES[m] ?? m);
}

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
