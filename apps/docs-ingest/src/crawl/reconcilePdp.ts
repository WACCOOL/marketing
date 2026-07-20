import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalBrand, canonicalPdpUrl, deriveModelCodes } from "@wac/shared";
import { siteForHost } from "./sites.js";

/**
 * PDP reconciliation (plan E) — heal pdp_urls/product_documents from the
 * crawl's discovered evidence, REPORT-ONLY by default.
 *
 * The reverse of the WIES resolver: instead of product → search → slug, we
 * take every crawl-discovered PDP (crawl_frontier rows classified
 * web_product) and match its evidence — model codes harvested from asset
 * filenames / data-ppid / the Schonbek title parse, plus the URL slug's own
 * tokens — against a reverse index built from the SAME vocabulary the
 * resolver trusts (deriveModelCodes over the catalog's asset URLs, variant
 * material numbers, own sku, family names).
 *
 * Resolution states (persisted on the frontier row):
 *  - one_sku   — all evidence points at exactly one SKU: auto-heal eligible.
 *  - family    — evidence hits multiple SKUs of ONE family: family candidate.
 *  - collision — evidence spans families: review-only, never auto-written.
 *  - unresolved — no evidence matched (bare Schonbek titles, unharvested).
 *
 * Healing (--reconcile-write) is GAP-ONLY and never clobbers: url null → set
 * canonical; url '' (resolver attempted, none) → fill; a DIFFERING non-empty
 * url is proposed in the report (WIES stays authoritative). spec_sheet_url
 * only fills null/''. wacarchitectural is EXCLUDED from writes entirely — no
 * catalog rows exist yet (evidence harvest only, per the plan addendum).
 * Nothing here reads or writes any price/financial field (none exist on
 * these tables — asserted in tests).
 */

export interface ReconcileOptions {
  write: boolean;
  log?: (m: string) => void;
}

export interface ReconcileReport {
  scanned: number;
  oneSku: number;
  family: number;
  collision: number;
  unresolved: number;
  urlFills: number;
  urlConflicts: { sku: string; existing: string; discovered: string }[];
  specFills: number;
  writes: number;
}

interface ProductRow {
  sku: string;
  brand: string | null;
  family: string | null;
  name: string | null;
  variants: { sku: string | null }[] | null;
  primary_image_url?: string | null;
  image_urls?: (string | null)[] | null;
  ies_url?: string | null;
}

interface FrontierPdp {
  url: string;
  host: string;
  site: string;
  discovered_slug: string | null;
  discovered_spec_sheet_url: string | null;
  model_codes: string[] | null;
}

interface PdpUrlRow {
  sku: string;
  brand: string | null;
  slug: string | null;
  url: string | null;
  spec_sheet_url: string | null;
}

const norm = (s: string): string => s.trim().toUpperCase();

/** Slug → matchable tokens: the slug itself, hyphens-joined uppercased, and a
 *  trailing "-<number>" strip (schonbek's arlington-12 → ARLINGTON). */
export function slugTokens(slug: string): string[] {
  const up = norm(slug.replace(/-/g, " ")).replace(/\s+/g, "-");
  const out = new Set<string>([up]);
  const m = up.match(/^(.*?)-\d+$/);
  if (m && m[1]) out.add(m[1]);
  return [...out];
}

export interface ReverseIndex {
  /** normalized code/family/name key → SKUs it identifies */
  byKey: Map<string, Set<string>>;
  /** keys that are FAMILY NAMES — weak evidence, consulted only when no
   *  code-shaped key hits (plan E.2 tiering). */
  familyKeys: Set<string>;
  familyOf: Map<string, string | null>;
  brandOf: Map<string, string | null>;
}

/** One vocabulary with the resolver: asset-derived model codes, variant
 *  material numbers, own sku, family name (also hyphenated). */
