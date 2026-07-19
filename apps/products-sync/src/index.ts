import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolvePdpUrls } from "./pdp.js";

/**
 * Products sync — push the WAC product catalog (Sales Layer PIM, already in the
 * `products` table) to the HubSpot Products object, one product per VISIBLE
 * variant material (hs_sku = the variant SKU). Prices (C1/D1/D6/D7) come from
 * the `pricing` staging table joined by SKU; PIM attributes (brand, finish,
 * CCT, dimensions, …) are pushed into purpose-created product properties.
 *
 * Runs out-of-band (Node CI, real RAM) like territory-sync: ~tens of thousands
 * of materials → ~hundreds of batch upserts, more than a Worker should carry.
 *
 * Idempotent: ensures the HubSpot properties exist, then batch-UPSERTS by
 * hs_sku (idProperty) — re-runnable any time. Non-destructive: products no
 * longer in the catalog are left in HubSpot (no prune).
 *
 * Flags: --dry-run (no writes; print a sample), --limit N (only N products).
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HUBSPOT_TOKEN.
 */

const HS = "https://api.hubapi.com";
const PROPERTY_GROUP = "wac_pim";
const UPSERT_BATCH = 100;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// PIM attributes that need purpose-created product properties. c1/d1/d6/d7,
// name, and description already exist on the HubSpot product object.
const PIM_PROPS: { name: string; label: string; fieldType: "text" | "textarea" }[] = [
  { name: "brand", label: "Brand", fieldType: "text" },
  { name: "category", label: "Category", fieldType: "text" },
  { name: "family", label: "Family", fieldType: "text" },
  { name: "product_type", label: "Product Type", fieldType: "text" },
  { name: "model", label: "Model", fieldType: "text" },
  { name: "mount_type", label: "Mount Type", fieldType: "text" },
  { name: "indoor_outdoor", label: "Indoor / Outdoor", fieldType: "text" },
  { name: "theme", label: "Theme", fieldType: "text" },
  { name: "watts", label: "Wattage", fieldType: "text" },
  { name: "finish", label: "Finish", fieldType: "text" },
  { name: "lumens", label: "Lumens", fieldType: "text" },
  { name: "cri", label: "CRI", fieldType: "text" },
  { name: "input_voltage", label: "Input Voltage", fieldType: "text" },
  { name: "cct", label: "CCT", fieldType: "text" },
  { name: "beam_angle", label: "Beam Angle", fieldType: "text" },
  { name: "ip_rating", label: "IP Rating", fieldType: "text" },
  { name: "dimensions", label: "Dimensions", fieldType: "text" },
  { name: "image_url", label: "Image URL", fieldType: "text" },
  { name: "ies_url", label: "IES File URL", fieldType: "text" },
  { name: "product_url", label: "Product URL", fieldType: "text" },
];

interface Variant {
  sku: string | null;
  name: string | null;
  finish: string | null;
  watts: string | null;
  lumens: string | null;
  cri: string | null;
  volt_in: string | null;
  cct_desc: string | null;
  beam_desc: string | null;
  ip_rating: string | null;
  ies_url: string | null;
  image_urls: string[] | null;
  dimensions_mm: { width?: number; height?: number; length?: number; diameter?: number } | null;
}
interface Product {
  sku: string;
  name: string | null;
  brand: string | null;
  category: string | null;
  family: string | null;
  primary_image_url: string | null;
  image_urls: string[] | null;
  ies_url: string | null;
  dimensions_mm: Variant["dimensions_mm"];
  raw_json: Record<string, unknown> | null;
  variants: Variant[] | null;
}
type PriceMap = Map<string, { c1?: number; d1?: number; d6?: number; d7?: number }>;

const iso = () => new Date().toISOString();

async function hs<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${HS}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HubSpot ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

