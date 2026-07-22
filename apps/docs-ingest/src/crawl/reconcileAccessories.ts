import type { SupabaseClient } from "@supabase/supabase-js";
import {
  accessoryPruneDecision,
  canonicalBrand,
  DOMAIN,
  type AccessoryKind,
} from "@wac/shared";
import { siteForHost } from "./sites.js";

/**
 * PDP accessory reconciliation (compat plan v2.1 Phase 2 / §D) — turn the
 * crawl's harvested accessory-section slug lists (crawl_frontier
 * .accessory_slugs, from Step W's evidence harvest) into product_accessories
 * rows with source_system='web_crawl'. REPORT-ONLY by default; writes require
 * the same --reconcile-write gate as the PDP heal.
 *
 * Resolution is pdp_urls INVERSION: pdp_urls maps sku → (brand, slug, url),
 * so (site, slug) → sku[] answers both sides — the OWNING product(s) (the
 * PDP the section was found on) and each referenced slug. All keying goes
 * through one normalizer (normalizeSlug/pdpSlugFromUrl): trailing slash,
 * case, www/alias hosts, query/hash tails, and repeated slashes can never
 * break the join on EITHER side.
 *
 * A slug shared by several SKUs is legitimate on the OWNER side — WIES maps
 * multiple catalog products (fan sizes, housing variants) at the SAME brand
 * PDP, so the page's accessory section belongs to every one of them (capped
 * at MAX_OWNERS_PER_SLUG against family/landing-page mappings). On the
 * RELATED side one row carries one related_product_sku, so only uniquely
 * claimed slugs resolve; shared ones are KEPT with related_product_sku=null
 * (the raw slug is the evidence, same posture as unresolved Sales Layer
 * codes). An unresolved OWNER is skipped — no product_sku, no row.
 *
 * Provenance labeling (§D: MF's curated scope is unverified, algorithmic
 * cross-sell risk — the prompt must be able to say "listed together on the
 * product page" instead of "confirmed accessory"):
 *   waclighting  → kind 'component',  source_field 'components_section'
 *   modernforms  → kind 'accessory',  source_field 'curated_for_you'
 *
 * The prune deletes ONLY source_system='web_crawl' rows older than this run
 * (synced_at < stamp), behind the SAME mass-delete guard as the Sales Layer
 * writer (accessoryPruneDecision, PL7): a selector-breakage run that harvests
 * ~nothing while the previously-referenced PDPs are still known must never
 * wipe the table. Rows from the Sales Layer sync are NEVER touched.
 */

/** The two harvestable sites and their provenance labels. */
export const ACCESSORY_SITES: Record<string, { kind: AccessoryKind; sourceField: string }> = {
  waclighting: { kind: "component", sourceField: "components_section" },
  modernforms: { kind: "accessory", sourceField: "curated_for_you" },
};

export interface AccessoryReconcileOptions {
  write: boolean;
  log?: (m: string) => void;
}

export interface AccessoryReconcileReport {
  /** Frontier PDPs scanned (the two sites, web_product). */
  scanned: number;
  /** PDPs that carried harvested accessory slugs. */
  withSlugs: number;
  /** ...whose own slug resolved to a catalog SKU (rows written for these). */
  ownersResolved: number;
  ownersUnresolved: number;
  /** Referenced-slug refs kept (post-dedupe). */
  refs: number;
  refsUnresolved: number;
  /** Slugs shared by 2+ SKUs in pdp_urls — owner-side fan-out, related-side
   *  unresolvable. */
  slugCollisions: number;
  written: number;
  pruned: number;
  pruneAborted: boolean;
}

interface PdpUrlRow {
  sku: string;
  brand: string | null;
  slug: string | null;
  url: string | null;
}

export interface FrontierAccessoryPdp {
  url: string;
  host: string;
  site: string;
  discovered_slug: string | null;
  accessory_slugs: string[] | null;
}

/** One product_accessories payload row (web_crawl provenance). */
export interface WebAccessoryRow {
  product_sku: string;
  related_sku: string; // the raw harvested slug — the evidence itself
  related_product_sku: string | null;
  kind: AccessoryKind;
  label: null;
  source_system: "web_crawl";
  source_field: string;
  position: number;
  synced_at: string;
}

const SITE_BY_DOMAIN = new Map(
  Object.entries(DOMAIN).map(([brand, host]) => [brand, siteForHost(host)?.key ?? null]),
);

/**
 * Normalize any slug-ish value to the matching key form: trimmed, lowercased,
 * stripped of surrounding slashes and any query/hash tail. Every place a slug
 * is KEYED goes through this — pdp_urls url paths AND slug column, frontier
 * discovered_slug / url, and the harvested accessory slugs — so a trailing
 * slash, case difference, or copied query string on either side can never
 * break the (site, slug) join.
 */
export function normalizeSlug(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase().replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "");
  return s || null;
}

/** Slug from any PDP url form: tolerates www/case (host handled by
 *  siteForHost's aliases), repeated slashes, query/hash, and a trailing
 *  slash. Null for non-PDP urls (legacy `?s=` search fallbacks). */
