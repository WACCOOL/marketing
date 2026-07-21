import type { ClaudeTool } from "./transport.js";
import type { ThomSurface } from "./env.js";
import { authorityWeightFor, detectDocsQueryIntent } from "./authority.js";
import { embedQuery } from "./embed.js";
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
      "Full detail for one product by SKU/PPID: specs across its variants (wattage, lumens, CCT, CRI, IP, finish, dimensions), plus its spec-sheet / manual downloads and product-page URL. Use this to render a product card and answer spec questions.",
    input_schema: {
      type: "object",
      properties: { sku: { type: "string", description: "The product SKU / PPID." } },
      required: ["sku"],
    },
  },
  {
    name: "get_related_products",
    description:
      "List the OTHER products in the same family or category as a product — e.g. every component of a track SYSTEM (channel, track heads, transformer/power supply, connectors, joiners, end caps, covers). Use this to build a complete parts/component list for a project. Pass a sku to find its siblings, or an explicit family/category.",
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
      "Search the CONTENTS of spec sheets, installation manuals, curated WAC marketing overviews/positioning/FAQs, WAC Help Center (support) articles, WAC Group brand-website pages (company/about, capabilities, technology, news, FAQs, warranty), official WAC Architectural PRODUCT pages (that brand is not in the product catalog yet — this is where its products live, with separate Domestic and International lines), AND internal support-ticket resolutions (how a real customer issue was diagnosed and fixed) for a specific fact (cutout size, dimming compatibility, mounting, torque, wiring, exact photometrics), WAC's own product/brand/system positioning and messaging, company background and capabilities, or how-to / troubleshooting / warranty / support guidance. Returns matching passages with the document + link for citation.",
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

async function getProduct(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutput> {
  const sku = String(input.sku ?? "").trim();
  if (!sku) return { content: "get_product: sku is required.", cards: [], citations: [] };

  const { data: p, error } = await ctx.sb
    .from("products")
    .select("sku, name, brand, category, primary_image_url, variants")
    .eq("sku", sku)
    .maybeSingle();
  if (error) return { content: `get_product error: ${error.message}`, cards: [], citations: [] };
  if (!p) return { content: `No product found with SKU ${sku}.`, cards: [], citations: [] };

  const [{ data: docs }, { data: pdp }] = await Promise.all([
    ctx.sb.from("product_documents").select("doc_type, label, url").eq("product_sku", sku),
    ctx.sb.from("pdp_urls").select("url").eq("sku", sku).maybeSingle(),
  ]);

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
  // Intent-gated authority (plan D.2): product/SKU-shaped queries ALWAYS pass
  // weight 0; company/ambiguous queries pass the default λ only when the
  // THOM_AUTHORITY env gate is on. With the gate off this is 0 everywhere and
  // kb_search ordering is identical to pre-0054.
  const authorityWeight = authorityWeightFor(
    detectDocsQueryIntent(query),
    ctx.env.THOM_AUTHORITY === "1",
  );
  const { data, error } = await ctx.sb.rpc("kb_search", {
    query_embedding: embedding,
    query_text: query,
    scope_filter: isPublic ? "public" : null,
    doc_types: isPublic
      ? ["spec_sheet", "manual", "marketing", "zendesk_article", ...WEB_DOC_TYPES]
      : ["spec_sheet", "manual", "marketing", "zendesk_article", "zendesk_ticket", ...WEB_DOC_TYPES],
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

async function getRelated(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutput> {
  const { family, category, sku } = await resolveScope(ctx, input);
  if (!family && !category) {
    return { content: "get_related_products: provide a sku, family, or category.", cards: [], citations: [] };
  }
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
  if (!found.size) return { content: "No related products found.", cards: [], citations: [] };
  const scope = [family && `family "${family}"`, category && `category "${category}"`].filter(Boolean).join(" / ");
  const list = [...found.values()].map((r) => `- ${r.sku} — ${r.name}`).join("\n");
  return { content: `${found.size} products in ${scope}:\n${list}`, cards: [], citations: [] };
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
  switch (name) {
    case "search_products":
      return searchProducts(ctx, input);
    case "get_product":
      return getProduct(ctx, input);
    case "get_related_products":
      return getRelated(ctx, input);
    case "get_family":
      return getFamily(ctx, input);
    case "search_docs":
      return searchDocs(ctx, input, surface);
    default:
      return { content: `Unknown tool: ${name}`, cards: [], citations: [] };
  }
}