/** Create the property group + any missing PIM properties (idempotent). */
async function ensureProperties(token: string): Promise<void> {
  // Group (409 if it already exists — fine).
  try {
    await hs(token, "/crm/v3/properties/products/groups", {
      method: "POST",
      body: JSON.stringify({ name: PROPERTY_GROUP, label: "WAC Product Info" }),
    });
    console.log(`[products-sync] created property group ${PROPERTY_GROUP}`);
  } catch (e) {
    if (!String(e).includes("409")) throw e;
  }
  const existing = await hs<{ results: { name: string }[] }>(token, "/crm/v3/properties/products");
  const have = new Set(existing.results.map((p) => p.name));
  for (const def of PIM_PROPS) {
    if (have.has(def.name)) continue;
    await hs(token, "/crm/v3/properties/products", {
      method: "POST",
      body: JSON.stringify({
        name: def.name,
        label: def.label,
        type: "string",
        fieldType: def.fieldType,
        groupName: PROPERTY_GROUP,
      }),
    });
    console.log(`[products-sync] created product property ${def.name}`);
  }
}

/** Page every row of a table (PostgREST limit/offset). */
async function loadAll<T>(sb: SupabaseClient, table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function formatDims(d: Variant["dimensions_mm"]): string | null {
  if (!d) return null;
  const parts: string[] = [];
  if (d.diameter) parts.push(`Ø${d.diameter}`);
  if (d.width) parts.push(`W${d.width}`);
  if (d.height) parts.push(`H${d.height}`);
  if (d.length) parts.push(`L${d.length}`);
  return parts.length ? `${parts.join(" × ")} mm` : null;
}

/** Build the HubSpot property bag for one variant material (omit empties). */
function buildProps(p: Product, v: Variant, prices: PriceMap): Record<string, string | number> {
  const rj = p.raw_json ?? {};
  const s = (x: unknown): string | undefined => {
    const t = x == null ? "" : String(x).trim();
    return t || undefined;
  };
  const price = prices.get(v.sku!) ?? {};
  const out: Record<string, string | number> = {};
  const set = (k: string, val: string | number | undefined) => {
    if (val !== undefined && val !== "") out[k] = val;
  };
  set("name", s(v.name) ?? s(p.name));
  set("description", s(rj.zromnce));
  set("c1", price.c1);
  set("d1", price.d1);
  set("d6", price.d6);
  set("d7", price.d7);
  set("brand", s(p.brand));
  set("category", s(p.category));
  set("family", s(p.family));
  set("product_type", s(rj.zprdtyp));
  set("model", s(rj.zmodel));
  set("mount_type", s(rj.zmntyp));
  set("indoor_outdoor", s(rj.zinout));
  set("theme", s(rj.ztheme));
  set("watts", s(v.watts));
  set("finish", s(v.finish));
  set("lumens", s(v.lumens));
  set("cri", s(v.cri));
  set("input_voltage", s(v.volt_in));
  set("cct", s(v.cct_desc));
  set("beam_angle", s(v.beam_desc));
  set("ip_rating", s(v.ip_rating));
  set("dimensions", formatDims(v.dimensions_mm) ?? formatDims(p.dimensions_mm) ?? undefined);
  const image = (v.image_urls && v.image_urls[0]) || s(p.primary_image_url);
  set("image_url", image);
  // hs_images is HubSpot's standard product-image field — it drives the
  // thumbnail shown in the UI (the custom image_url does not).
  set("hs_images", image);
  set("ies_url", s(v.ies_url) ?? s(p.ies_url));
  // Product URL: the Sales Layer feed carries no product-page URL, so per spec
  // fall back to the product image (a variant-specific page URL would take
  // precedence here if the feed provided one). Use the variant image only if
  // the product has no image of its own.
  set("product_url", s(p.primary_image_url) || v.image_urls?.[0]);
  return out;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  // Populate the pdp_urls cache (scrape) and exit, without the HubSpot push —
  // lets the heavy initial scrape run from a non-CI IP.
  const resolveOnly = process.argv.includes("--resolve-only");
  const limArg = process.argv.indexOf("--limit");
  const limit = limArg >= 0 ? Number(process.argv[limArg + 1]) : Infinity;

  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Pricing → Map<sku, {c1,d1,d6,d7}> (one row per variant,sku).
  const priceRows = await loadAll<{ sku: string; variant: string; price: number | null }>(
    sb,
    "pricing",
    "sku,variant,price",
  );
  const prices: PriceMap = new Map();
  for (const r of priceRows) {
    if (r.price == null) continue;
    const e = prices.get(r.sku) ?? {};
    (e as Record<string, number>)[r.variant] = r.price;
    prices.set(r.sku, e);
  }
  console.log(`[products-sync] pricing: ${priceRows.length} rows -> ${prices.size} SKUs`);

  // Products (with folded variants).
  let products = await loadAll<Product>(
    sb,
    "products",
    "sku,name,brand,category,family,primary_image_url,image_urls,ies_url,dimensions_mm,raw_json,variants",
  );
  if (Number.isFinite(limit)) products = products.slice(0, limit);
  console.log(`[products-sync] products: ${products.length}`);

  // Resolve canonical product-page URLs (WIES method, Supabase-cached). Skipped
  // on --dry-run to avoid scraping; product_url then keeps the image fallback.
  const urlByProduct = dryRun
    ? new Map<string, string>()
    : await resolvePdpUrls(sb, products, () => new Date().toISOString());
  if (resolveOnly) {
    console.log("[products-sync] --resolve-only: pdp_urls cache populated; skipping HubSpot push.");
    return;
  }

  // Only needed for the push, which --resolve-only skips above.
  const token = env("HUBSPOT_TOKEN");

  // Sales Layer's connector exports ONLY online/visible items — there is no
  // hidden/offline row in the feed (verified: the variant STATUS field is the
  // connector's A/M/D delta flag, and none of the 297 variant fields carry a
  // Visible/Hidden value). So every exported variant material is a visible,
  // finalized SKU and gets pushed. Dedup by sku (last wins).
  const bySku = new Map<string, { id: string; idProperty: "hs_sku"; properties: Record<string, string | number> }>();
  for (const p of products) {
    const pdpUrl = urlByProduct.get(p.sku);
    for (const v of p.variants ?? []) {
      if (!v.sku) continue;
      const properties = buildProps(p, v, prices);
      // Canonical product-page URL wins; buildProps' image fallback stays when
      // the brand isn't resolvable.
      if (pdpUrl) properties.product_url = pdpUrl;
      bySku.set(v.sku, { id: v.sku, idProperty: "hs_sku", properties });
    }
  }
  const inputs = [...bySku.values()];
  const withPrice = inputs.filter((i) => "c1" in i.properties || "d1" in i.properties).length;
  console.log(`[products-sync] ${inputs.length} variant materials; ${withPrice} have pricing`);

  if (dryRun) {
    console.log("[products-sync] --dry-run: not creating properties or upserting.");
    console.log("[products-sync] sample:", JSON.stringify(inputs[0], null, 2));
    return;
  }
  if (inputs.length === 0) throw new Error("no visible variant materials to push");

  await ensureProperties(token);

  let ok = 0;
  const errors: string[] = [];
  for (let i = 0; i < inputs.length; i += UPSERT_BATCH) {
    const batch = inputs.slice(i, i + UPSERT_BATCH);
    try {
      const res = await hs<{ status: string; results?: unknown[]; numErrors?: number; errors?: unknown[] }>(
        token,
        "/crm/v3/objects/products/batch/upsert",
        { method: "POST", body: JSON.stringify({ inputs: batch }) },
      );
      ok += res.results?.length ?? batch.length;
      if (res.errors?.length) errors.push(...res.errors.map((e) => JSON.stringify(e).slice(0, 200)));
    } catch (e) {
      // A 207 multi-status surfaces here only on transport failure; record + continue.
      errors.push(String(e).slice(0, 300));
    }
    if ((i / UPSERT_BATCH) % 20 === 0) console.log(`[products-sync] upserted ~${ok}/${inputs.length}…`);
  }

  console.log(
    `[products-sync] done ${iso()}: upserted ${ok}/${inputs.length}, errors ${errors.length}`,
  );
  if (errors.length) {
    console.error("[products-sync] first errors:", errors.slice(0, 5));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