export function pdpSlugFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\/product\/+([a-z0-9][a-z0-9-]*)\/*$/i);
    return m ? normalizeSlug(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Invert pdp_urls into a (siteKey, slug) → sku[] map. The site comes from the
 * row's url host when present (authoritative, www/alias-normalized), else
 * from the canonical brand's domain.
 *
 * A slug CAN legitimately map to several SKUs: WIES points multiple catalog
 * products (fan sizes, housing variants) at the SAME brand PDP, so the
 * page's own SKU set is the value, not a single sku — dropping shared slugs
 * as "ambiguous" is exactly the bug that left WYND XL (1884) with zero rows.
 * Shared slugs are still counted (they stay unresolvable on the RELATED
 * side, where one row needs one related_product_sku).
 */
export function invertPdpUrls(rows: readonly PdpUrlRow[]): {
  bySlug: Map<string, string[]>;
  sharedSlugs: number;
} {
  const bySlug = new Map<string, string[]>();
  for (const r of rows) {
    let site: string | null = null;
    let slug: string | null = null;
    if (r.url) {
      try {
        site = siteForHost(new URL(r.url).host.toLowerCase())?.key ?? null;
      } catch {
        /* fall through to the brand column */
      }
      slug = pdpSlugFromUrl(r.url);
    }
    if (!site) {
      const brand = canonicalBrand(r.brand) ?? r.brand;
      site = brand ? (SITE_BY_DOMAIN.get(brand) ?? null) : null;
    }
    if (!slug) slug = normalizeSlug(r.slug);
    if (!site || !slug) continue;
    const key = `${site} ${slug}`;
    const list = bySlug.get(key);
    if (!list) bySlug.set(key, [r.sku]);
    else if (!list.includes(r.sku)) list.push(r.sku);
  }
  let sharedSlugs = 0;
  for (const list of bySlug.values()) if (list.length > 1) sharedSlugs++;
  return { bySlug, sharedSlugs };
}

/** Cap on owners written per shared slug — fan-size sharing is 2..6 SKUs; a
 *  slug claimed by more than this smells like a family/landing page mapping
 *  and is skipped for safety. */
export const MAX_OWNERS_PER_SLUG = 8;

function slugOfPdp(pdp: FrontierAccessoryPdp): string | null {
  return normalizeSlug(pdp.discovered_slug) ?? pdpSlugFromUrl(pdp.url);
}

/**
 * Build the web_crawl payload rows from the scanned frontier PDPs. Pure so
 * owner/ref resolution, own-slug skip, per-site labeling, and the in-payload
 * dedup (linkSeen: first occurrence wins, a later RESOLVED duplicate upgrades
 * an unresolved kept row) are unit-testable.
 */
export function buildPdpAccessoryRows(
  pdps: readonly FrontierAccessoryPdp[],
  bySlug: ReadonlyMap<string, string[]>,
  syncedAt: string,
): {
  rows: WebAccessoryRow[];
  withSlugs: number;
  ownersResolved: number;
  ownersUnresolved: number;
  ownerSkusSeen: Set<string>;
} {
  const byKey = new Map<string, WebAccessoryRow>();
  let withSlugs = 0;
  let ownersResolved = 0;
  let ownersUnresolved = 0;
  const ownerSkusSeen = new Set<string>();

  for (const pdp of pdps) {
    const labels = ACCESSORY_SITES[pdp.site];
    if (!labels) continue;
    const ownSlug = slugOfPdp(pdp);
    // OWNER side: every catalog SKU WIES mapped onto this PDP owns the page's
    // accessory section (fan sizes share one PDP — the Wynd XL fix), capped
    // against family/landing-page mappings.
    const ownerList = ownSlug ? (bySlug.get(`${pdp.site} ${ownSlug}`) ?? []) : [];
    const owners = ownerList.length <= MAX_OWNERS_PER_SLUG ? ownerList : [];
    // Every RESOLVABLE scanned PDP counts as "still in the feed" for the
    // prune guard, whether or not it carried slugs this run.
    for (const o of owners) ownerSkusSeen.add(o);
    const slugs = (pdp.accessory_slugs ?? [])
      .map((s) => normalizeSlug(s))
      .filter((s): s is string => s !== null);
    if (!slugs.length) continue;
    withSlugs++;
    if (!owners.length) {
      ownersUnresolved++;
      continue;
    }
    ownersResolved++;
    slugs.forEach((slug, i) => {
      if (slug === ownSlug) return;
      // RELATED side: one row carries ONE related_product_sku, so only a
      // slug uniquely claimed by a single SKU resolves; shared slugs stay
      // unresolved (raw slug kept as the evidence).
      const relatedList = bySlug.get(`${pdp.site} ${slug}`) ?? [];
      const related = relatedList.length === 1 ? relatedList[0]! : null;
      for (const owner of owners) {
        const key = `${owner} ${slug} ${labels.kind}`;
        const kept = byKey.get(key);
        if (!kept) {
          byKey.set(key, {
            product_sku: owner,
            related_sku: slug,
            related_product_sku: related,
            kind: labels.kind,
            label: null,
            source_system: "web_crawl",
            source_field: labels.sourceField,
            position: i + 1,
            synced_at: syncedAt,
          });
        } else if (!kept.related_product_sku && related) {
          kept.related_product_sku = related;
        }
      }
    });
  }
  return { rows: [...byKey.values()], withSlugs, ownersResolved, ownersUnresolved, ownerSkusSeen };
}

