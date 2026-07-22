import type { Env } from "./env.js";
import { serviceSupabase } from "./supabase.js";
import {
  variantAvailability,
  availabilityLabel,
  parseAuxLengthMm,
  accessoryPruneDecision,
  collectProductAccessoryRefs,
  collectVariantAccessoryRefs,
  dedupeAccessoryRefs,
  normalizeSkuKey,
  resolveAccessoryRefs,
  type AccessoryRef,
  type Availability,
  type AuxLengthsMm,
  type RawAccessoryRef,
} from "@wac/shared";

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
// Candidate variant field names carrying the SAP lifecycle code, first
// non-empty wins (the connector exports both `zusage` and `ZUSAGE`).
const ZUSAGE_VARIANT_FIELDS = ["zusage", "ZUSAGE"];
// Candidate variant field names for plant status. NONE are in the export yet;
// listed so the rule activates automatically once the connector adds the field
// (override with SALES_LAYER_PLANT_STATUS_FIELD if the real name differs).
const PLANT_STATUS_VARIANT_FIELDS = [
  "zplant_status",
  "zplantstatus",
  "plant_status",
  "zwerks",
  "zwerk",
  "werks",
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
  /** Unit-suffixed auxiliary lengths (attribute-filter plan, Addendum 2),
   * stored in mm like `dimensions_mm`. Today only `wire` (zwire_length —
   * "6 Feet" / "57\"" / "96in"); parsed by the unit-REQUIRED parser in
   * @wac/shared (a bare number is ambiguous and is dropped). */
  aux_lengths_mm: AuxLengthsMm;
  image_urls: string[];
  /** Photometric (.ies) file URL, when the variant carries one. */
  ies_url: string | null;
  /** Phase 2 normalization sources. `cct_code` is the SAP-style code
   * (`930`, `27`, `CS`, `TWA`…); `cct_desc` is the human-readable value
   * (`3000K`, `2700K/3000K`, `1800K-4000K`) that normalization parses.
   * `beam_desc` (zbeam_descript) and `volt_in` (zvoltin) feed the beam and
   * input-voltage normalizers. */
  cct_code: string | null;
  cct_desc: string | null;
  beam_desc: string | null;
  volt_in: string | null;
  /** Spec fields for SEO structured data (schema.org additionalProperty). */
  cri: string | null; // zcri
  watts: string | null; // zpwrin
  lumens: string | null; // zlmt
  ip_rating: string | null; // ziprat
  /** Supplemental dimming-range facts (dimming plan §D.4 — the PDP's
   * "Dimming: 100-5%" line): variant `zelvdim` (ELV range, e.g. "100-10") and
   * `z010dim` (0-10V range, e.g. "100-1"). Cheap PDP-parity spec data, never a
   * substitute for the tested dimming charts. */
  elv_dim: string | null;
  zero10_dim: string | null;
  /** SAP lifecycle code (A/B/W/N/P) driving site/Thom visibility. Variant-level
   * in the connector (`zusage`). N/P variants are dropped at stitch time. */
  zusage: string | null;
  /** Material plant status (DW/DV/…/UR/EX/T1/blank). NOT yet in the export —
   * null until the connector adds it (see PLANT_STATUS_VARIANT_FIELDS). */
  plant_status: string | null;
  /** Resolved availability state + customer-facing label, stamped at stitch. */
  availability?: Availability;
  availability_label?: string;
}

/**
 * A document (spec sheet / install manual) discovered on a Sales Layer file
 * field. `hash` is the connector's md5 (position 1 of `[STATUS, hash, URL]`) —
 * the content-identity key that dedupes shared family docs and drives
 * re-extraction when a file changes. In-memory only; not stored on `products`.
 */
export interface ProductDoc {
  field: string;
  url: string;
  hash: string | null;
  docType: string; // 'spec_sheet' | 'manual' | ...
  label: string;
}

