import type { ClaudeTool } from "./transport.js";
import type { ThomSurface } from "./env.js";
import { normalizeSkuKey } from "../accessories/parse.js";
import { authorityWeightFor, detectDocsQueryIntent, type DocsQueryIntent } from "./authority.js";
import { embedQuery } from "./embed.js";
import { DIMMING_TOOL_NAMES, dimmingDispatch } from "./dimmingTools.js";
import { layoutDispatch } from "./layoutTool.js";
import { photometricsDispatch } from "./photometricsTools.js";
import type {
  Citation,
  FamilyCard,
  FamilyMember,
  KeySpec,
  ProductCard,
  ToolContext,
  ToolOutput,
} from "./types.js";

/** Cap on how many family members ride on a single FamilyCard (the full count
 *  is still reported via member_count). */
export const MAX_FAMILY_MEMBERS = 12;

/** Return a PDP url only if it points at a real product page. The resolver now
 *  writes url = null (not a search fallback) when it can't resolve a canonical
 *  page, so this is defense-in-depth for legacy `?s=term` rows still in the
 *  cache until the backfill (`--refresh-unresolved`) heals them: those searches
 *  key on the internal numeric SKU, never resolve, and would be a dead "View
 *  product" link — treat any search-result url as no link. */
export function canonicalPdp(url: unknown): string | null {
  const u = typeof url === "string" ? url.trim() : "";
  if (!u) return null;
  if (/[?&]s=/i.test(u)) return null; // brand-site search results, not a product page
  return u;
}

/** Tool JSON schemas advertised to Claude. The cache breakpoint after the tool
 *  block is owned by agent.ts (withTailCache), which composes this set with any
 *  injected internal-only tools (e.g. HubSpot CRM) and marks the tail — so
 *  nothing here carries a static cache_control that could strand a mid-array
 *  breakpoint. */
export const TOOLS: ClaudeTool[] = [
  {
    name: "search_products",
    description:
      "Find WAC Group products by natural-language description, use case, or identifier (name, SKU, family). Hybrid keyword + semantic search. Returns a ranked list of SKUs + names; call get_product for full details.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, e.g. 'warm-dim 3-inch downlight for a damp location'." },
        brand: { type: "string", description: "Optional brand filter: WAC Lighting, Modern Forms, Schonbek, or AiSpire." },
        category: { type: "string", description: "Optional category filter." },
        limit: { type: "integer", description: "Max results (default 8)." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_product",
    description:
      "Full detail for one product by SKU/PPID: specs across its variants (wattage, lumens, CCT, CRI, IP, finish, dimensions), plus its spec-sheet / manual downloads, product-page URL, CONFIRMED accessories/components/replacement parts (from catalog reference data), and what the product itself fits (reverse compatibility). Also resolves accessory codes and variant SKUs: if the input is not a product page it reports which products it fits. Use this to render a product card, answer spec questions, and answer 'what accessories fit X' / 'what does this accessory fit'.",
    input_schema: {
      type: "object",
      properties: { sku: { type: "string", description: "The product SKU / PPID." } },
      required: ["sku"],
    },
  },
  {
    name: "get_related_products",
    description:
      "List products related to a product, in TWO sections: first its CONFIRMED accessories/components/replacement parts (explicit catalog reference data — authoritative fitment), then the OTHER products in the same family or category (verify fitment) — e.g. every component of a track SYSTEM (channel, track heads, transformer/power supply, connectors, joiners, end caps, covers). Use this to build a complete parts/component list for a project. Pass a sku to find its confirmed accessories and siblings, or an explicit family/category.",
    input_schema: {
      type: "object",
      properties: {
        sku: { type: "string", description: "A product SKU whose family/category to expand." },
        family: { type: "string", description: "Explicit product family." },
        category: { type: "string", description: "Explicit product category, e.g. 'Outdoor Track System'." },
        limit: { type: "integer", description: "Max results (default 60)." },
      },
    },
  },
  {
    name: "get_family",
    description:
      "Return a whole product SYSTEM/family as ONE card (its member components) — for system/parts questions, not a single SKU. Use this when the user is asking about an entire system (e.g. an outdoor track system: channel + heads + transformer + connectors) so they get one family-level card representing the system rather than N separate product cards. Pass a sku to expand its family/category, or an explicit family/category.",
    input_schema: {
      type: "object",
      properties: {
        sku: { type: "string", description: "A product SKU whose family/category to expand into a system card." },
        family: { type: "string", description: "Explicit product family." },
        category: { type: "string", description: "Explicit product category, e.g. 'Outdoor Track System'." },
        limit: { type: "integer", description: "Max members to fetch (default 60)." },
      },
    },
  },
  {
    name: "search_docs",
    description:
      "Search the CONTENTS of spec sheets, installation manuals, curated WAC marketing overviews/positioning/FAQs, WAC Help Center (support) articles, WAC Group brand-website pages (company/about, capabilities, technology, news, FAQs, warranty), official WAC Architectural PRODUCT pages (that brand is not in the product catalog yet — this is where its products live, with separate Domestic and International lines), lighting-education references (energy codes and adoption guides, design guides, lighting fundamentals and terminology), AND internal support-ticket resolutions (how a real customer issue was diagnosed and fixed) for a specific fact (cutout size, dimming compatibility, mounting, torque, wiring, exact photometrics), WAC's own product/brand/system positioning and messaging, company background and capabilities, general lighting-design or code guidance, or how-to / troubleshooting / warranty / support guidance. Returns matching passages with the document + link (and page, for PDFs) for citation.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The specific thing to find in the documents." },
        brand: { type: "string", description: "Optional brand filter." },
      },
      required: ["query"],
    },
  },
];

/** Coarse class buckets stamped by the 0063 base view (product_variant_spec_view,
 *  inherited by product_spec_view) — mirrored here only for the tool schemas'
 *  enum; the regex itself is SQL-side by design (a TS mirror was rejected:
 *  drift risk > test value). 0063 added `wall` (bath/vanity/sconce — plan O9)
 *  and `ceiling` (flush/semi-flush/ceiling — needed by the class-aware depth
 *  rule). */
export const SPEC_RANK_CLASSES = [
  "per-foot",
  "fan",
  "downlight",
  "track",
  "outdoor",
  "wall",
  "ceiling",
  "linear",
  "decorative",
  "other",
] as const;

/** Spec-rank tool schema. Split from TOOLS (mirroring PHOTOMETRICS_TOOLS) and
 *  composed onto the set by agent.ts only when THOM_SPEC_RANK === "1"
 *  (dark-launch). */
export const SPEC_RANK_TOOLS: ClaudeTool[] = [
  {
    name: "rank_products_by_spec",
    description:
      "Rank WAC Group catalog products by a NUMERIC spec — lumens (light output), watts (power draw), or efficacy (lm/W) — highest or lowest. Use this for ANY superlative question ('brightest', 'highest output', 'most powerful', 'most efficient', 'lowest wattage') instead of semantic search. Results come grouped by fixture class (outdoor, track, downlight, linear, decorative, fan) with per-foot products (tape/strip) ranked separately by watts/ft, plus an honest coverage count — not every product carries numeric output data. Follow up with get_product for a specific product's card.",
    input_schema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: ["lumens", "watts", "efficacy"],
          description: "The spec to rank by.",
        },
        direction: {
          type: "string",
          enum: ["highest", "lowest"],
          description: "Rank direction (default highest).",
        },
        brand: { type: "string", description: "Optional brand filter: WAC Lighting, Modern Forms, Schonbek, or AiSpire." },
        category: { type: "string", description: "Optional catalog category filter (free text — may not match catalog wording exactly)." },
        class: {
          type: "string",
          enum: [...SPEC_RANK_CLASSES],
          description: "Optional fixture-class filter.",
        },
        per_foot: {
          type: "boolean",
          description: "Rank per-foot products (tape/strip) by watts per foot instead of whole-fixture figures.",
        },
        limit: { type: "integer", description: "Max results (default 10, cap 25)." },
      },
      required: ["metric"],
    },
  },
];

/** Filter tool schema (attribute-filter plan §B). Split from TOOLS (mirroring
 *  SPEC_RANK_TOOLS) and composed onto the set by agent.ts only when
 *  THOM_SPEC_FILTER === "1" (dark-launch). */
