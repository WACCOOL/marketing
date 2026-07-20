import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DOMAIN,
  MODERN_FORMS_SPEC_TEMPLATES,
  SCRAPEABLE,
  canonicalBrand,
  canonicalPdpUrl,
  deriveModelCodes,
  extractSpecSheet,
  firstSlugFromHtml,
  modernFormsPpid,
  modernFormsSpecUrl,
  schonbekSpecSheet,
  type PdpProduct,
} from "@wac/shared";

export type { PdpProduct };

/**
 * PDP URL resolver — replicates WIES Studio's method (wies-app/scripts/
 * pdp-resolver.mjs + src/lib/pdp.ts), self-contained so the Marketing App owns
 * its product URLs and stays current if WIES changes.
 *
 * The pure brand-site vocabulary (brand normalization, domains, slug grammar,
 * per-brand spec-sheet URL derivations) lives in `@wac/shared` pdp/taxonomy so
 * the Thom web-crawl reconciliation shares it — this file keeps the NETWORK
 * side: `?s=` search, PDP fetches, Modern Forms template probing, cache policy.
 *
 * Method: each WAC Group brand site exposes `?s=<query>` search that resolves
 * to the canonical product page `/<brand>/product/<slug>/`. For a product we
 * search the brand site by, in order, its visible variant material numbers, the
 * model codes derived from its asset filenames (image/IES — the real
 * brand-site-indexed identifiers; see `@wac/shared` deriveModelCodes), then its
 * family/name, take the first `/product/<slug>/` link, and build the canonical
 * URL. When NOTHING resolves we store `url = null` (NOT a `?s=<sku>` search
 * fallback: internal numeric SKUs aren't indexed, so those searches are dead
 * links) and the caller keeps its image fallback. Results cache to the
 * `pdp_urls` table (30-day TTL) so steady-state syncs are zero-network; null
 * misses are cached too (fresh `resolved_at`) so they aren't re-scraped nightly
 * — pass `--refresh-unresolved` to force a re-scrape of null / legacy `?s=` rows.
 */

const CACHE_TTL_DAYS = 30;
const PARALLELISM = 8;
const FETCH_TIMEOUT_MS = 12_000;
const USER_AGENT = "WAC-Marketing-App/1.0 (+product-url sync; nightly; contact WAC IT)";

// Also resolve the spec-sheet URL (one extra PDP fetch per scraped product).
// Dark until migration 0045 adds pdp_urls.spec_sheet_url; enable with
// PDP_SPEC_SHEETS=1 once it's applied. Off => behaves exactly as before.
const SPEC_SHEETS_ON = process.env.PDP_SPEC_SHEETS === "1";

/** HEAD a URL and report whether it actually responds as a PDF. */
async function headIsPdf(url: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "HEAD",
      signal: ctl.signal,
      headers: { "user-agent": USER_AGENT, accept: "application/pdf,*/*" },
    });
    return r.ok && (r.headers.get("content-type") ?? "").toLowerCase().includes("application/pdf");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the real Modern Forms spec-sheet URL for a PDP by probing the
 * template candidates (specs5 first — see MODERN_FORMS_SPEC_TEMPLATES). The
 * endpoint returns HTTP 200 for ANY index, but only the correct one is a real
 * PDF — a wrong index returns an empty `text/html` body. Returns null when the
 * PDP carries no PPID or no template yields a PDF.
 */
export async function resolveModernFormsSpecSheet(html: string | null): Promise<string | null> {
  const ppid = modernFormsPpid(html);
  if (!ppid) return null;
  for (const t of MODERN_FORMS_SPEC_TEMPLATES) {
    const url = modernFormsSpecUrl(ppid, t);
    if (await headIsPdf(url)) return url;
  }
  return null;
}

/** A query is usable if it carries a letter (purely-numeric family codes like
 *  "1322" are PIM placeholders that match unrelated SKUs) and is long enough. */