export interface ProductCacheRow {
  sku: string;
  sl_id: string | null;
  name: string;
  brand: string | null;
  category: string | null;
  /** PIM family (zzfamily) — groups sibling PPIDs (e.g. CALLIOPE). */
  family: string | null;
  /** Accessories (connectors, channels, mounting kits) are hidden from the
   * Product Info workflows by default — they need no copy/SEO/normalization. */
  is_accessory: boolean;
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
  /** Spec-sheet / manual PDFs for this product (product + variant level,
   * merged and de-duplicated by URL). Populated only when doc capture runs. */
  docs: ProductDoc[];
  /** RAW product-level accessory/component refs (zmataccess / zacc / zcomp /
   * matnracc), collected at map time like `docs` (raw_json is not a reliable
   * source). Resolved + written to product_accessories post-success. */
  accessoryRefs: RawAccessoryRef[];
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
  sync(): Promise<{
    upserted: number;
    pruned: number;
    variants: number;
    docs: number;
    /** Accessory/component/replacement-part refs written to
     * product_accessories (post-dedupe), and how many of those did not
     * resolve to a synced catalog product. */
    accessories: number;
    accessories_unresolved: number;
  }>;
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
  // Plant-status field name, once the connector exports it: an explicit override
  // wins, else scan the known candidates. (Nothing matches today → plant_status
  // stays null and only the zusage N/P rule fires.)
  const plantStatusOverride = env.SALES_LAYER_PLANT_STATUS_FIELD?.trim();
  const plantStatusFields = plantStatusOverride
    ? [plantStatusOverride, ...PLANT_STATUS_VARIANT_FIELDS]
    : PLANT_STATUS_VARIANT_FIELDS;

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