export const FILTER_TOOLS: ClaudeTool[] = [
  {
    name: "filter_products",
    description:
      "Filter WAC Group catalog products by HARD numeric constraints, evaluated per size/variant: " +
      "width, depth (wall projection or ceiling drop), height, wire/cord length, lumens, watts, " +
      "efficacy (lm/W), color temperature (a CCT kelvin band; a single kelvin = equal bounds), CRI, and IP rating. " +
      "Use this for ANY question that states a numeric limit (a maximum or minimum size, brightness, wattage, " +
      "color temperature, CRI, or IP rating) instead of search_products. " +
      "Every returned product genuinely satisfies ALL stated constraints on a single variant; products missing " +
      "catalog data for a constraint are excluded, never assumed to fit. " +
      "Dimensions default to inches; when the user speaks in another unit pass it via `unit` and give their " +
      "numbers unchanged, do not convert them yourself. " +
      "'wide'/'across'/'long' means width; 'deep'/'projection'/'extension' means depth; an ADA wall-fixture " +
      "question means max_depth_in 4. Always pass EVERY constraint the user stated, plus the descriptive part " +
      "of the request (for example 'vanity light') as query so results are ordered by fit. " +
      "Follow up with get_product for a specific product's card.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Descriptive part of the request for semantic ordering, e.g. 'vanity light', 'outdoor sconce'." },
        unit: {
          type: "string",
          enum: ["in", "ft", "cm", "mm"],
          description: "Unit of every dimension value passed (default in). Pass the user's own unit; never convert.",
        },
        max_width_in: { type: "number", description: "Maximum width (largest horizontal extent)." },
        min_width_in: { type: "number", description: "Minimum width." },
        max_depth_in: { type: "number", description: "Maximum depth: wall projection for wall fixtures, drop for ceiling fixtures." },
        min_depth_in: { type: "number", description: "Minimum depth." },
        max_height_in: { type: "number", description: "Maximum height." },
        min_height_in: { type: "number", description: "Minimum height." },
        min_wire_length: { type: "number", description: "Minimum wire/cord/suspension length (same unit as the other dimensions)." },
        max_wire_length: { type: "number", description: "Maximum wire/cord/suspension length." },
        min_lumens: { type: "number", description: "Minimum light output in lumens." },
        max_lumens: { type: "number", description: "Maximum light output in lumens." },
        max_watts: { type: "number", description: "Maximum power draw in watts." },
        min_watts: { type: "number", description: "Minimum power draw in watts." },
        min_efficacy: { type: "number", description: "Minimum efficacy in lm/W." },
        cct_min_k: { type: "integer", description: "Lowest acceptable color temperature in kelvin (single kelvin = pass the same value as cct_max_k)." },
        cct_max_k: { type: "integer", description: "Highest acceptable color temperature in kelvin." },
        min_cri: { type: "integer", description: "Minimum CRI." },
        min_ip: { type: "integer", description: "Minimum IP rating, e.g. 65." },
        brand: { type: "string", description: "Optional brand filter: WAC Lighting, Modern Forms, Schonbek, or AiSpire." },
        category: { type: "string", description: "Optional catalog category filter (free text — may not match catalog wording exactly)." },
        class: {
          type: "string",
          enum: [...SPEC_RANK_CLASSES],
          description: "Optional fixture-class filter (wall = bath/vanity/sconce).",
        },
        limit: { type: "integer", description: "Max results (default 10, cap 25)." },
      },
    },
  },
];

/** The flag-respecting search_products back-pointer (plan O3): appended to the
 *  search_products description ONLY when THOM_SPEC_FILTER=1 — a static edit
 *  would advertise an unavailable tool with the flag off (the R3 rule). */
export const SEARCH_PRODUCTS_FILTER_POINTER =
  " For questions that state a numeric limit (a maximum or minimum size, brightness, wattage, color temperature, CRI, or IP rating), use filter_products instead of this tool.";

/** Append the constraint back-pointer to search_products. Pure — returns fresh
 *  objects; never mutates the shared TOOLS constant. */