export function buildReverseIndex(products: ProductRow[]): ReverseIndex {
  const byKey = new Map<string, Set<string>>();
  const familyKeys = new Set<string>();
  const familyOf = new Map<string, string | null>();
  const brandOf = new Map<string, string | null>();
  const add = (key: string | null | undefined, sku: string, isFamily = false) => {
    if (!key) return;
    const k = norm(key);
    if (k.length < 3) return;
    let set = byKey.get(k);
    if (!set) byKey.set(k, (set = new Set()));
    set.add(sku);
    if (isFamily) familyKeys.add(k);
  };
  for (const p of products) {
    familyOf.set(p.sku, p.family ?? null);
    brandOf.set(p.sku, canonicalBrand(p.brand));
    add(p.sku, p.sku);
    for (const code of deriveModelCodes(p)) add(code, p.sku);
    for (const v of p.variants ?? []) add(v?.sku, p.sku);
    if (p.family) {
      add(p.family, p.sku, true);
      add(p.family.replace(/\s+/g, "-"), p.sku, true);
    }
  }
  return { byKey, familyKeys, familyOf, brandOf };
}

export interface Resolution {
  state: "one_sku" | "family" | "collision" | "unresolved";
  skus: string[];
  family: string | null;
}

function classify(index: ReverseIndex, skus: Set<string>): Resolution {
  if (!skus.size) return { state: "unresolved", skus: [], family: null };
  if (skus.size === 1) {
    const sku = [...skus][0]!;
    return { state: "one_sku", skus: [sku], family: index.familyOf.get(sku) ?? null };
  }
  const families = new Set([...skus].map((s) => index.familyOf.get(s) ?? null));
  if (families.size === 1 && !families.has(null)) {
    return { state: "family", skus: [...skus], family: [...families][0]! };
  }
  return { state: "collision", skus: [...skus], family: null };
}

/**
 * TIERED resolution (plan E.2), tiered by KEY KIND: code-shaped keys (asset
 * model codes, variant material numbers, PPIDs, own sku) are tried FIRST;
 * family-name keys are only consulted when no code key hits. Without the
 * tiering, a PDP carrying both a unique PPID and its family name (every
 * PPID-bearing Schonbek title) would dilute to a family-level match.
 */
export function resolvePdp(index: ReverseIndex, evidence: string[]): Resolution {
  const codeHits = new Set<string>();
  const familyHits = new Set<string>();
  for (const e of evidence) {
    const k = norm(e);
    const hit = index.byKey.get(k);
    if (!hit) continue;
    const target = index.familyKeys.has(k) ? familyHits : codeHits;
    for (const s of hit) target.add(s);
  }
  if (codeHits.size) return classify(index, codeHits);
  return classify(index, familyHits);
}

const UPSERT = 300;