      const docFields = docFieldsFrom(env);
      let schema: Record<string, SchemaEntry[]> | null = null;
      const categoryName = new Map<string, string>(); // internal ID -> name
      const products = new Map<string, ProductCacheRow>(); // internal ID -> row
      const variantsByProduct = new Map<string, VariantRow[]>();
      const variantDocsByProduct = new Map<string, ProductDoc[]>();
      // RAW variant-level accessory refs (MFF zacc pairs, replacement parts,
      // zcomp), keyed by internal product ID — collected at map time because
      // VariantRow does not retain the raw connector fields.
      const variantAccRefsByProduct = new Map<string, RawAccessoryRef[]>();
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
            family: cleanText(decodeEntities(str(p.zzfamily) ?? "")),
            is_accessory: isAccessory(p),
            dimensions_mm: {},
            primary_image_url: firstImage(p, PRODUCT_IMAGE_FIELDS),
            image_urls: collectImages(p, PRODUCT_IMAGE_FIELDS),
            ies_url: findIesUrl(p),
            variants: [],
            variant_search: null,
            raw_json: stripImages(p),
            docs: collectDocs(p, docFields),
            accessoryRefs: collectProductAccessoryRefs(p),
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
            aux_lengths_mm: variantAuxLengths(v),
            image_urls: collectImages(v, VARIANT_IMAGE_FIELDS),
            ies_url: findIesUrl(v),
            cct_code: cleanText(str(v.zcct)),
            cct_desc: cleanText(str(v.zcct_desc)),
            beam_desc: cleanText(str(v.zbeam_descript)),
            volt_in: cleanText(str(v.zvoltin)),
            cri: cleanText(str(v.zcri)),
            watts: cleanText(str(v.zpwrin)),
            lumens: cleanText(str(v.zlmt)),
            ip_rating: cleanText(str(v.ziprat)),
            elv_dim: cleanText(str(v.zelvdim)),
            zero10_dim: cleanText(str(v.z010dim)),
            zusage: pickField(v, ZUSAGE_VARIANT_FIELDS),
            plant_status: pickField(v, plantStatusFields),
          };
          if (!variant.variant_id) continue;
          const list = variantsByProduct.get(productId) ?? [];
          list.push(variant);
          variantsByProduct.set(productId, list);
          const vdocs = collectDocs(v, docFields);
          if (vdocs.length) {
            const dl = variantDocsByProduct.get(productId) ?? [];
            dl.push(...vdocs);
            variantDocsByProduct.set(productId, dl);
          }
          const vrefs = collectVariantAccessoryRefs(v);
          if (vrefs.length) {
            const rl = variantAccRefsByProduct.get(productId) ?? [];
            rl.push(...vrefs);
            variantAccRefsByProduct.set(productId, rl);
          }
        }

        url = body.next_page;
      }

      // Raw feed variant total, BEFORE the availability filter — the zero-
      // variants guard below keys on what the connector actually delivered, not
      // on what survives filtering.
      const rawVariantCount = [...variantsByProduct.values()].reduce(
        (n, l) => n + l.length,
        0,
      );

      // Availability tallies for observability (logged once per sync).
      let hiddenDropped = 0;
      let retiredLabeled = 0;
      let limitedLabeled = 0;

      // Stitch variants into products + finalize aggregate fields.
      for (const [id, product] of products) {
        const vlist = variantsByProduct.get(id) ?? [];

        // Resolve category internal ID -> human name (fall back to the ref).
        // Done first: category presence (L2/L3) feeds the availability rules.
        product.category = product.category
          ? categoryName.get(product.category) ?? product.category
          : null;

        // Availability rules (zusage/plant-status/L2-L3/PPID): stamp every
        // variant, then DROP the hidden (zusage N/P) ones so they never enter
        // the products table — excluding them from the site push and Thom in one
        // place. `hasCategory` = an L2/L3 category ref; `isPpid` = product PPID.
        const hasCategory = !!product.category;
        const isPpid = !!str(product.raw_json.zppid);
        const visible = vlist.filter((v) => {
          const state = variantAvailability({
            zusage: v.zusage,
            plantStatus: v.plant_status,
            hasCategory,
            isPpid,
          });
          v.availability = state;
          v.availability_label = availabilityLabel(state);
          if (state === "hidden") {
            hiddenDropped++;
            return false;
          }
          if (state === "retired") retiredLabeled++;
          else if (state === "limited") limitedLabeled++;
          return true;
        });
        product.variants = visible;

        // Representative dims: first variant that has any.
        const repr = visible.find((v) => Object.keys(v.dimensions_mm).length > 0);
        if (repr) product.dimensions_mm = repr.dimensions_mm;

        // Aggregate every image (product + all VISIBLE variants), de-duplicated.
        const all = new Set(product.image_urls);
        for (const v of visible) for (const u of v.image_urls) all.add(u);
        product.image_urls = [...all];
        if (!product.primary_image_url && product.image_urls.length) {
          product.primary_image_url = product.image_urls[0]!;
        }

        // IES photometry: prefer the product-level file, else the first visible
        // variant that carries one (the photometric throw is shared across
        // finishes).
        if (!product.ies_url) {
          product.ies_url = visible.find((v) => v.ies_url)?.ies_url ?? null;
        }

        // Merge variant-level docs into the product's doc set (deduped by URL).
        const vdocs = variantDocsByProduct.get(id) ?? [];
        if (vdocs.length) {
          const byUrl = new Set(product.docs.map((d) => d.url));
          for (const d of vdocs) {
            if (byUrl.has(d.url)) continue;
            byUrl.add(d.url);
            product.docs.push(d);
          }
        }

        // Searchable text: VISIBLE variant SKUs / ids / finishes (dropped N/P
        // variants must not be findable via search either).
        const terms = new Set<string>();
        for (const v of product.variants) {
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

      // Family fallback: Schonbek/Signature lines leave zzfamily empty but
      // sibling PPIDs share an identical product name (e.g. four "Calliope"
      // pages). When 2+ same-brand products share a name, that name IS the
      // family.
      const nameCounts = new Map<string, number>();
      for (const r of rows) {
        const key = `${r.brand ?? ""}|${r.name.toLowerCase()}`;
        nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
      }
      for (const r of rows) {
        if (r.family) continue;
        const key = `${r.brand ?? ""}|${r.name.toLowerCase()}`;
        if ((nameCounts.get(key) ?? 0) > 1) r.family = r.name;
      }

      // Count the VISIBLE variants on the deduped rows we actually store (not
      // the raw pre-dedup total, which double-counts regional duplicate
      // products). Post-availability-filter, so it excludes dropped N/P.
      const variantCount = rows.reduce((n, r) => n + r.variants.length, 0);

      // A 0-length pull almost always means a transient/auth error rather than
      // an empty catalog — bail without wiping the cache.
      if (rows.length === 0) {
        return { upserted: 0, pruned: 0, variants: 0, docs: 0, accessories: 0, accessories_unresolved: 0 };
      }

      // Products present but ZERO variants IN THE FEED is never a real state
      // (the entire app is variant/SKU-driven) — it means the Sales Layer
      // connector is mid-regeneration (e.g. just after a schema edit) and has
      // served its products table before the variants table repopulated.
      // Upserting now would fold `variants: []` into every product and wipe the
      // SKU-level catalog (breaking products-sync and Thom). Bail without
      // touching the cache; the next cron re-pulls once regeneration completes.
      // Keyed on the RAW feed total, not the post-filter count, so a legitimate
      // availability filter can never trip it.
      if (rawVariantCount === 0) {
        console.warn(
          `[products] ABORT: feed returned ${rows.length} products but 0 variants ` +
            `(connector likely mid-regeneration) — skipping upsert/prune to protect the cache`,
        );
        return { upserted: 0, pruned: 0, variants: 0, docs: 0, accessories: 0, accessories_unresolved: 0 };
      }

      // Availability filter summary (zusage rules). Today only N/P drops fire;
      // retired/limited stay 0 until plant status + PPID are in the export.
      console.log(
        `[products] availability: ${rawVariantCount} feed variants -> ${variantCount} visible ` +
          `(${hiddenDropped} hidden/dropped [zusage N/P], ${retiredLabeled} Retired, ${limitedLabeled} Limited)`,
      );

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

      // Doc coverage from Sales Layer alone — logged every sync (independent of
      // the capture flag) so the spec-sheet gap is visible. Many products have
      // NO spec sheet in Sales Layer (generated dynamically by the brand sites;
      // WIES Studio holds those URLs — see docs/thom-bot-deferred-sources).
      const withSpec = rows.filter((r) =>
        r.docs.some((d) => d.docType === "spec_sheet"),
      ).length;
      const withManual = rows.filter((r) =>
        r.docs.some((d) => d.docType === "manual"),
      ).length;
      console.log(
        `[products] docs (Sales Layer): ${withSpec}/${rows.length} have a spec sheet, ${withManual} have an install manual`,
      );

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
          family: r.family,
          is_accessory: r.is_accessory,
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

      // Thom Bot doc capture — dark-launched behind THOM_DOC_CAPTURE. Runs AFTER
      // the product sync has fully succeeded and is wrapped so a doc-write error
      // can never fail the daily product sync (docs are best-effort).
      let docs = 0;
      if (env.THOM_DOC_CAPTURE === "1") {
        try {
          docs = await captureDocs(admin, rows);
          console.log(`[products] captured ${docs} distinct documents (Thom KB)`);
        } catch (e) {
          console.warn(
            `[products] doc capture failed (non-fatal): ${String(e).slice(0, 200)}`,
          );
        }
      }

      // Accessory/component/replacement-part capture (plan v2.1 §A) — a
      // post-success, best-effort step like doc capture: it runs only after
      // the product upsert + the 0-rows/0-variants guards, and a failure can
      // never fail the catalog sync. No feature flag — an empty
      // product_accessories table is the natural dark launch.
      let accessories = 0;
      let accessoriesUnresolved = 0;
      try {
        const r = await captureAccessories(
          admin,
          rows,
          variantAccRefsByProduct,
          variantsByProduct,
          syncedAt,
        );
        accessories = r.captured;
        accessoriesUnresolved = r.unresolved;
      } catch (e) {
        console.warn(
          `[products] accessory capture failed (non-fatal): ${String(e).slice(0, 200)}`,
        );
      }

      // Spec matview refresh (0064) — product_spec_filter / product_spec_rank
      // read the MATERIALIZED product_variant_spec_mat, which only changes on
      // refresh. Same post-success best-effort idiom as doc/accessory capture:
      // runs only after the upsert + guards, and a refresh failure can never
      // fail the catalog sync (the filter surface just stays one sync stale).
      await refreshSpecMatview(admin);

      return {
        upserted: rows.length,
        pruned: pruned?.length ?? 0,
        variants: variantCount,
        docs,
        accessories,
        accessories_unresolved: accessoriesUnresolved,
      };
    },
  };
}

