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
 * so (site, slug) → sku answers both sides — the OWNING product (the PDP the
 * section was found on) and each referenced slug. A slug two SKUs share is
 * ambiguous and never resolved (counted, like the PDP reconciler's
 * collisions). Unresolved referenced slugs are KEPT with
 * related_product_sku=null (the raw slug is the evidence, same posture as
 * unresolved Sales Layer codes); an unresolved OWNER is skipped — no
 * product_sku, no row.
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
  /** Slugs shared by 2+ SKUs in pdp_urls — never resolved. */
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
 * Invert pdp_urls into a (siteKey, slug) → sku map. The site comes from the
 * row's url host when present (authoritative), else from the canonical brand's
 * domain. Slugs claimed by two DIFFERENT SKUs are ambiguous: dropped from the
 * map and counted.
 */
export function invertPdpUrls(rows: readonly PdpUrlRow[]): {
  bySlug: Map<string, string>;
  collisions: number;
} {
  const bySlug = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const r of rows) {
    let site: string | null = null;
    let slug: string | null = null;
    if (r.url) {
      try {
        const u = new URL(r.url);
        site = siteForHost(u.host)?.key ?? null;
        slug = u.pathname.match(/^\/product\/([a-z0-9][a-z0-9-]*)\/?$/i)?.[1]?.toLowerCase() ?? null;
      } catch {
        /* fall through to the brand/slug columns */
      }
    }
    if (!site) {
      const brand = canonicalBrand(r.brand) ?? r.brand;
      site = brand ? (SITE_BY_DOMAIN.get(brand) ?? null) : null;
    }
    if (!slug && r.slug) slug = r.slug.toLowerCase();
    if (!site || !slug) continue;
    const key = `${site} ${slug}`;
    if (ambiguous.has(key)) continue;
    const existing = bySlug.get(key);
    if (existing && existing !== r.sku) {
      bySlug.delete(key);
      ambiguous.add(key);
      continue;
    }
    bySlug.set(key, r.sku);
  }
  return { bySlug, collisions: ambiguous.size };
}

function slugOfPdp(pdp: FrontierAccessoryPdp): string | null {
  if (pdp.discovered_slug) return pdp.discovered_slug.toLowerCase();
  try {
    return new URL(pdp.url).pathname.match(/^\/product\/([a-z0-9][a-z0-9-]*)\/?$/i)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the web_crawl payload rows from the scanned frontier PDPs. Pure so
 * owner/ref resolution, own-slug skip, per-site labeling, and the in-payload
 * dedup (linkSeen: first occurrence wins, a later RESOLVED duplicate upgrades
 * an unresolved kept row) are unit-testable.
 */
export function buildPdpAccessoryRows(
  pdps: readonly FrontierAccessoryPdp[],
  bySlug: ReadonlyMap<string, string>,
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
    const owner = ownSlug ? bySlug.get(`${pdp.site} ${ownSlug}`) : undefined;
    // Every RESOLVABLE scanned PDP counts as "still in the feed" for the
    // prune guard, whether or not it carried slugs this run.
    if (owner) ownerSkusSeen.add(owner);
    const slugs = (pdp.accessory_slugs ?? []).map((s) => s.toLowerCase());
    if (!slugs.length) continue;
    withSlugs++;
    if (!owner) {
      ownersUnresolved++;
      continue;
    }
    ownersResolved++;
    slugs.forEach((slug, i) => {
      if (slug === ownSlug) return;
      const related = bySlug.get(`${pdp.site} ${slug}`) ?? null;
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
  const { bySlug, collisions } = invertPdpUrls(pdpRows);

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
    slugCollisions: collisions,
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
    `${report.refs} refs (${report.refsUnresolved} unresolved, ${report.slugCollisions} slug collisions) | ` +
    (opts.write
      ? `${report.written} rows written, ${report.pruned} pruned${report.pruneAborted ? " (PRUNE ABORTED)" : ""}`
      : "REPORT-ONLY (no writes)"),
  );
  return report;
}