function isUsableQuery(q: string | null | undefined): q is string {
  return !!q && q.trim().length >= 3 && /[a-z]/i.test(q);
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

/** Case-insensitive de-dupe, preserving first occurrence. */
function dedupe(values: (string | null | undefined)[]): (string | null | undefined)[] {
  const seen = new Set<string>();
  const out: (string | null | undefined)[] = [];
  for (const v of values) {
    const key = typeof v === "string" ? v.trim().toUpperCase() : "";
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(v);
  }
  return out;
}

interface CacheRow {
  sku: string;
  brand: string | null;
  query: string | null;
  slug: string | null;
  url: string | null;
  resolved_at: string;
  // Only ever set when SPEC_SHEETS_ON, so the field is omitted from the upsert
  // (and thus safe) until migration 0045 adds the column.
  spec_sheet_url?: string | null;
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
  // Re-scrape rows that never resolved (slug null) or that still carry a legacy
  // `?s=` search fallback, so a code-fix run can heal them without waiting out
  // the 30-day TTL. Normal runs leave fresh rows untouched.
  const refreshUnresolved = process.argv.includes("--refresh-unresolved");
  const staleForRefresh = (r: CacheRow) =>
    refreshUnresolved && (r.slug === null || (r.url != null && /[?&]s=/.test(r.url)));

  const result = new Map<string, string>();
  const toScrape: { p: PdpProduct; brand: string; queries: string[] }[] = [];
  // Fresh rows that predate spec-sheet resolution (spec_sheet_url still NULL) —
  // resolve their spec sheet WITHOUT re-searching (reuse the cached slug).
  const specBackfill: { p: PdpProduct; brand: string; cached: CacheRow }[] = [];
  for (const p of products) {
    const brand = canonicalBrand(p.brand);
    if (!brand || !DOMAIN[brand]) continue;
    const cached = cache.get(p.sku);
    if (cached && fresh(cached) && !staleForRefresh(cached)) {
      if (cached.url) result.set(p.sku, cached.url);
      if (SPEC_SHEETS_ON && (cached.spec_sheet_url === null || cached.spec_sheet_url === undefined)) {
        specBackfill.push({ p, brand, cached });
      }
      continue;
    }
    // Variant material numbers first (unchanged for already-resolving products),
    // then filename-derived model codes (the real brand-site identifiers), then
    // family/name. Case-insensitive de-dupe so a filename code equal to a variant
    // sku isn't searched twice.
    const queries = dedupe([
      ...(p.variants ?? []).map((v) => v?.sku).slice(0, 3),
      ...deriveModelCodes(p),
      p.family,
      p.name,
    ]).filter(isUsableQuery);
    toScrape.push({ p, brand, queries });
  }

  const newRows: CacheRow[] = [];
  let scraped = 0;
  let specs = 0;
  await mapWithConcurrency(toScrape, PARALLELISM, async ({ p, brand, queries }) => {
    const slug = SCRAPEABLE.has(brand) && queries.length ? await resolveSlug(brand, queries) : null;
    const url = canonicalPdpUrl(brand, slug);
    if (slug) scraped++;
    // Only expose a real URL; a null (unresolved) row lets the caller keep its
    // image fallback. The null row is still cached below (fresh resolved_at) so
    // the miss isn't re-scraped every night.
    if (url) result.set(p.sku, url);
    const row: CacheRow = { sku: p.sku, brand, query: queries[0] ?? null, slug, url, resolved_at: iso() };
    if (SPEC_SHEETS_ON) {
      // Schonbek: template from raw sub-brand + PPID (no PDP to scrape).
      // Scrapeable brands: one extra fetch of the resolved PDP → tier-2 link.
      let specUrl: string | null = null;
      if (brand === "Schonbek") {
        specUrl = schonbekSpecSheet(p.brand, p.sku);
      } else if (slug) {
        const pdpHtml = await fetchText(`https://${DOMAIN[brand]}/product/${slug}/`);
        specUrl =
          brand === "Modern Forms"
            ? await resolveModernFormsSpecSheet(pdpHtml)
            : extractSpecSheet(brand, pdpHtml, slug);
      }
      row.spec_sheet_url = specUrl;
      if (specUrl) specs++;
    }
    newRows.push(row);
  });

  if (toScrape.length) {
    const specNote = SPEC_SHEETS_ON ? `, ${specs} spec sheets` : "";
    console.log(`[pdp] resolved ${toScrape.length} products (${scraped} canonical slugs, ${toScrape.length - scraped} unresolved → null url${specNote}); ${cache.size} from cache`);
  } else {
    console.log(`[pdp] ${result.size} product URLs all from cache`);
  }

  for (let i = 0; i < newRows.length; i += 500) {
    const { error } = await sb.from("pdp_urls").upsert(newRows.slice(i, i + 500), { onConflict: "sku" });
    if (error) throw new Error(`pdp_urls upsert failed: ${error.message}`);
  }

  // One-time spec-sheet backfill for already-cached products. We store "" when
  // none is found (attempted, none) so a product without a spec sheet isn't
  // re-fetched every run — only genuine NULLs (never attempted) are processed.
  if (SPEC_SHEETS_ON && specBackfill.length) {
    const updates: CacheRow[] = [];
    let filled = 0;
    await mapWithConcurrency(specBackfill, PARALLELISM, async ({ p, brand, cached }) => {
      let specUrl: string | null = null;
      if (brand === "Schonbek") {
        specUrl = schonbekSpecSheet(p.brand, p.sku);
      } else if (cached.slug) {
        const html = await fetchText(`https://${DOMAIN[brand]}/product/${cached.slug}/`);
        specUrl =
          brand === "Modern Forms"
            ? await resolveModernFormsSpecSheet(html)
            : extractSpecSheet(brand, html, cached.slug);
      }
      if (specUrl) filled++;
      updates.push({ ...cached, spec_sheet_url: specUrl ?? "" });
    });
    for (let i = 0; i < updates.length; i += 500) {
      const { error } = await sb.from("pdp_urls").upsert(updates.slice(i, i + 500), { onConflict: "sku" });
      if (error) throw new Error(`pdp_urls spec backfill upsert failed: ${error.message}`);
    }
    console.log(`[pdp] spec backfill: ${filled}/${specBackfill.length} cached products got a spec sheet`);
  }

  return result;
}