// -----------------------------------------------------------------------------
// Row / field helpers
// -----------------------------------------------------------------------------

/** Map a positional row to a { fieldName: value } object using its schema. */
/** Accessory detection: the PIM marks these via mount type / fixture type /
 * product type, with the name as a fallback signal. */
function isAccessory(p: Record<string, unknown>): boolean {
  for (const key of ["zmntyp", "zzfixture", "zprdtyp"]) {
    const v = str(p[key]);
    if (v && /accessor/i.test(v)) return true;
  }
  const name = str(p.product_name);
  return !!name && /\baccessor(y|ies)\b/i.test(name);
}

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

/** First non-empty value among a list of candidate field names on a mapped row. */
function pickField(row: Record<string, unknown>, fields: string[]): string | null {
  for (const f of fields) {
    const v = str(row[f]);
    if (v) return v;
  }
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

/**
 * Unit-suffixed auxiliary lengths (attribute-filter plan, Addendum 2). The
 * build-gate audit of the 298-field variant schema found `zwire_length` the
 * only viable field (5.7% populated, unit shapes `# Feet`/`#"`/`#'`/`# Inches`/
 * `#in`/`#ft`); its bare-number rows (~10%) are ambiguous and parse to null.
 * zsuspen_min/max are bare-number dominant and deferred (see auxLength.ts).
 */
function variantAuxLengths(v: Record<string, unknown>): AuxLengthsMm {
  const wire = parseAuxLengthMm(str(v.zwire_length));
  return wire !== null ? { wire } : {};
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

// -----------------------------------------------------------------------------
// Document capture (Thom Bot) — spec sheets & install manuals
// -----------------------------------------------------------------------------

/**
 * Sales Layer FILE-type fields that carry Thom-ingestible files, confirmed
 * against the live connector schema (2026-07). All exist on products AND
 * variants; the variant-level `dim_report` pass is a harmless accepted no-op
 * (audited 0/8,611 populated — dimming plan DC13). `dim_report` is the DIMMING
 * COMPATIBILITY report (a per-fixture dimmer test chart, sometimes a `.zip` of
 * per-size PDFs) — captured here for the download button + the structured
 * `--dimming` extraction, and NEVER chunked/embedded (docs-ingest Step B
 * excludes doc_type 'dimming_report' at the SQL level, DC7). Others are
 * deferred (see docs/thom-bot-deferred-sources): `ftc_label_pdf` is sparse;
 * `ies_files`/`revit` are binary. Override with SALES_LAYER_DOC_FIELDS (CSV).
 */
const DEFAULT_DOC_FIELDS = ["specsheet_pdf", "inst_sheet", "dim_report"];

export function docFieldsFrom(env: Env): string[] {
  const override = env.SALES_LAYER_DOC_FIELDS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return override && override.length ? override : DEFAULT_DOC_FIELDS;
}

/** Map a Sales Layer file-field name to a Thom doc_type + button label. */
export function docTypeForField(field: string): { docType: string; label: string } {
  if (/spec/i.test(field)) return { docType: "spec_sheet", label: "Specification Sheet" };
  if (/inst|manual/i.test(field)) return { docType: "manual", label: "Installation Manual" };
  if (/ftc/i.test(field)) return { docType: "ftc_label", label: "Lighting Facts Label" };
  // NOT a dimensional drawing: `dim_report` is the dimming-compatibility test
  // chart (dimming plan audit — the v1 "Dimensional Report" label was wrong).
  if (/dim/i.test(field)) return { docType: "dimming_report", label: "Dimming Compatibility Report" };
  return { docType: "document", label: "Document" };
}

interface FileEntry {
  hash: string | null;
  url: string;
}

/**
 * Pull `{hash, url}` pairs out of a connector FILE field. Shape is
 * `[[STATUS, hash, URL], ...]` (position 1 = md5 hash, position 2 = URL), but
 * a single field may arrive as one bare `[STATUS, hash, URL]` entry too — both
 * are handled. Unlike extractImageUrls (which discards everything but the URL),
 * this keeps the hash, the natural change-detection key. The `>1` length guard
 * skips the single-char `"M"`/`"D"` status flag when picking the hash.
 */
export function extractFileEntries(v: unknown): FileEntry[] {
  const out: FileEntry[] = [];
  if (!Array.isArray(v)) return out;
  const entries = v.some((e) => Array.isArray(e)) ? v : [v];
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    let url: string | null = null;
    let hash: string | null = null;
    for (const el of entry) {
      if (typeof el !== "string") continue;
      if (/^https?:\/\//i.test(el)) {
        if (!url) url = el;
      } else if (el.length > 1 && !hash) {
        hash = el;
      }
    }
    if (url) out.push({ hash, url });
  }
  return out;
}

/** All docs across the given file fields for one row, de-duplicated by URL. */
export function collectDocs(
  row: Record<string, unknown>,
  fields: string[],
): ProductDoc[] {
  const out: ProductDoc[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    const { docType, label } = docTypeForField(field);
    for (const { hash, url } of extractFileEntries(row[field])) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ field, url, hash, docType, label });
    }
  }
  return out;
}