export async function reconcilePdp(
  sb: SupabaseClient,
  opts: ReconcileOptions,
): Promise<ReconcileReport> {
  const log = opts.log ?? ((m) => console.log(m));
  const report: ReconcileReport = {
    scanned: 0, oneSku: 0, family: 0, collision: 0, unresolved: 0,
    urlFills: 0, urlConflicts: [], specFills: 0, writes: 0,
  };

  // Catalog → reverse index (same columns the resolver reads).
  const products: ProductRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("products")
      .select("sku, brand, family, name, variants, primary_image_url, image_urls, ies_url")
      .range(from, from + 999);
    if (error) throw new Error(`products read failed: ${error.message}`);
    products.push(...((data ?? []) as ProductRow[]));
    if ((data?.length ?? 0) < 1000) break;
  }
  const index = buildReverseIndex(products);

  // pdp_urls cache (the heal target).
  const pdpBySku = new Map<string, PdpUrlRow>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("pdp_urls")
      .select("sku, brand, slug, url, spec_sheet_url")
      .range(from, from + 999);
    if (error) throw new Error(`pdp_urls read failed: ${error.message}`);
    for (const r of (data ?? []) as PdpUrlRow[]) pdpBySku.set(r.sku, r);
    if ((data?.length ?? 0) < 1000) break;
  }

  // Crawl-discovered PDPs.
  const pdps: FrontierPdp[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("crawl_frontier")
      .select("url, host, site, discovered_slug, discovered_spec_sheet_url, model_codes")
      .eq("doc_type_guess", "web_product")
      .range(from, from + 999);
    if (error) throw new Error(`crawl_frontier read failed: ${error.message}`);
    pdps.push(...((data ?? []) as FrontierPdp[]));
    if ((data?.length ?? 0) < 1000) break;
  }

  const frontierUpdates: { url: string; resolution_state: string; resolved_skus: string[] | null; resolved_family: string | null }[] = [];
  const pdpUpdates: Partial<PdpUrlRow>[] = [];

  for (const pdp of pdps) {
    report.scanned++;
    const evidence = [
      ...(pdp.model_codes ?? []),
      ...(pdp.discovered_slug ? slugTokens(pdp.discovered_slug) : []),
    ];
    const res = resolvePdp(index, evidence);
    report[res.state === "one_sku" ? "oneSku" : res.state]++;
    frontierUpdates.push({
      url: pdp.url,
      resolution_state: res.state,
      resolved_skus: res.skus.length ? res.skus : null,
      resolved_family: res.family,
    });

    // Heal analysis: one_sku only, and never wacarchitectural (no catalog yet).
    if (res.state !== "one_sku") continue;
    if (siteForHost(pdp.host)?.key === "wacarchitectural") continue;
    const sku = res.skus[0]!;
    const cached = pdpBySku.get(sku);
    const brand = index.brandOf.get(sku);
    const slug = pdp.discovered_slug;
    const canonical = brand && slug ? canonicalPdpUrl(brand, slug) : null;

    // Uniform full-row shape (PostgREST batch upserts need identical keys);
    // untouched fields carry the cached value so nothing is clobbered.
    let urlFill: string | null = null;
    let slugFill: string | null = null;
    if (canonical) {
      const existing = cached?.url ?? null;
      if (existing == null || existing === "" || /[?&]s=/.test(existing)) {
        // null (never resolved), '' or a legacy ?s= fallback → fill/heal.
        if (existing !== canonical) {
          urlFill = canonical;
          slugFill = slug;
          report.urlFills++;
        }
      } else if (existing !== canonical) {
        report.urlConflicts.push({ sku, existing, discovered: canonical });
      }
    }
    const spec = pdp.discovered_spec_sheet_url;
    const specFill =
      spec && (cached?.spec_sheet_url == null || cached.spec_sheet_url === "") ? spec : null;
    if (specFill) report.specFills++;
    if ((urlFill || specFill) && opts.write) {
      pdpUpdates.push({
        sku,
        brand: cached?.brand ?? brand ?? null,
        slug: slugFill ?? cached?.slug ?? null,
        url: urlFill ?? cached?.url ?? null,
        spec_sheet_url: specFill ?? cached?.spec_sheet_url ?? null,
      });
    }
  }

  // Persist resolution states (report-only mode still records these — the
  // classification IS the report, and it's idempotent).
  for (let i = 0; i < frontierUpdates.length; i += UPSERT) {
    for (const u of frontierUpdates.slice(i, i + UPSERT)) {
      const { error } = await sb
        .from("crawl_frontier")
        .update({ resolution_state: u.resolution_state, resolved_skus: u.resolved_skus, resolved_family: u.resolved_family })
        .eq("url", u.url);
      if (error) throw new Error(`crawl_frontier resolution update failed: ${error.message}`);
    }
  }

  if (opts.write && pdpUpdates.length) {
    for (let i = 0; i < pdpUpdates.length; i += UPSERT) {
      const slice = pdpUpdates.slice(i, i + UPSERT).map((p) => ({
        ...p,
        resolved_at: new Date().toISOString(),
      }));
      const { error } = await sb.from("pdp_urls").upsert(slice, { onConflict: "sku" });
      if (error) throw new Error(`pdp_urls heal upsert failed: ${error.message}`);
      report.writes += slice.length;
    }
  }

  log(
    `[reconcile-pdp] ${report.scanned} PDPs: ${report.oneSku} one_sku, ${report.family} family, ` +
    `${report.collision} collision, ${report.unresolved} unresolved | ` +
    `heals: ${report.urlFills} url fills, ${report.specFills} spec fills, ` +
    `${report.urlConflicts.length} conflicts (review) | ` +
    (opts.write ? `${report.writes} rows written` : "REPORT-ONLY (no writes)"),
  );
  for (const c of report.urlConflicts.slice(0, 20)) {
    log(`[reconcile-pdp] CONFLICT ${c.sku}: cached=${c.existing} discovered=${c.discovered}`);
  }
  return report;
}
