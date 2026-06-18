import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PDP URL resolver — replicates WIES Studio's method (wies-app/scripts/
 * pdp-resolver.mjs + src/lib/pdp.ts), self-contained so the Marketing App owns
 * its product URLs and stays current if WIES changes.
 *
 * Method: each WAC Group brand site exposes `?s=<query>` search that resolves
 * to the canonical product page `/<brand>/product/<slug>/`. For a product we
 * search the brand site for one of its variant material numbers, take the first
 * `/product/<slug>/` link, and build the canonical URL. When nothing resolves
 * (or the brand isn't scrapeable), we fall back to the brand-site PPID search —
 * WIES's own tier-2 fallback. Results cache to the `pdp_urls` table (30-day TTL)
 * so steady-state syncs are zero-network.
 */

const CACHE_TTL_DAYS = 30;
const PARALLELISM = 8;
const FETCH_TIMEOUT_MS = 12_000;
const USER_AGENT = "WAC-Marketing-App/1.0 (+product-url sync; nightly; contact WAC IT)";

// Raw Sales Layer brand code -> canonical brand (from WIES BRAND_NORMALIZATION).
const BRAND_NORMALIZATION: Record<string, string> = {
  WAC: "WAC Lighting",
  AISPIRE: "AiSpire",
  SIGNATURE: "Schonbek",
  MOF: "Modern Forms",
  DWEL: "WAC Lighting",
  LIM: "WAC Lighting",
  LANDSCAPE: "WAC Lighting",
  BEYOND: "Schonbek",
  VENTRIX: "WAC Lighting",
  MFF: "Modern Forms",
  FAN: "WAC Lighting",
  HOME: "WAC Lighting",
  FOREVER: "Schonbek",
  COLORSCAPING: "WAC Lighting",
};

const DOMAIN: Record<string, string> = {
  "WAC Lighting": "waclighting.com",
  "Modern Forms": "modernforms.com",
  AiSpire: "aispire.com",
  Schonbek: "schonbek.com",
};

// Brands whose sites we scrape for a canonical slug. Schonbek is search-only
// (matches WIES brandResolverConfig).
const SCRAPEABLE = new Set(["WAC Lighting", "Modern Forms", "AiSpire"]);

const SLUG_RE = /\/product\/([a-z0-9][a-z0-9-]*)\//gi;
const SKIP_SLUGS = new Set([
  "all", "products", "search", "category", "blog", "support", "yoast-seo-wordpress",
]);

export function canonicalBrand(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const up = raw.trim().toUpperCase();
  return BRAND_NORMALIZATION[up] ?? null;
}

/** A query is usable if it carries a letter (purely-numeric family codes like
 *  "1322" are PIM placeholders that match unrelated SKUs) and is long enough. */
function isUsableQuery(q: string | null | undefined): q is string {
  return !!q && q.trim().length >= 3 && /[a-z]/i.test(q);
}

function ppidSearchUrl(brand: string, ppid: string): string {
  const dom = DOMAIN[brand];
  // SAP brands index on PPID-<n>; AiSpire searches by raw code.
  return brand === "AiSpire"
    ? `https://${dom}/?s=${encodeURIComponent(ppid)}`
    : `https://${dom}/?s=PPID-${encodeURIComponent(ppid)}`;
}

function buildUrl(brand: string, ppid: string, slug: string | null): string {
  if (slug) return `https://${DOMAIN[brand]}/product/${slug}/`;
  return ppidSearchUrl(brand, ppid);
}

async function fetchText(url: string): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent": USER_AGENT, accept: "text/html" } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function firstSlugFromHtml(html: string | null): string | null {
  if (!html) return null;
  SLUG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SLUG_RE.exec(html)) != null) {
    const slug = m[1]!.toLowerCase();
    if (!SKIP_SLUGS.has(slug)) return slug;
  }
  return null;
}

/** Search the brand site for each query until one yields a slug. */
async function resolveSlug(brand: string, queries: string[]): Promise<string | null> {
  const dom = DOMAIN[brand];
  for (const q of queries) {
    const html = await fetchText(`https://${dom}/?s=${encodeURIComponent(q)}`);
    const slug = firstSlugFromHtml(html);
    if (slug) return slug;
  }
  return null;
}

async function mapWithConcurrency<T>(inputs: T[], concurrency: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = i++;
      if (idx >= inputs.length) return;
      await fn(inputs[idx]!);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

export interface PdpProduct {
  sku: string; // PPID
  brand: string | null;
  family: string | null;
  name: string | null;
  variants: { sku: string | null }[] | null;
}

interface CacheRow {
  sku: string;
  brand: string | null;
  query: string | null;
  slug: string | null;
  url: string;
  resolved_at: string;
}

/**
 * Resolve product_url for every product (cache-first; scrape misses/stale).
 * Returns Map<sku, url>. Upserts new resolutions to pdp_urls.
 */
export async function resolvePdpUrls(
  sb: SupabaseClient,
  products: PdpProduct[],
  iso: () => string,
): Promise<Map<string, string>> {
  // Load cache.
  const cache = new Map<string, CacheRow>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("pdp_urls").select("*").range(from, from + 999);
    if (error) throw new Error(`pdp_urls read failed: ${error.message}`);
    const rows = (data ?? []) as CacheRow[];
    for (const r of rows) cache.set(r.sku, r);
    if (rows.length < 1000) break;
  }
  const fresh = (r: CacheRow) =>
    Date.now() - new Date(r.resolved_at).getTime() < CACHE_TTL_DAYS * 864e5;

  const result = new Map<string, string>();
  const toScrape: { p: PdpProduct; brand: string; queries: string[] }[] = [];
  for (const p of products) {
    const brand = canonicalBrand(p.brand);
    if (!brand || !DOMAIN[brand]) continue;
    const cached = cache.get(p.sku);
    if (cached && fresh(cached)) {
      result.set(p.sku, cached.url);
      continue;
    }
    const queries = [
      ...(p.variants ?? []).map((v) => v?.sku).slice(0, 3),
      p.family,
      p.name,
    ].filter(isUsableQuery);
    toScrape.push({ p, brand, queries });
  }

  const newRows: CacheRow[] = [];
  let scraped = 0;
  await mapWithConcurrency(toScrape, PARALLELISM, async ({ p, brand, queries }) => {
    const slug = SCRAPEABLE.has(brand) && queries.length ? await resolveSlug(brand, queries) : null;
    const url = buildUrl(brand, p.sku, slug);
    if (slug) scraped++;
    result.set(p.sku, url);
    newRows.push({ sku: p.sku, brand, query: queries[0] ?? null, slug, url, resolved_at: iso() });
  });

  if (toScrape.length) {
    console.log(`[pdp] resolved ${toScrape.length} products (${scraped} canonical slugs, ${toScrape.length - scraped} search fallback); ${cache.size} from cache`);
  } else {
    console.log(`[pdp] ${result.size} product URLs all from cache`);
  }

  for (let i = 0; i < newRows.length; i += 500) {
    const { error } = await sb.from("pdp_urls").upsert(newRows.slice(i, i + 500), { onConflict: "sku" });
    if (error) throw new Error(`pdp_urls upsert failed: ${error.message}`);
  }
  return result;
}