/**
 * Write the discovered docs into the Thom knowledge base:
 *  - `kb_documents` keyed by content hash (`external_id`), so ONE row per unique
 *    file (shared family sheets dedupe) — a changed file = new hash = a fresh
 *    `pending_extract` row the ingest CLI picks up. `status` is omitted from the
 *    payload so new rows default to `pending_extract` and unchanged rows keep
 *    their existing status (no needless re-extraction).
 *  - `product_documents` fans each file out to every SKU that references it.
 * Idempotent upserts; a `synced_at`-based prune of superseded links is deferred
 * (docs/thom-bot-deferred-sources). Returns the count of distinct documents.
 */
async function captureDocs(
  admin: ReturnType<typeof serviceSupabase>,
  rows: ProductCacheRow[],
): Promise<number> {
  interface DistinctDoc {
    extId: string;
    docType: string;
    url: string;
    hash: string | null;
    brand: string | null;
    title: string;
  }
  const distinct = new Map<string, DistinctDoc>(); // extId -> doc
  const links: {
    extId: string;
    sku: string;
    family: string | null;
    docType: string;
    label: string;
    url: string;
  }[] = [];

  for (const r of rows) {
    for (const d of r.docs) {
      const extId = d.hash ?? d.url; // hash is the content identity; url fallback
      if (!distinct.has(extId)) {
        distinct.set(extId, {
          extId,
          docType: d.docType,
          url: d.url,
          hash: d.hash,
          brand: r.brand,
          title: `${r.name} — ${d.label}`,
        });
      }
      links.push({
        extId,
        sku: r.sku,
        family: r.family,
        docType: d.docType,
        label: d.label,
        url: d.url,
      });
    }
  }
  if (!distinct.size) return 0;

  const CHUNK = 300;

  // 1) Upsert kb_documents; collect the id per external_id.
  const idByExtId = new Map<string, string>();
  const docRows = [...distinct.values()];
  for (let i = 0; i < docRows.length; i += CHUNK) {
    const chunk = docRows.slice(i, i + CHUNK).map((d) => ({
      source_system: "sales_layer",
      external_id: d.extId,
      doc_type: d.docType,
      scope: "public",
      brand: d.brand,
      title: d.title,
      url: d.url,
      content_hash: d.hash,
    }));
    const { data, error } = await admin
      .from("kb_documents")
      .upsert(chunk, { onConflict: "source_system,external_id" })
      .select("id, external_id");
    if (error) throw new Error(`kb_documents upsert failed: ${error.message}`);
    for (const row of data ?? []) {
      idByExtId.set(row.external_id as string, row.id as string);
    }
  }

  // 2) Upsert product_documents (dedup by (document_id, product_sku) so one
  //    payload never hits the same conflict key twice).
  const linkSeen = new Set<string>();
  const linkRows: Record<string, unknown>[] = [];
  for (const l of links) {
    const document_id = idByExtId.get(l.extId);
    if (!document_id) continue;
    const key = `${document_id}|${l.sku}`;
    if (linkSeen.has(key)) continue;
    linkSeen.add(key);
    linkRows.push({
      document_id,
      product_sku: l.sku,
      family: l.family,
      doc_type: l.docType,
      label: l.label,
      url: l.url,
      scope: "public",
    });
  }
  for (let i = 0; i < linkRows.length; i += CHUNK) {
    const { error } = await admin
      .from("product_documents")
      .upsert(linkRows.slice(i, i + CHUNK), {
        onConflict: "document_id,product_sku",
      });
    if (error) throw new Error(`product_documents upsert failed: ${error.message}`);
  }

  return distinct.size;
}