export function withConstraintRouting(tools: ClaudeTool[]): ClaudeTool[] {
  return tools.map((t) =>
    t.name === "search_products"
      ? { ...t, description: t.description + SEARCH_PRODUCTS_FILTER_POINTER }
      : t,
  );
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// --- individual tools -------------------------------------------------------

async function searchProducts(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutput> {
  const query = String(input.query ?? "").trim();
  if (!query) return { content: "search_products: query is required.", cards: [], citations: [] };
  const embedding = await embedQuery(ctx.env, query);
  const { data, error } = await ctx.sb.rpc("product_semantic_search", {
    query_embedding: embedding,
    query_text: query,
    brand_filter: str(input.brand),
    category_filter: str(input.category),
    match_count: Math.min(Number(input.limit) || 8, 20),
  });
  if (error) return { content: `search_products error: ${error.message}`, cards: [], citations: [] };
  const rows = (data ?? []) as { sku: string; name: string; brand: string | null }[];
  if (!rows.length) return { content: "No matching products.", cards: [], citations: [] };
  const content = rows
    .map((r) => `- ${r.sku} — ${r.name}${r.brand ? ` (${r.brand})` : ""}`)
    .join("\n");
  return { content, cards: [], citations: [] };
}

// --- compatibility / accessories (plan v2.1 §B) ------------------------------

/** One product_accessories row as the tools read it. */
export interface ProductAccessoryRow {
  related_sku: string;
  related_product_sku: string | null;
  kind: string;
  label: string | null;
}

/** Minimal product info used to render a resolved accessory parent / a
 *  reverse-fit referencing product by NAME (never a bare PPID list). */
export interface AccessoryParentInfo {
  name: string | null;
  brand: string | null;
}

/** Cap on rendered accessory lines (MAX_FAMILY_MEMBERS idiom, AA13). */
export const MAX_ACCESSORY_LINES = 30;
/** Cap on raw option codes shown per resolved parent group. */
const MAX_GROUP_CODES = 8;
/** Cap on families enumerated in a reverse-fit rollup (PL1b). */
export const MAX_REVERSE_FAMILIES = 10;

function kindLabel(kind: string): string {
  return kind === "replacement_part" ? "replacement part" : kind;
}

function kindPlural(kind: string, n: number): string {
  if (n === 1) return kindLabel(kind);
  if (kind === "accessory") return "accessories";
  return `${kindLabel(kind)}s`;
}

/**
 * Render accessory rows GROUPED BY RESOLVED PARENT with variant-code collapse
 * (PL5): eleven finish variants of one lens product become ONE line naming the
 * parent, never eleven rows. Unresolved rows follow — on the PUBLIC surface a
 * raw code is never shown bare (PL8a): labeled rows keep their label, and
 * label-less unresolved rows collapse into per-kind "available through your
 * WAC Group sales rep" lines. Capped at MAX_ACCESSORY_LINES with "+N more".
 * Pure, so grouping/caps/public framing are unit-testable.
 */
export function formatAccessoryLines(
  rows: readonly ProductAccessoryRow[],
  parents: ReadonlyMap<string, AccessoryParentInfo>,
  surface: ThomSurface,
): string[] {
  // Group resolved rows by parent PPID, first-seen order.
  const groups = new Map<string, { kind: string; codes: string[]; label: string | null }>();
  const unresolved: ProductAccessoryRow[] = [];
  for (const r of rows) {
    if (!r.related_product_sku) {
      unresolved.push(r);
      continue;
    }
    const g = groups.get(r.related_product_sku);
    if (!g) {
      groups.set(r.related_product_sku, { kind: r.kind, codes: [r.related_sku], label: r.label });
    } else {
      if (!g.codes.includes(r.related_sku)) g.codes.push(r.related_sku);
      if (!g.label && r.label) g.label = r.label;
    }
  }

  const lines: string[] = [];
  for (const [parentSku, g] of groups) {
    const info = parents.get(parentSku);
    const name = info?.name ?? g.label ?? parentSku;
    const brand = info?.brand ? `, ${info.brand}` : "";
    let options = "";
    const distinct = g.codes.filter((c) => normalizeSkuKey(c) !== normalizeSkuKey(parentSku));
    if (distinct.length) {
      const shown = distinct.slice(0, MAX_GROUP_CODES).join(", ");
      const more = distinct.length > MAX_GROUP_CODES ? `, +${distinct.length - MAX_GROUP_CODES} more` : "";
      options = ` (${distinct.length} option${distinct.length === 1 ? "" : "s"}: ${shown}${more})`;
    }
    lines.push(`- ${name} (SKU ${parentSku}${brand}) [${kindLabel(g.kind)}]${options}`);
  }

  if (surface === "public") {
    // Labeled unresolved rows keep the human label; bare codes NEVER surface.
    const unlabeledByKind = new Map<string, number>();
    for (const r of unresolved) {
      if (r.label) {
        lines.push(`- ${r.label} [${kindLabel(r.kind)}] (available through your WAC Group sales rep)`);
      } else {
        unlabeledByKind.set(r.kind, (unlabeledByKind.get(r.kind) ?? 0) + 1);
      }
    }
    for (const [kind, n] of unlabeledByKind) {
      lines.push(
        `- ${n} additional ${kindPlural(kind, n)} available through your WAC Group sales rep`,
      );
    }
  } else {
    for (const r of unresolved) {
      const head = r.label ? `${r.label} (code ${r.related_sku})` : `Code ${r.related_sku}`;
      lines.push(`- ${head} [${kindLabel(r.kind)}] (not a catalog product page; order through sales)`);
    }
  }

  if (lines.length > MAX_ACCESSORY_LINES) {
    const extra = lines.length - MAX_ACCESSORY_LINES;
    return [...lines.slice(0, MAX_ACCESSORY_LINES), `(+${extra} more)`];
  }
  return lines;
}

/** A referencing (host) product for the reverse-fit rollup. */
export interface ReverseFitParent {
  sku: string;
  name: string | null;
  family: string | null;
  brand: string | null;
}

/**
 * Fan-in rollup for reverse fit (PL1b): "what does this lens fit?" can have
 * 100+ hosts, so ≤5 hosts are named individually and anything bigger rolls up
 * BY FAMILY with counts — name-first, never a PPID list, families capped at
 * MAX_REVERSE_FAMILIES.
 */
export function rollupReverseFit(parents: readonly ReverseFitParent[], totalCount: number): string {
  if (!parents.length) return "";
  if (totalCount <= 5 && parents.length === totalCount) {
    const names = parents.map((p) => `${p.name ?? p.sku} (SKU ${p.sku})`).join(", ");
    return `Fits ${totalCount} product${totalCount === 1 ? "" : "s"}: ${names}.`;
  }
  const byFamily = new Map<string, number>();
  for (const p of parents) {
    const fam = p.family ?? p.name ?? p.sku;
    byFamily.set(fam, (byFamily.get(fam) ?? 0) + 1);
  }
  const sorted = [...byFamily.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, MAX_REVERSE_FAMILIES).map(([fam, n]) => `${fam} (${n})`);
  const moreFams = sorted.length - Math.min(sorted.length, MAX_REVERSE_FAMILIES);
  const famText = shown.join(", ") + (moreFams > 0 ? ` and ${moreFams} more famil${moreFams === 1 ? "y" : "ies"}` : "");
  const brands = [...new Set(parents.map((p) => p.brand).filter(Boolean))] as string[];
  const brandText = brands.length === 1 ? ` ${brands[0]}` : "";
  return `Fits ${totalCount}${brandText} products across the ${famText} families.`;
}

/** Escape LIKE/ILIKE pattern characters so a code can be matched literally
 *  (ILIKE without wildcards = case-insensitive equality). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Fetch name/family/brand for a set of skus into a map (batched .in()). */
async function fetchParentInfo(
  ctx: ToolContext,
  skus: string[],
): Promise<Map<string, ReverseFitParent>> {
  const out = new Map<string, ReverseFitParent>();
  if (!skus.length) return out;
  const { data } = await ctx.sb
    .from("products")
    .select("sku, name, family, brand")
    .in("sku", skus.slice(0, 200));
  for (const p of (data ?? []) as ReverseFitParent[]) out.set(p.sku, p);
  return out;
}

/**
 * Reverse-fit fallback when a get_product sku missed the products table
 * (AA1/PL1) — BEFORE saying "not found":
 *  1. match the input against product_accessories.related_sku (normalized /
 *     case-insensitive): an accessory code answers "what does this fit?";
 *  2. resolve the input as a VARIANT SKU via products.variant_search and
 *     retry as its parent product (both directions ride the parent's
 *     get_product output);
 *  3. only then "not found".
 */
async function reverseFitFallback(
  ctx: ToolContext,
  rawSku: string,
  surface: ThomSurface,
): Promise<ToolOutput> {
  const norm = rawSku.trim();
  const notFound: ToolOutput = {
    content: `No product found with SKU ${rawSku}.`,
    cards: [],
    citations: [],
  };
  if (!norm) return notFound;

  // (1) accessory-code match.
  const { data: refRows, count: refCount } = await ctx.sb
    .from("product_accessories")
    .select("product_sku, related_product_sku, kind, label", { count: "exact" })
    .ilike("related_sku", escapeLike(norm))
    .limit(200);
  const hits = (refRows ?? []) as {
    product_sku: string;
    related_product_sku: string | null;
    kind: string;
    label: string | null;
  }[];
  if (hits.length) {
    const hostSkus = [...new Set(hits.map((h) => h.product_sku))];
    const infoBySku = await fetchParentInfo(ctx, hostSkus);
    const parents = hostSkus
      .map((s) => infoBySku.get(s) ?? { sku: s, name: null, family: null, brand: null });
    // Distinct hosts when the window held every row; the exact total otherwise.
    const total = (refCount ?? hits.length) > hits.length ? (refCount ?? hits.length) : hostSkus.length;
    const kinds = [...new Set(hits.map((h) => kindLabel(h.kind)))].join(" / ");
    const label = hits.find((h) => h.label)?.label ?? null;
    const resolvedParent = hits.find((h) => h.related_product_sku)?.related_product_sku ?? null;
    const lines = [
      `${norm} is not a product page, but it is a confirmed ${kinds} reference${label ? ` ("${label}")` : ""}.`,
      rollupReverseFit(parents, total),
    ];
    if (resolvedParent) {
      const pinfo = infoBySku.get(resolvedParent) ?? (await fetchParentInfo(ctx, [resolvedParent])).get(resolvedParent);
      lines.push(
        `It is an option of ${pinfo?.name ?? resolvedParent} (SKU ${resolvedParent}); use get_product with ${resolvedParent} for full details.`,
      );
    }
    return { content: lines.filter(Boolean).join("\n"), cards: [], citations: [] };
  }

  // (2) variant-SKU resolution against products.variants.
  const { data: vhits } = await ctx.sb
    .from("products")
    .select("sku, name, brand, variants")
    .ilike("variant_search", `%${escapeLike(norm)}%`)
    .limit(5);
  const key = normalizeSkuKey(norm);
  const parent = ((vhits ?? []) as { sku: string; name: string | null; variants: unknown }[]).find((p) => {
    const variants = Array.isArray(p.variants) ? (p.variants as Record<string, unknown>[]) : [];
    return variants.some((v) => typeof v.sku === "string" && normalizeSkuKey(v.sku) === key);
  });
  if (parent) {
    const out = await getProduct(ctx, { sku: parent.sku }, surface);
    return {
      ...out,
      content: `${norm} is a variant of ${parent.name ?? parent.sku} (SKU ${parent.sku}).\n\n${out.content}`,
    };
  }

  // (3) genuinely nothing.
  return notFound;
}

/** One product_variant_spec_view row as get_product reads it (O1). */
export interface ProductDimRow {
  variant_sku: string | null;
  finish: string | null;
  width_mm: number | null;
  height_mm: number | null;
  length_mm: number | null;
  diameter_mm: number | null;
  wire_length_mm: number | null;
  width_in: number | null;
  depth_in: number | null;
  height_in: number | null;
  class: string | null;
}

/**
 * Per-size dimension lines for get_product (plan O1 — ship-gated with the
 * filter): each distinct size shows the RECORDED W x H x L (+ Dia) axes AND
 * the SAME derived width/depth the filter screens on (single source, zero
 * drift), all dual-unit (Addendum 1). A wire/cord line rides along when
 * present. No dimensions at all -> the explicit no-recorded-dimensions line,
 * enabling the unknown-vs-violating honesty split (O8): the model can say
 * "no recorded dimensions, check the spec sheet" instead of improvising.
 * Pure + exported for tests.
 */
export function formatProductDims(rows: ProductDimRow[]): string[] {
  const dimmed = rows.filter(
    (r) => r.width_mm != null || r.height_mm != null || r.length_mm != null || r.diameter_mm != null,
  );
  if (!dimmed.length) return ["No recorded dimensions in the catalog for this product."];
  // Distinct sizes: finishes share dims, so collapse by the recorded axes.
  const bySig = new Map<string, ProductDimRow>();
  for (const r of dimmed) {
    const sig = [r.width_mm, r.height_mm, r.length_mm, r.diameter_mm].join("|");
    if (!bySig.has(sig)) bySig.set(sig, r);
  }
  const sizes = [...bySig.values()].sort((a, b) => (a.width_in ?? 0) - (b.width_in ?? 0));
  const out = ["Sizes:"];
  for (const r of sizes) {
    const derived = [
      r.width_in != null ? `${fmtIn(r.width_in)} wide` : null,
      r.depth_in != null ? `${fmtIn(r.depth_in)} deep` : null,
      r.height_in != null ? `${fmtIn(r.height_in)} tall` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const rec = [
      r.width_mm != null ? `W ${fmtMmAsIn(r.width_mm)}` : null,
      r.height_mm != null ? `H ${fmtMmAsIn(r.height_mm)}` : null,
      r.length_mm != null ? `L ${fmtMmAsIn(r.length_mm)}` : null,
      r.diameter_mm != null ? `Dia ${fmtMmAsIn(r.diameter_mm)}` : null,
    ]
      .filter(Boolean)
      .join(" x ");
    out.push(`- ${derived ? `${derived} ` : ""}(recorded ${rec})`);
  }
  const wires = [
    ...new Set(dimmed.map((r) => r.wire_length_mm).filter((x): x is number => x != null)),
  ].sort((a, b) => a - b);
  if (wires.length) out.push(`Wire/cord length: ${wires.map(fmtWire).join(", ")}`);
  return out;
}

async function getProduct(
  ctx: ToolContext,
  input: Record<string, unknown>,
  surface: ThomSurface = "internal",
): Promise<ToolOutput> {
  const sku = String(input.sku ?? "").trim();
  if (!sku) return { content: "get_product: sku is required.", cards: [], citations: [] };

  const { data: p, error } = await ctx.sb
    .from("products")
    .select("sku, name, brand, category, primary_image_url, variants")
    .eq("sku", sku)
    .maybeSingle();
  if (error) return { content: `get_product error: ${error.message}`, cards: [], citations: [] };
  if (!p) return reverseFitFallback(ctx, sku, surface);

  const [{ data: docs }, { data: pdp }, accessoriesRes, referencedRes] = await Promise.all([
    ctx.sb.from("product_documents").select("doc_type, label, url").eq("product_sku", sku),
    ctx.sb.from("pdp_urls").select("url").eq("sku", sku).maybeSingle(),
    // Forward: this product's confirmed accessories/components (§B).
    ctx.sb
      .from("product_accessories")
      .select("related_sku, related_product_sku, kind, label")
      .eq("product_sku", sku)
      .limit(400),
    // Reverse: hosts that reference THIS product as an accessory (AA1).
    ctx.sb
      .from("product_accessories")
      .select("product_sku", { count: "exact" })
      .eq("related_product_sku", sku)
      .limit(400),
  ]);
  const accRows = (accessoriesRes.data ?? []) as ProductAccessoryRow[];
  const refRows = (referencedRes.data ?? []) as { product_sku: string }[];
  const refTotal = referencedRes.count ?? refRows.length;

  const variants = (Array.isArray(p.variants) ? p.variants : []) as Record<string, unknown>[];
  const repr = variants.find((v) => v.watts || v.lumens || v.cct_desc) ?? variants[0] ?? {};
  const key_specs: KeySpec[] = [];
  const push = (label: string, v: unknown) => {
    const s = str(v);
    if (s) key_specs.push({ label, value: s });
  };
  push("Wattage", repr.watts);
  push("Lumens", repr.lumens);
  push("CCT", repr.cct_desc);
  push("CRI", repr.cri);
  push("Beam", repr.beam_desc);
  push("Input voltage", repr.volt_in);
  push("IP rating", repr.ip_rating);
  push("Finish", repr.finish);
  // Supplemental PDP-parity dimming ranges (dimming plan §D.4) — catalog
  // attributes, independent of (and never a substitute for) the tested charts.
  const dimRanges = [
    str(repr.elv_dim) ? `ELV ${str(repr.elv_dim)}%` : null,
    str(repr.zero10_dim) ? `0-10V ${str(repr.zero10_dim)}%` : null,
  ].filter(Boolean);
  if (dimRanges.length) push("Dimming range", dimRanges.join(", "));

  // Variant availability: surface anything not plainly available so the model
  // flags retired/limited products instead of presenting them as current.
  // (Labels are stamped at stitch time; most rows are "normal" until the
  // Sales Layer export carries plant status - see product-availability notes.)
  const availLabels = [
    ...new Set(
      variants
        .map((v) => {
          const label = str(v.availability_label);
          if (label) return label;
          const a = str(v.availability);
          return a && a.toLowerCase() !== "normal" ? a : null;
        })
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  if (availLabels.length) push("Availability", availLabels.join(", "));

  // De-dup downloads by url; keep the most useful label.
  const seen = new Set<string>();
  const downloads = ((docs ?? []) as { doc_type: string; label: string | null; url: string }[])
    .filter((d) => d.url && !seen.has(d.url) && seen.add(d.url))
    .map((d) => ({ label: d.label ?? d.doc_type, url: d.url, doc_type: d.doc_type }));

  const card: ProductCard = {
    kind: "product",
    sku: p.sku as string,
    name: (p.name as string) ?? null,
    brand: (p.brand as string) ?? null,
    image_url: (p.primary_image_url as string) ?? null,
    key_specs,
    pdp_url: canonicalPdp(pdp?.url),
    downloads,
  };

  // Text summary so Claude can answer spec questions and reference the card.
  const finishes = variants.map((v) => str(v.finish)).filter(Boolean);
  const lines = [
    `${card.name ?? sku} (SKU ${sku}${card.brand ? `, ${card.brand}` : ""})`,
    key_specs.length ? key_specs.map((k) => `${k.label}: ${k.value}`).join("; ") : "No spec attributes on file.",
    variants.length ? `${variants.length} variant(s)${finishes.length ? `; finishes: ${[...new Set(finishes)].join(", ")}` : ""}.` : "",
    downloads.length ? `Documents: ${downloads.map((d) => d.label).join(", ")}.` : "No documents on file yet.",
    card.pdp_url ? `Product page: ${card.pdp_url}` : "",
  ].filter(Boolean);

  // Per-size dimensions from the 0063 variant-grain view (plan O1) — the SAME
  // derived width/depth the filter screens on, plus the recorded axes and the
  // wire/cord length, all dual-unit. Flag-gated with the filter tool (the
  // view ships in the same migration): this closes the description vs
  // implementation mismatch (the description promised dimensions; the
  // implementation never printed them, so the model improvised).
  if (ctx.env.THOM_SPEC_FILTER === "1") {
    const { data: dimData } = await ctx.sb
      .from("product_variant_spec_view")
      .select(
        "variant_sku, finish, width_mm, height_mm, length_mm, diameter_mm, wire_length_mm, width_in, depth_in, height_in, class",
      )
      .eq("sku", sku)
      .limit(200);
    lines.push(...formatProductDims((dimData ?? []) as ProductDimRow[]));
  }

  // Compatibility sections (text-only — no ProductCard change, plan §B): the
  // forward confirmed-accessory list and, when this product is itself
  // referenced as an accessory, the reverse fan-in rollup.
  if (accRows.length || refRows.length) {
    const wantSkus = new Set<string>();
    for (const r of accRows) if (r.related_product_sku) wantSkus.add(r.related_product_sku);
    for (const r of refRows) wantSkus.add(r.product_sku);
    const info = await fetchParentInfo(ctx, [...wantSkus]);
    if (accRows.length) {
      lines.push(
        `Confirmed accessories and components (${accRows.length} reference${accRows.length === 1 ? "" : "s"}, from catalog reference data):`,
        ...formatAccessoryLines(accRows, info, surface),
      );
    }
    if (refRows.length) {
      const hostSkus = [...new Set(refRows.map((r) => r.product_sku))];
      const parents = hostSkus.map(
        (s) => info.get(s) ?? { sku: s, name: null, family: null, brand: null },
      );
      // When every row was fetched, count distinct hosts (a host may reference
      // the same parent under two kinds); otherwise trust the window's total.
      const total = refTotal > refRows.length ? refTotal : hostSkus.length;
      const rollup = rollupReverseFit(parents, total);
      if (rollup) lines.push(`This product is itself a confirmed accessory. ${rollup}`);
    }
  }

  return { content: lines.join("\n"), cards: [card], citations: [] };
}

/**
 * Website-crawl doc types retrievable by search_docs on BOTH surfaces — all
 * crawled from the public web (scope='public' by construction), so the public
 * bubble may see them. web_category / web_resource are deliberately absent
 * (navigation, not answers). web_product IS included: for catalog-backed
 * brands PDP prose is never chunked (facts come from the catalog tools), so
 * the only web_product chunks that exist are WAC Architectural's — whose
 * products are NOT in the catalog yet (Sales Layer add pending) and whose
 * official product pages are therefore the sole product source.
 */
export const WEB_DOC_TYPES = [
  "web_company",
  "web_capabilities",
  "web_technology",
  "web_news",
  "web_faq",
  "web_warranty",
  "web_product",
] as const;

/** Admin-uploaded education PDFs (lighting-expert plan, Prong C). */
export const EDUCATION_DOC_TYPE = "education";

/**
 * The search_docs doc_type allowlist for a surface + query intent (plan C.3):
 * `education` joins BOTH surface allowlists, but is EXCLUDED when the query is
 * product/SKU-shaped — education chunks structurally cannot displace spec-sheet
 * chunks on the query class the team has fought contamination on (the vec
 * branch's fixed LIMIT 50 pool is the crowding risk). Company / education /
 * ambiguous intents include it. Exported pure so the gating is unit-testable.
 */
export function searchDocTypes(surface: ThomSurface, intent: DocsQueryIntent): string[] {
  const types: string[] =
    surface === "public"
      ? ["spec_sheet", "manual", "marketing", "zendesk_article", ...WEB_DOC_TYPES]
      : ["spec_sheet", "manual", "marketing", "zendesk_article", "zendesk_ticket", ...WEB_DOC_TYPES];
  if (intent !== "product") types.push(EDUCATION_DOC_TYPE);
  return types;
}

async function searchDocs(
  ctx: ToolContext,
  input: Record<string, unknown>,
  surface: ThomSurface,
): Promise<ToolOutput> {
  const query = String(input.query ?? "").trim();
  if (!query) return { content: "search_docs: query is required.", cards: [], citations: [] };
  const embedding = await embedQuery(ctx.env, query);
  // INTERNAL: scope_filter=null → RLS gates; sees public + internal, including
  // zendesk_ticket resolutions (scope='internal'). PUBLIC: scope_filter='public'
  // AND doc_types WITHOUT zendesk_ticket, so internal support-ticket resolutions
  // are never retrievable on the public surface.
  const isPublic = surface === "public";
  // Query intent drives BOTH gates below: authority weight (plan D.2) and the
  // education doc_type inclusion (plan C.3).
  const intent = detectDocsQueryIntent(query);
  // Intent-gated authority (plan D.2): product/SKU-shaped queries ALWAYS pass
  // weight 0; other intents pass the default λ only when the THOM_AUTHORITY env
  // gate is on. With the gate off this is 0 everywhere and kb_search ordering
  // is identical to pre-0054.
  const authorityWeight = authorityWeightFor(intent, ctx.env.THOM_AUTHORITY === "1");
  const { data, error } = await ctx.sb.rpc("kb_search", {
    query_embedding: embedding,
    query_text: query,
    scope_filter: isPublic ? "public" : null,
    doc_types: searchDocTypes(surface, intent),
    brand_filter: str(input.brand),
    match_count: 8,
    authority_weight: authorityWeight,
  });
  if (error) return { content: `search_docs error: ${error.message}`, cards: [], citations: [] };
  const rows = (data ?? []) as {
    document_id: string;
    doc_type: string;
    title: string | null;
    url: string | null;
    page: number | null;
    content: string;
  }[];
  if (!rows.length) {
    return {
      content: "No matching document passages (spec sheets/manuals may not be ingested yet).",
      cards: [],
      citations: [],
    };
  }
  const content = rows
    .map((r) => `[${r.title ?? r.doc_type}${r.page != null ? ` p.${r.page}` : ""}]\n${r.content}`)
    .join("\n\n---\n\n");
  const citations: Citation[] = rows.map((r) => ({
    document_id: r.document_id,
    title: r.title,
    doc_type: r.doc_type,
    page: r.page,
    url: r.url,
  }));
  return { content, cards: [], citations };
}

// --- rank_products_by_spec ---------------------------------------------------

/** One row from the product_spec_rank RPC (0059). */
interface SpecRankRow {
  sku: string;
  name: string | null;
  brand: string | null;
  class: string;
  metric_value: number | string;
  lumens_source: string | null;
  per_ft: boolean;
  in_scope_ranked: number;
  in_scope_total: number;
}

/** Format a metric value with its unit: lumens whole + thousands-separated
 *  ("2,071 lm"), watts/efficacy up to 1dp. */
function fmtMetric(v: number, metric: string, perFoot: boolean): string {
  if (perFoot) return `${Math.round(v * 10) / 10} W/ft`;
  if (metric === "lumens") return `${Math.round(v).toLocaleString("en-US")} lm`;
  if (metric === "watts") return `${Math.round(v * 10) / 10} W`;
  return `${Math.round(v * 10) / 10} lm/W`;
}

/** Render rank rows NAME-FIRST — the public persona forbids leading with bare
 *  catalog numbers, and a router-tier model will echo the tool's format — as
 *  per-class sections when grouped, a flat list otherwise. The
 *  [IES-measured]/[catalog-listed] tag rides only on lumens ranks (the view
 *  records lumens_source; other metrics carry no source column). */
export function formatSpecRankRows(
  rows: SpecRankRow[],
  metric: string,
  perFoot: boolean,
  grouped: boolean,
): string {
  const line = (r: SpecRankRow): string => {
    const who = [`SKU ${r.sku}`, r.brand, r.class].filter(Boolean).join(", ");
    const tag =
      metric === "lumens" && !perFoot && r.lumens_source
        ? r.lumens_source === "ies"
          ? " [IES-measured]"
          : " [catalog-listed]"
        : "";
    return `- ${r.name ?? r.sku} (${who}): ${fmtMetric(Number(r.metric_value), metric, perFoot)}${tag}`;
  };
  if (!grouped) return rows.map(line).join("\n");
  // Per-class sections, preserving the RPC's class ordering.
  const sections: string[] = [];
  let current: string | null = null;
  for (const r of rows) {
    if (r.class !== current) {
      current = r.class;
      sections.push(`${r.class}:`);
    }
    sections.push(line(r));
  }
  return sections.join("\n");
}

/** The honest coverage line, from the RPC's windowed in-scope counts (never a
 *  guessed denominator — only ~57% of products carry output data). */
export function specRankCoverageLine(
  row: Pick<SpecRankRow, "in_scope_ranked" | "in_scope_total">,
  scope: string,
  perFoot: boolean,
): string {
  const n = Number(row.in_scope_ranked).toLocaleString("en-US");
  const m = Number(row.in_scope_total).toLocaleString("en-US");
  return perFoot
    ? `Ranked among the ${n} of ${m} ${scope} per-foot (tape/strip) products with watts/ft data.`
    : `Ranked among the ${n} of ${m} ${scope} products with output data; per-foot products (tape/strip) are ranked separately by watts/ft.`;
}

async function rankProductsBySpec(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutput> {
  const metric = String(input.metric ?? "").trim().toLowerCase();
  if (!["lumens", "watts", "efficacy"].includes(metric)) {
    return { content: "rank_products_by_spec: metric must be lumens, watts, or efficacy.", cards: [], citations: [] };
  }
  const dir = input.direction === "lowest" ? "asc" : "desc";
  const perFoot = input.per_foot === true;
  const brand = str(input.brand);
  const category = str(input.category);
  const cls = str(input.class);
  const limit = Math.min(Number(input.limit) || 10, 25);
  // Grouped (top-3 per class) whenever no single class is pinned; a class
  // filter or the per-foot rank is one section, so flat top-N reads better.
  const askGrouped = !cls && !perFoot;

  const call = (f: { brand: string | null; category: string | null; cls: string | null; grouped: boolean }) =>
    ctx.sb.rpc("product_spec_rank", {
      metric,
      dir,
      brand_filter: f.brand,
      category_filter: f.category,
      class_filter: f.cls,
      per_ft_filter: perFoot,
      grouped: f.grouped,
      match_count: limit,
    });

  const { data, error } = await call({ brand, category, cls, grouped: askGrouped });
  if (error) return { content: `rank_products_by_spec error: ${error.message}`, cards: [], citations: [] };
  let rows = (data ?? []) as SpecRankRow[];
  let grouped = askGrouped;
  let scope = [brand, cls, category].filter(Boolean).join(" ") || "catalog";
  let preamble = "";

  if (!rows.length && (brand || category || cls)) {
    // Empty FILTERED result (R16a): brand/category are free text and often miss
    // the catalog's wording — never imply the data doesn't exist. Explain, then
    // fall back to the unfiltered grouped rank.
    const { data: fallback } = await call({ brand: null, category: null, cls: null, grouped: true });
    rows = (fallback ?? []) as SpecRankRow[];
    grouped = true;
    scope = "catalog";
    preamble =
      `No ranked products matched that filter — catalog categories are free text, so the filter wording may not match the catalog's. ` +
      `Top ${metric === "lumens" ? "output" : metric} across the whole catalog instead:\n\n`;
  }
  if (!rows.length) {
    return {
      content: `No products carry numeric ${perFoot ? "watts/ft" : metric} data in the catalog index yet.`,
      cards: [],
      citations: [],
    };
  }

  const content =
    preamble +
    formatSpecRankRows(rows, metric, perFoot, grouped) +
    `\n\n${specRankCoverageLine(rows[0]!, scope, perFoot)}`;
  // No cards here — the model follows up with get_product for specifics.
  return { content, cards: [], citations: [] };
}

// --- filter_products (attribute-filter plan §B) -------------------------------

/** Units the filter tool accepts. Conversion happens HERE in TS (plan O10) —
 *  router-tier models multiply by 25.4 about as reliably as they compare
 *  15 to 20, so the model passes the user's numbers + `unit` unchanged. */
const UNIT_TO_INCHES = { in: 1, ft: 12, cm: 1 / 2.54, mm: 1 / 25.4 } as const;
export type FilterUnit = keyof typeof UNIT_TO_INCHES;

export function filterUnit(v: unknown): FilterUnit {
  const u = String(v ?? "in").toLowerCase();
  return u in UNIT_TO_INCHES ? (u as FilterUnit) : "in";
}

/** Convert one dimension value from the tool's unit to inches (2dp). */
export function dimToInches(v: unknown, unit: FilterUnit): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v).trim() || Number.NaN);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * UNIT_TO_INCHES[unit] * 100) / 100;
}

/** Assemble the RPC predicate args (`p_` names — plan A3) from the tool input,
 *  converting every dimension (and wire length) from the tool unit to inches.
 *  Pure + exported for tests. */
export function buildFilterPredicates(
  input: Record<string, unknown>,
): Record<string, number | null> {
  const unit = filterUnit(input.unit);
  const dim = (k: string) => dimToInches(input[k], unit);
  const num = (k: string) => {
    if (input[k] == null) return null;
    const n = Number(input[k]);
    return Number.isFinite(n) ? n : null;
  };
  const int = (k: string) => {
    const n = num(k);
    return n === null ? null : Math.round(n);
  };
  return {
    p_width_max_in: dim("max_width_in"),
    p_width_min_in: dim("min_width_in"),
    p_depth_max_in: dim("max_depth_in"),
    p_depth_min_in: dim("min_depth_in"),
    p_height_max_in: dim("max_height_in"),
    p_height_min_in: dim("min_height_in"),
    p_wire_min_in: dim("min_wire_length"),
    p_wire_max_in: dim("max_wire_length"),
    p_lumens_min: num("min_lumens"),
    p_lumens_max: num("max_lumens"),
    p_watts_max: num("max_watts"),
    p_watts_min: num("min_watts"),
    p_efficacy_min: num("min_efficacy"),
    p_cct_min_k: int("cct_min_k"),
    p_cct_max_k: int("cct_max_k"),
    p_cri_min: int("min_cri"),
    p_ip_min: int("min_ip"),
  };
}

/** Did the caller state ANY numeric predicate? (No predicate = free-text
 *  fallback, not an unconstrained catalog dump.) */
export function hasNumericPredicate(preds: Record<string, number | null>): boolean {
  return Object.values(preds).some((v) => v !== null);
}

/** One product_spec_filter RPC row (0063). A null-sku row is the zero-match
 *  counts carrier. */
export interface FilterRpcRow {
  sku: string | null;
  name: string | null;
  brand: string | null;
  category: string | null;
  class: string | null;
  per_ft: boolean | null;
  qualifying_variants: number | string | null;
  variant_count_with_dims: number | string | null;
  example_variant_sku: string | null;
  q_width_min_in: number | null;
  q_width_max_in: number | null;
  q_depth_min_in: number | null;
  q_depth_max_in: number | null;
  q_height_min_in: number | null;
  q_height_max_in: number | null;
  ex_width_in: number | null;
  ex_depth_in: number | null;
  ex_height_in: number | null;
  ex_width_mm: number | null;
  ex_height_mm: number | null;
  ex_length_mm: number | null;
  ex_diameter_mm: number | null;
  ex_wire_length_mm: number | null;
  cct_summary: string | null;
  cri: number | null;
  ip: number | null;
  lumens: number | null;
  lumens_source: string | null;
  score: number | null;
  in_scope_total: number | string;
  in_scope_screened: number | string;
  matched: number | string;
}

/** Dual-unit rendering (Addendum 1): inches are the round-trip-exact source
 *  figures, mm the stored conversion — the tool emits BOTH so no model
 *  arithmetic ever occurs in either system. */
export function fmtIn(inches: number): string {
  return `${Number(inches).toFixed(1)} in (${Math.round(Number(inches) * 25.4)} mm)`;
}
export function fmtMmAsIn(mm: number): string {
  return `${(mm / 25.4).toFixed(1)} in (${Math.round(mm)} mm)`;
}
/** Wire/cord lengths read best in feet: dual-unit ft (m). */
export function fmtWire(mm: number): string {
  const ft = Math.round((mm / 304.8) * 10) / 10;
  const m = Math.round((mm / 1000) * 100) / 100;
  return `${ft} ft (${m} m)`;
}

/** The MANDATORY product-level-lumens fallback sentence (plan O2 — a tested
 *  output contract, not a tag: the router model drops tags; it repeats
 *  sentences). Asserted verbatim in tests. */
export const PRODUCT_LEVEL_LUMENS_SENTENCE =
  "brightness figures are for the product's highest-output configuration, which may not be the size that fits";

/** Classes where derived depth is DEFINED (wall projection / ceiling drop).
 *  Everywhere else the tool says depth is not defined rather than inventing
 *  a number (plan A1/O4). */
const DEPTH_DEFINED_CLASSES = new Set(["wall", "ceiling", "fan"]);

/** Render filter rows NAME-FIRST with real geometry: derived values dual-unit,
 *  raw recorded axes alongside (plan A.2), per-size counts, spec tail. Pure. */
export function formatFilterRows(
  rows: FilterRpcRow[],
  opts: { lumensStated: boolean; wireStated: boolean },
): string[] {
  return rows.map((r) => {
    const who = [`SKU ${r.sku}`, r.brand, r.class].filter(Boolean).join(", ");
    const dims: string[] = [];
    if (r.ex_width_in != null) {
      dims.push(r.per_ft ? `tape cross-section ${fmtIn(r.ex_width_in)} wide` : `${fmtIn(r.ex_width_in)} wide`);
    }
    if (r.ex_depth_in != null) dims.push(`${fmtIn(r.ex_depth_in)} deep`);
    else if (r.class && !DEPTH_DEFINED_CLASSES.has(r.class)) dims.push("depth is not defined for this fixture type");
    if (r.ex_height_in != null) dims.push(`${fmtIn(r.ex_height_in)} tall`);
    const rec = [
      r.ex_width_mm != null ? `W ${fmtMmAsIn(r.ex_width_mm)}` : null,
      r.ex_height_mm != null ? `H ${fmtMmAsIn(r.ex_height_mm)}` : null,
      r.ex_length_mm != null ? `L ${fmtMmAsIn(r.ex_length_mm)}` : null,
      r.ex_diameter_mm != null ? `Dia ${fmtMmAsIn(r.ex_diameter_mm)}` : null,
    ].filter(Boolean);
    const parts: string[] = [];
    if (dims.length) parts.push(dims.join(", ") + (rec.length ? ` (recorded ${rec.join(" x ")})` : ""));
    const q = Number(r.qualifying_variants ?? 0);
    const m = Number(r.variant_count_with_dims ?? 0);
    if (q > 0 && m > 0) parts.push(`${q} of ${m} size${m === 1 ? "" : "s"} meet${q === 1 ? "s" : ""} your limits`);
    const specs = [
      r.cct_summary,
      r.cri != null ? `CRI ${r.cri}` : null,
      r.ip != null ? `IP${r.ip}` : null,
      r.lumens != null ? `${Math.round(Number(r.lumens)).toLocaleString("en-US")} lm` : null,
      opts.wireStated && r.ex_wire_length_mm != null ? `wire/cord ${fmtWire(r.ex_wire_length_mm)}` : null,
    ].filter(Boolean);
    if (specs.length) parts.push(specs.join(", "));
    return `- ${r.name ?? r.sku} (${who}): ${parts.join("; ")}`;
  });
}

/** The honest-coverage line from the RPC's windowed counts (plan §B, verbatim
 *  contract). `in_scope_screened` follows the pinned A9 definition. */
export function filterCoverageLine(
  counts: Pick<FilterRpcRow, "in_scope_total" | "in_scope_screened" | "matched">,
  scope: string,
): string {
  const s = Number(counts.in_scope_screened).toLocaleString("en-US");
  const t = Number(counts.in_scope_total).toLocaleString("en-US");
  const m = Number(counts.matched).toLocaleString("en-US");
  return (
    `Screened the ${s} of ${t} ${scope} products that carry data for every stated constraint; ` +
    `${m} matched. Products missing catalog data for a constraint are excluded, not confirmed to fit.`
  );
}

/** Near-miss vocabulary for the pinned zero-match relaxation (plan A13/O11). */
const NEAR_MISS_WORDS: Record<
  "width" | "depth" | "height",
  { maxWord: string; minWord: string; adj: string }
> = {
  width: { maxWord: "narrowest", minWord: "widest", adj: "wide" },
  depth: { maxWord: "shallowest", minWord: "deepest", adj: "deep" },
  height: { maxWord: "shortest", minWord: "tallest", adj: "tall" },
};

async function filterProducts(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutput> {
  const preds = buildFilterPredicates(input);
  const query = str(input.query);
  const brand = str(input.brand);
  const category = str(input.category);
  const cls = str(input.class);
  const limit = Math.min(Number(input.limit) || 10, 25);

  // Empty-filter free-text fallback: no numeric predicate stated -> this is a
  // search, not a filter. Never dump the unconstrained catalog.
  if (!hasNumericPredicate(preds)) {
    if (!query) {
      return {
        content: "filter_products: state at least one numeric constraint, or provide a query.",
        cards: [],
        citations: [],
      };
    }
    const out = await searchProducts(ctx, {
      query,
      brand: brand ?? undefined,
      category: category ?? undefined,
      limit,
    });
    return {
      ...out,
      content: `No numeric constraints were stated, so this fell back to a plain catalog search:\n${out.content}`,
    };
  }

  const embedding = query ? await embedQuery(ctx.env, query) : null;
  const call = (p: Record<string, number | null>, b: string | null, c: string | null) =>
    ctx.sb.rpc("product_spec_filter", {
      ...p,
      p_brand: b,
      p_category: c,
      p_class: cls,
      p_query_embedding: embedding,
      p_query_text: query,
      p_match_count: limit,
    });

  let curBrand = brand;
  let curCategory = category;
  let scope = [brand, cls, category].filter(Boolean).join(" ") || "catalog";
  let preamble = "";
  let res = await call(preds, curBrand, curCategory);
  if (res.error) return { content: `filter_products error: ${res.error.message}`, cards: [], citations: [] };
  let rows = (res.data ?? []) as FilterRpcRow[];
  let counts = rows[0];

  // Empty SCOPE from a brand/category filter (R16a idiom): categories are
  // free text — re-run without them and explain, never imply no data exists.
  if (counts && Number(counts.in_scope_total) === 0 && (curBrand || curCategory)) {
    curBrand = null;
    curCategory = null;
    res = await call(preds, null, null);
    if (res.error) return { content: `filter_products error: ${res.error.message}`, cards: [], citations: [] };
    rows = (res.data ?? []) as FilterRpcRow[];
    counts = rows[0];
    scope = cls ?? "catalog";
    preamble =
      "No catalog products matched that brand or category filter. Catalog categories are free text, " +
      "so the filter wording may not match the catalog's; screened the whole catalog instead.\n\n";
  }
  if (!counts) {
    return { content: "filter_products: the catalog index returned no data.", cards: [], citations: [] };
  }

  const lumensStated = preds.p_lumens_min !== null || preds.p_lumens_max !== null;
  const wireStated = preds.p_wire_min_in !== null || preds.p_wire_max_in !== null;
  const coverage = filterCoverageLine(counts, scope);
  const matched = Number(counts.matched);

  if (matched === 0) {
    // Pinned zero-match relaxation (plan A13/O11): keep the FULL scope and all
    // other predicates; relax ONLY dimension predicates, one at a time, in
    // width -> depth -> height order; report the near-miss for the FIRST
    // predicate whose relaxation yields a row. NEVER emit a product card for
    // a near-miss. A zero caused by a non-dimension predicate is a plain
    // "nothing fits" — a near-miss on brightness is not a meaningful almost.
    for (const dim of ["width", "depth", "height"] as const) {
      const maxKey = `p_${dim}_max_in`;
      const minKey = `p_${dim}_min_in`;
      if (preds[maxKey] === null && preds[minKey] === null) continue;
      const relaxed = { ...preds, [maxKey]: null, [minKey]: null };
      const rr = await call(relaxed, curBrand, curCategory);
      if (rr.error) break;
      const rrows = ((rr.data ?? []) as FilterRpcRow[]).filter((r) => r.sku != null);
      if (!rrows.length) continue;
      const maxStated = preds[maxKey] !== null;
      const valueKey = (
        dim === "width"
          ? maxStated ? "q_width_min_in" : "q_width_max_in"
          : dim === "depth"
            ? maxStated ? "q_depth_min_in" : "q_depth_max_in"
            : maxStated ? "q_height_min_in" : "q_height_max_in"
      ) as keyof FilterRpcRow;
      const withVal = rrows.filter((r) => r[valueKey] != null);
      if (!withVal.length) continue;
      const best = withVal.reduce((a, b) =>
        maxStated
          ? Number(a[valueKey]) <= Number(b[valueKey]) ? a : b
          : Number(a[valueKey]) >= Number(b[valueKey]) ? a : b,
      );
      const words = NEAR_MISS_WORDS[dim];
      const word = maxStated ? words.maxWord : words.minWord;
      const content =
        `${preamble}No product with recorded dimensions fits all of those limits; the ${word} option ` +
        `with data is ${best.name ?? best.sku} (SKU ${best.sku}) at ${fmtIn(Number(best[valueKey]))} ${words.adj}. ` +
        `It does NOT meet the stated ${dim} requirement.\n\n${coverage}`;
      return { content, cards: [], citations: [] };
    }
    return {
      content: `${preamble}Nothing in the catalog fits all of those requirements.\n\n${coverage}`,
      cards: [],
      citations: [],
    };
  }

  const productRows = rows.filter((r) => r.sku != null);
  let content = preamble + formatFilterRows(productRows, { lumensStated, wireStated }).join("\n");
  if (lumensStated && productRows.some((r) => r.lumens_source === "product_level")) {
    content += `\n\nNote: ${PRODUCT_LEVEL_LUMENS_SENTENCE}.`;
  }
  content += `\n\n${coverage}`;
  // No cards here — the model follows up with get_product.
  return { content, cards: [], citations: [] };
}

/**
 * Resolve the family/category scope for a sibling/family lookup: prefer the
 * explicit family/category on the input; otherwise expand a sku into its own
 * family + category. Shared by get_related_products and get_family.
 */
async function resolveScope(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<{ family: string | null; category: string | null; sku: string | null }> {
  let family = str(input.family);
  let category = str(input.category);
  const sku = str(input.sku);
  if (sku && !family && !category) {
    const { data } = await ctx.sb
      .from("products")
      .select("family, category")
      .eq("sku", sku)
      .maybeSingle();
    family = str(data?.family);
    category = str(data?.category);
  }
  return { family, category, sku };
}

/**
 * Compose the two get_related_products sections (§B/AA12): explicit confirmed
 * accessory/component rows FIRST (authoritative fitment), then the
 * family/category expansion labeled "verify fitment", with separate counts.
 * Pure so section ordering/labeling is unit-testable.
 */
export function composeRelatedSections(opts: {
  sku: string | null;
  explicitLines: string[];
  explicitCount: number;
  familyScope: string;
  familyLines: string[];
  familyCount: number;
}): string {
  const parts: string[] = [];
  if (opts.explicitCount > 0) {
    parts.push(
      `Confirmed accessories and components${opts.sku ? ` for ${opts.sku}` : ""} ` +
        `(${opts.explicitCount} reference${opts.explicitCount === 1 ? "" : "s"}, from catalog reference data):\n` +
        opts.explicitLines.join("\n"),
    );
  }
  if (opts.familyCount > 0) {
    parts.push(
      `Same family or category, verify fitment (${opts.familyCount} products in ${opts.familyScope}):\n` +
        opts.familyLines.join("\n"),
    );
  }
  return parts.join("\n\n");
}

async function getRelated(
  ctx: ToolContext,
  input: Record<string, unknown>,
  surface: ThomSurface = "internal",
): Promise<ToolOutput> {
  const { family, category, sku } = await resolveScope(ctx, input);
  if (!family && !category && !sku) {
    return { content: "get_related_products: provide a sku, family, or category.", cards: [], citations: [] };
  }

  // Section 1 — explicit confirmed accessory/component rows for the sku.
  let explicitLines: string[] = [];
  let explicitCount = 0;
  if (sku) {
    const { data: accData } = await ctx.sb
      .from("product_accessories")
      .select("related_sku, related_product_sku, kind, label")
      .eq("product_sku", sku)
      .limit(400);
    const accRows = (accData ?? []) as ProductAccessoryRow[];
    if (accRows.length) {
      const resolvedSkus = [...new Set(accRows.map((r) => r.related_product_sku).filter(Boolean))] as string[];
      const info = await fetchParentInfo(ctx, resolvedSkus);
      explicitLines = formatAccessoryLines(accRows, info, surface);
      explicitCount = accRows.length;
    }
  }

  // Section 2 — family/category expansion (verify fitment).
  const limit = Math.min(Number(input.limit) || 60, 100);
  const found = new Map<string, { sku: string; name: string; category: string | null }>();
  for (const [col, val] of [
    ["family", family],
    ["category", category],
  ] as const) {
    if (!val) continue;
    const { data, error } = await ctx.sb
      .from("products")
      .select("sku, name, category")
      .eq(col, val)
      .limit(limit);
    if (error) continue;
    for (const r of (data ?? []) as { sku: string; name: string; category: string | null }[]) {
      if (r.sku !== sku) found.set(r.sku, r);
    }
  }

  if (!explicitCount && !found.size) {
    return { content: "No related products found.", cards: [], citations: [] };
  }
  const scope =
    [family && `family "${family}"`, category && `category "${category}"`].filter(Boolean).join(" / ") ||
    "the catalog";
  const content = composeRelatedSections({
    sku,
    explicitLines,
    explicitCount,
    familyScope: scope,
    familyLines: [...found.values()].map((r) => `- ${r.sku} — ${r.name}`),
    familyCount: found.size,
  });
  return { content, cards: [], citations: [] };
}

interface FamilyRow {
  sku: string;
  name: string | null;
  brand: string | null;
  category: string | null;
  family: string | null;
  primary_image_url: string | null;
  is_accessory: boolean | null;
}

/** Order rows host (non-accessory) first, then accessories; within each group
 *  by category then name. Pure so the ordering is unit-testable. */
export function orderFamilyRows(rows: FamilyRow[]): FamilyRow[] {
  const rank = (r: FamilyRow) => (r.is_accessory ? 1 : 0);
  const key = (v: string | null) => (v ?? "").toLowerCase();
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      key(a.category).localeCompare(key(b.category)) ||
      key(a.name).localeCompare(key(b.name)),
  );
}

/** Build a FamilyCard from the raw member rows (already scoped to a family or
 *  category). Pure — no I/O — so member assembly, ordering, the cap, and
 *  representative-image / brand selection can be unit-tested directly. */
export function buildFamilyCard(
  scope: { family: string; category: string | null },
  rows: FamilyRow[],
  pdpBySku: Map<string, string>,
): FamilyCard {
  // Dedup by sku, preserving first occurrence.
  const bySku = new Map<string, FamilyRow>();
  for (const r of rows) if (r.sku && !bySku.has(r.sku)) bySku.set(r.sku, r);
  const unique = orderFamilyRows([...bySku.values()]);
  const shown = unique.slice(0, MAX_FAMILY_MEMBERS);
  const members: FamilyMember[] = shown.map((r) => ({
    sku: r.sku,
    name: r.name ?? null,
    role: r.category ?? null,
    image_url: r.primary_image_url ?? null,
    pdp_url: pdpBySku.get(r.sku) ?? null,
  }));

  // Representative image: first host with an image, else first member with one.
  const hostWithImg = unique.find((r) => !r.is_accessory && r.primary_image_url);
  const anyWithImg = unique.find((r) => r.primary_image_url);
  const image_url = (hostWithImg ?? anyWithImg)?.primary_image_url ?? null;

  // Brand: the first non-null member brand (host-first ordering makes this the
  // host's brand when present).
  const brand = unique.find((r) => str(r.brand))?.brand ?? null;

  return {
    kind: "family",
    family: scope.family,
    brand,
    image_url,
    category: scope.category,
    members,
    member_count: unique.length,
  };
}

async function getFamily(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutput> {
  const { family, category } = await resolveScope(ctx, input);
  // Prefer family; fall back to category only when family is null.
  const useFamily = !!family;
  const col = useFamily ? "family" : "category";
  const val = useFamily ? family : category;
  if (!val) {
    return { content: "get_family: provide a sku, family, or category.", cards: [], citations: [] };
  }

  const limit = Math.min(Number(input.limit) || 60, 100);
  const { data, error } = await ctx.sb
    .from("products")
    .select("sku, name, brand, category, family, primary_image_url, is_accessory")
    .eq(col, val)
    .limit(limit);
  if (error) return { content: `get_family error: ${error.message}`, cards: [], citations: [] };
  const rows = (data ?? []) as FamilyRow[];
  if (!rows.length) {
    return { content: `No products found for ${col} "${val}".`, cards: [], citations: [] };
  }

  // Batch-fetch product-page URLs for the (deduped) member skus.
  const skus = [...new Set(rows.map((r) => r.sku).filter(Boolean))];
  const pdpBySku = new Map<string, string>();
  if (skus.length) {
    const { data: pdps } = await ctx.sb.from("pdp_urls").select("sku, url").in("sku", skus);
    for (const p of (pdps ?? []) as { sku: string; url: string | null }[]) {
      const cu = canonicalPdp(p.url);
      if (cu) pdpBySku.set(p.sku, cu);
    }
  }

  const familyName = useFamily ? (val as string) : (category as string) ?? (val as string);
  const card = buildFamilyCard({ family: familyName, category: category ?? null }, rows, pdpBySku);

  const list = card.members
    .map((m) => `- ${m.sku} — ${m.name ?? m.sku}${m.role ? ` (${m.role})` : ""}`)
    .join("\n");
  const more =
    card.member_count > card.members.length
      ? `\n(+${card.member_count - card.members.length} more not shown on the card)`
      : "";
  const content =
    `System "${card.family}"${card.brand ? ` (${card.brand})` : ""} — ${card.member_count} member component(s):\n` +
    list +
    more;

  return { content, cards: [card], citations: [] };
}

/**
 * An injected tool set the surface-agnostic dispatch can route to WITHOUT the
 * shared package knowing what the tools are. The INTERNAL caller uses this to
 * add its read-only HubSpot CRM tools (crm_*): shared/thom has zero reference to
 * hubspotTools — it just advertises `tools` and forwards owned names to
 * `dispatch`. NEVER supply this on the public surface.
 */
export interface ThomToolExtension {
  /** Extra client tool schemas to advertise (composed by composeTools). */
  tools: ClaudeTool[];
  /** Does this extension own the given tool name (should it dispatch it)? */
  owns: (name: string) => boolean;
  /** Execute one of this extension's tools. */
  dispatch: (ctx: ToolContext, name: string, input: Record<string, unknown>) => Promise<ToolOutput>;
}

/** Options threaded into dispatch: which surface, and any injected tool set. */
export interface DispatchOptions {
  surface: ThomSurface;
  extension?: ThomToolExtension;
}

/**
 * Tool names permitted on the PUBLIC surface. Anything else — crm_* or an
 * otherwise-unknown name — is HARD-REJECTED in dispatch, defense-in-depth beyond
 * composeTools never advertising them.
 */
export const PUBLIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_products",
  "get_product",
  "get_related_products",
  "get_family",
  "search_docs",
  "plan_layout",
  "get_photometrics",
  "lighting_requirement",
  "rank_products_by_spec",
  "filter_products",
  // Dimming-chart tools (THOM_DIMMING): allow-listing is inert until the flag
  // advertises them (dimming plan §D — public data, files ship on public PDPs).
  "check_dimmer_compatibility",
  "find_products_for_dimmer",
]);

export async function dispatch(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
  opts: DispatchOptions = { surface: "internal" },
): Promise<ToolOutput> {
  const surface = opts.surface;
  // PUBLIC hard-reject: never dispatch crm_* or any non-allowlisted tool on the
  // public surface, even if one somehow reached the model. This runs BEFORE the
  // extension check, so an injected crm_* tool can never execute on public.
  if (surface === "public" && !PUBLIC_TOOL_NAMES.has(name)) {
    return { content: `Tool "${name}" is not available on this surface.`, cards: [], citations: [] };
  }
  // Internal-only injected tools (e.g. HubSpot crm_*): the caller owns + executes
  // them. Ordered FIRST (as the crm_* branch was before) so internal behavior is
  // unchanged.
  if (opts.extension?.owns(name)) return opts.extension.dispatch(ctx, name, input);
  // Photometrics tools (photometricsTools.ts) are only offered when
  // THOM_PHOTOMETRICS=1 (composed by agent.ts); routing here is harmless
  // otherwise since the tools aren't advertised.
  if (name === "get_photometrics" || name === "lighting_requirement") {
    return photometricsDispatch(ctx, name, input);
  }
  // Layout tool (layoutTool.ts) is only offered when THOM_LAYOUT=1 (internal) /
  // always on the public set; routing here is harmless when not advertised.
  if (name === "plan_layout") {
    return layoutDispatch(ctx, name, input);
  }
  // Spec-rank tool is only offered when THOM_SPEC_RANK=1 (composed by
  // agent.ts); routing here is harmless otherwise since it isn't advertised.
  if (name === "rank_products_by_spec") {
    return rankProductsBySpec(ctx, input);
  }
  // Filter tool is only offered when THOM_SPEC_FILTER=1 (composed by
  // agent.ts); routing here is harmless otherwise since it isn't advertised.
  if (name === "filter_products") {
    return filterProducts(ctx, input);
  }
  // Dimming tools are only offered when THOM_DIMMING=1 (composed by agent.ts);
  // routing here is harmless otherwise since they aren't advertised.
  if (DIMMING_TOOL_NAMES.has(name)) {
    return dimmingDispatch(ctx, name, input);
  }
  switch (name) {
    case "search_products":
      return searchProducts(ctx, input);
    case "get_product":
      return getProduct(ctx, input, surface);
    case "get_related_products":
      return getRelated(ctx, input, surface);
    case "get_family":
      return getFamily(ctx, input);
    case "search_docs":
      return searchDocs(ctx, input, surface);
    default:
      return { content: `Unknown tool: ${name}`, cards: [], citations: [] };
  }
}