const UPSERT = 300;

export async function reconcileAccessories(
  sb: SupabaseClient,
  opts: AccessoryReconcileOptions,
): Promise<AccessoryReconcileReport> {
  const log = opts.log ?? ((m) => console.log(m));
  const syncedAt = new Date().toISOString();

  // pdp_urls inversion (both owner and referenced slugs resolve through it).
  const pdpRows: PdpUrlRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("pdp_urls")
      .select("sku, brand, slug, url")
      .range(from, from + 999);
    if (error) throw new Error(`pdp_urls read failed: ${error.message}`);
    pdpRows.push(...((data ?? []) as PdpUrlRow[]));
    if ((data?.length ?? 0) < 1000) break;
  }
  const { bySlug, sharedSlugs } = invertPdpUrls(pdpRows);

  // Frontier PDPs for the two harvestable sites — ALL of them, not just the
  // slug-bearing ones: resolvable owners feed the prune guard's "still in the
  // feed" signal even when this run harvested nothing for them.
  const pdps: FrontierAccessoryPdp[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("crawl_frontier")
      .select("url, host, site, discovered_slug, accessory_slugs")
      .eq("doc_type_guess", "web_product")
      .in("site", Object.keys(ACCESSORY_SITES))
      .range(from, from + 999);
    if (error) throw new Error(`crawl_frontier read failed: ${error.message}`);
    pdps.push(...((data ?? []) as FrontierAccessoryPdp[]));
    if ((data?.length ?? 0) < 1000) break;
  }

  const built = buildPdpAccessoryRows(pdps, bySlug, syncedAt);
  const report: AccessoryReconcileReport = {
    scanned: pdps.length,
    withSlugs: built.withSlugs,
    ownersResolved: built.ownersResolved,
    ownersUnresolved: built.ownersUnresolved,
    refs: built.rows.length,
    refsUnresolved: built.rows.filter((r) => !r.related_product_sku).length,
    slugCollisions: sharedSlugs,
    written: 0,
    pruned: 0,
    pruneAborted: false,
  };

  if (opts.write) {
    // PL7 guard inputs BEFORE the upsert refreshes synced_at.
    const { count: previous, error: countErr } = await sb
      .from("product_accessories")
      .select("id", { count: "exact", head: true })
      .eq("source_system", "web_crawl");
    if (countErr) throw new Error(`product_accessories count failed: ${countErr.message}`);
    let previousProductSkus: string[] = [];
    if (previous) {
      const { data, error } = await sb
        .from("product_accessories")
        .select("product_sku")
        .eq("source_system", "web_crawl")
        .limit(1000);
      if (error) throw new Error(`product_accessories sample failed: ${error.message}`);
      previousProductSkus = ((data ?? []) as { product_sku: string }[]).map((d) => d.product_sku);
    }

    for (let i = 0; i < built.rows.length; i += UPSERT) {
      const { error } = await sb
        .from("product_accessories")
        .upsert(built.rows.slice(i, i + UPSERT), {
          onConflict: "product_sku,related_sku,kind,source_system",
        });
      if (error) throw new Error(`product_accessories upsert failed: ${error.message}`);
      report.written += Math.min(UPSERT, built.rows.length - i);
    }

    const decision = accessoryPruneDecision({
      captured: built.rows.length,
      previous: previous ?? 0,
      previousProductSkus,
      feedSkus: built.ownerSkusSeen,
    });
    if (decision.prune) {
      // Scoped to THIS source only — Sales Layer rows are never touched.
      const { data: prunedRows, error: pruneErr } = await sb
        .from("product_accessories")
        .delete()
        .eq("source_system", "web_crawl")
        .lt("synced_at", syncedAt)
        .select("id");
      if (pruneErr) throw new Error(`product_accessories prune failed: ${pruneErr.message}`);
      report.pruned = prunedRows?.length ?? 0;
    } else {
      report.pruneAborted = true;
      log(`[reconcile-accessories] ${decision.warn}`);
    }
  }

  log(
    `[reconcile-accessories] ${report.scanned} PDPs scanned, ${report.withSlugs} with harvested slugs ` +
    `(${report.ownersResolved} owners resolved, ${report.ownersUnresolved} unresolved) | ` +
    `${report.refs} refs (${report.refsUnresolved} unresolved, ${report.slugCollisions} shared slugs) | ` +
    (opts.write
      ? `${report.written} rows written, ${report.pruned} pruned${report.pruneAborted ? " (PRUNE ABORTED)" : ""}`
      : "REPORT-ONLY (no writes)"),
  );
  return report;
}