// -----------------------------------------------------------------------------
// Accessory capture (Thom Bot) — product_accessories writer
// -----------------------------------------------------------------------------

/**
 * Resolve + write the accessory/component/replacement-part refs collected at
 * map time into `product_accessories` (plan v2.1 §A). Pure logic lives in
 * @wac/shared (accessories/parse.ts); this function only wires the maps and
 * talks to Supabase.
 *
 *  - Variant-code resolution uses an index built from the RAW pre-filter
 *    variant lists (zusage N/P variants are dropped from products.variants,
 *    but resolution is identity, not visibility), trim/uppercase-normalized
 *    on both sides (AA7). The raw code is stored regardless.
 *  - In-payload dedup on the upsert's conflict key (AA8/AA10).
 *  - Prune is source-scoped `synced_at < stamp` (AA2), behind the PL7
 *    mass-delete guard: if this run's capture collapses toward zero while
 *    previously-referenced products are still in the feed, the prune is
 *    ABORTED with a warning (connector-regen wipe hazard, same philosophy as
 *    the zero-variants guard).
 */
async function captureAccessories(
  admin: ReturnType<typeof serviceSupabase>,
  rows: ProductCacheRow[],
  variantAccRefsByProduct: Map<string, RawAccessoryRef[]>,
  rawVariantsByProduct: Map<string, VariantRow[]>,
  syncedAt: string,
): Promise<{ captured: number; unresolved: number }> {
  // Normalized products.sku -> canonical sku (zmataccess PPID resolution).
  const productByNorm = new Map<string, string>();
  for (const r of rows) productByNorm.set(normalizeSkuKey(r.sku), r.sku);

  // Normalized RAW variant SKU -> parent products.sku (code resolution).
  const variantParentByNorm = new Map<string, string>();
  for (const r of rows) {
    if (!r.sl_id) continue;
    for (const v of rawVariantsByProduct.get(r.sl_id) ?? []) {
      if (!v.sku) continue;
      const key = normalizeSkuKey(v.sku);
      if (!variantParentByNorm.has(key)) variantParentByNorm.set(key, r.sku);
    }
  }

  const resolved: AccessoryRef[] = [];
  for (const r of rows) {
    const raw = [
      ...r.accessoryRefs,
      ...(r.sl_id ? variantAccRefsByProduct.get(r.sl_id) ?? [] : []),
    ];
    if (!raw.length) continue;
    resolved.push(
      ...resolveAccessoryRefs(r.sku, raw, productByNorm, variantParentByNorm),
    );
  }
  const refs = dedupeAccessoryRefs(resolved);
  const unresolved = refs.filter((r) => !r.related_product_sku).length;
  const productCount = new Set(refs.map((r) => r.product_sku)).size;

  // PL7 mass-delete guard inputs: current row count + a bounded sample of the
  // product SKUs that currently carry refs (the signal is "still in the
  // feed?", so a 1,000-row sample is plenty).
  const { count: previous, error: countErr } = await admin
    .from("product_accessories")
    .select("id", { count: "exact", head: true })
    .eq("source_system", "sales_layer");
  if (countErr) throw new Error(`product_accessories count failed: ${countErr.message}`);
  let previousProductSkus: string[] = [];
  if (previous) {
    const { data, error } = await admin
      .from("product_accessories")
      .select("product_sku")
      .eq("source_system", "sales_layer")
      .limit(1000);
    if (error) throw new Error(`product_accessories sample failed: ${error.message}`);
    previousProductSkus = ((data ?? []) as { product_sku: string }[]).map((d) => d.product_sku);
  }

  const CHUNK = 300;
  for (let i = 0; i < refs.length; i += CHUNK) {
    const chunk = refs.slice(i, i + CHUNK).map((r) => ({
      product_sku: r.product_sku,
      related_sku: r.related_sku,
      related_product_sku: r.related_product_sku,
      kind: r.kind,
      label: r.label,
      source_system: "sales_layer",
      source_field: r.source_field,
      position: r.position,
      synced_at: syncedAt,
    }));
    const { error } = await admin
      .from("product_accessories")
      .upsert(chunk, { onConflict: "product_sku,related_sku,kind,source_system" });
    if (error) throw new Error(`product_accessories upsert failed: ${error.message}`);
  }

  const decision = accessoryPruneDecision({
    captured: refs.length,
    previous: previous ?? 0,
    previousProductSkus,
    feedSkus: new Set(rows.map((r) => r.sku)),
  });
  let prunedCount = 0;
  if (decision.prune) {
    const { data: prunedRows, error: pruneErr } = await admin
      .from("product_accessories")
      .delete()
      .eq("source_system", "sales_layer")
      .lt("synced_at", syncedAt)
      .select("id");
    if (pruneErr) throw new Error(`product_accessories prune failed: ${pruneErr.message}`);
    prunedCount = prunedRows?.length ?? 0;
  } else {
    console.warn(`[products] ${decision.warn}`);
  }

  console.log(
    `[products] accessories: ${refs.length} refs across ${productCount} products ` +
      `(${unresolved} unresolved), pruned ${prunedCount}`,
  );
  return { captured: refs.length, unresolved };
}

// -----------------------------------------------------------------------------
// Spec matview refresh (0064) — product_variant_spec_mat feeds the
// product_spec_filter / product_spec_rank surfaces and only changes on
// REFRESH, so the sync triggers one after every successful catalog run.
// -----------------------------------------------------------------------------

/** Minimal client surface so tests can stub the service-role client. */
export interface SpecMatviewRpcClient {
  rpc(fn: "refresh_product_spec_mat"): PromiseLike<{ error: { message: string } | null }>;
}

/**
 * Refresh the materialized spec view via the service-role-only
 * `refresh_product_spec_mat()` RPC (migration 0064). Best-effort by contract:
 * logs the duration on success, warns on failure, NEVER throws — a stale
 * filter surface (at most one sync behind) beats a failed product sync.
 */
export async function refreshSpecMatview(
  admin: SpecMatviewRpcClient,
): Promise<{ ok: boolean; ms: number }> {
  const t0 = Date.now();
  try {
    const { error } = await admin.rpc("refresh_product_spec_mat");
    if (error) throw new Error(error.message);
    const ms = Date.now() - t0;
    console.log(`[products] spec matview refreshed in ${ms}ms (refresh_product_spec_mat)`);
    return { ok: true, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    console.warn(
      `[products] spec matview refresh failed (non-fatal, ${ms}ms): ${String(e).slice(0, 200)}`,
    );
    return { ok: false, ms };
  }
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
