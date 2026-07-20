import { AUTHORITY_TIERS } from "@wac/shared/thom";

/**
 * Per-site URL taxonomy — the ratified plan's section B, transcribed rule for
 * rule and unit-tested per site. classify() is PURE: canonical path (+ which
 * sitemap file the URL came from, when known) in, verdict out.
 *
 * Verdicts:
 *  - content: fetch, extract, chunk, embed as kb doc_type at `authority`.
 *    `optIn` marks types the rollout holds back (wacarchitectural project
 *    case studies) — recorded in the frontier, ingested only when enabled.
 *  - product: a PDP. Recorded in the frontier for the reconciliation pass
 *    (slug free from the URL); fetched for evidence when harvesting is on.
 *    `ingest` is true ONLY for wacarchitectural (no catalog rows exist yet —
 *    Davis 2026-07-20 — so its PDP prose is the sole interim product source).
 *  - listing: fetched for link discovery / pagination traversal (seeded-BFS
 *    site only), never ingested.
 *  - skip: recorded status='skipped' for coverage accounting, not fetched.
 *  - junk: dropped, never recorded.
 */
export type Classification =
  | { kind: "content"; docType: string; authority: number; region: "na" | "int" | null; optIn?: true }
  | { kind: "product"; region: "na" | "int" | null; ingest: boolean }
  | { kind: "listing"; region: "na" | "int" | null }
  | { kind: "skip"; reason: string }
  | { kind: "junk"; reason: string };

const junk = (reason: string): Classification => ({ kind: "junk", reason });
const skip = (reason: string): Classification => ({ kind: "skip", reason });
const content = (
  docType: string,
  authority: number,
  region: "na" | "int" | null = null,
  optIn?: true,
): Classification =>
  optIn ? { kind: "content", docType, authority, region, optIn } : { kind: "content", docType, authority, region };

// --- junk common to every site --------------------------------------------

const ASSET_EXT_RE = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|ies|ldt|dwg|rfa|docx?|xlsx?|pptx?|mp4|webm|css|js|xml|txt)$/i;
const WP_JUNK_RE = /^\/(wp-(admin|json|content|includes|login)|xmlrpc\.php|cgi-bin)/i;
const LEGAL_JUNK_RE = /^\/(privacy-policy|terms(-[a-z-]+)?|terms-and-conditions|eula|contact(-us)?)(\/|$)/i;
const ARCHIVE_JUNK_RE = /^\/(tag|author)\//i;
const DATE_ARCHIVE_RE = /^\/\d{4}(\/\d{2})?$/; // bare /2024 or /2024/05 archive pages
const FEED_RE = /\/feed$/i;

function commonJunk(path: string): Classification | null {
  if (ASSET_EXT_RE.test(path)) return junk("asset");
  if (WP_JUNK_RE.test(path)) return junk("wp-internal");
  if (FEED_RE.test(path)) return junk("feed");
  if (ARCHIVE_JUNK_RE.test(path)) return junk("archive");
  if (DATE_ARCHIVE_RE.test(path)) return junk("date-archive");
  if (LEGAL_JUNK_RE.test(path)) return junk("legal");
  return null;
}

const PRODUCT_PATH_RE = /^\/product\/[a-z0-9][a-z0-9-]*$/;

// --- wacgroup.com — corporate parent, 11-URL inventory, all tier 1.5 -------

const WACGROUP_KEEP: Record<string, string> = {
  "/about": "web_company",
  "/about/responsibility": "web_company",
  "/technology": "web_technology",
  "/lightandhealth": "web_technology",
  "/commercial": "web_capabilities",
  "/residential": "web_capabilities",
  "/custom": "web_capabilities",
};

function classifyWacgroup(path: string): Classification {
  if (path === "/") return junk("near-dup-of-about");
  const c = commonJunk(path);
  if (c) return c;
  const docType = WACGROUP_KEEP[path];
  if (docType) return content(docType, AUTHORITY_TIERS.wacGroupCorporate);
  return skip("not-in-inventory"); // 11 URLs audited = complete; new ones surface in the report
}

// --- waclighting.com — default-allow content with dev/ops denylist ---------

const WACL_DENY_RE =
  /(^|\/)(test|admin|import|delete|get-|api|sitemap|salesrep-|thank-you|coming-soon|file-list|developer|configuratortool|csdemokit|pop-in)|-page-\d/i;
const WACL_APPLICATIONS_RE =
  /^\/applications\/(architectural|commercial|hospitality|institutional|landscape|office|outdoor|retail|residential)(\/|$)/;
const WACL_SUBLINE = new Set(["/wac-home", "/dweled", "/ventrix", "/colorscaping"]);

function classifyWaclighting(path: string): Classification {
  const c = commonJunk(path);
  if (c) return c;
  if (PRODUCT_PATH_RE.test(path)) return { kind: "product", region: null, ingest: false };
  if (path.startsWith("/product-category/")) return skip("category");
  if (path === "/catalog" || path.startsWith("/catalog/")) return skip("category");
  if (path.startsWith("/literature")) return skip("resource");
  if (WACL_APPLICATIONS_RE.test(path)) return content("web_capabilities", AUTHORITY_TIERS.brandCorporate);
  if (path === "/ourstory") return content("web_company", AUTHORITY_TIERS.brandCorporate);
  if (WACL_SUBLINE.has(path)) return content("web_capabilities", AUTHORITY_TIERS.marketingBaseline);
  if (path === "/warranty") return content("web_warranty", AUTHORITY_TIERS.marketingBaseline);
  if (path === "/faq" || path === "/education") return content("web_faq", AUTHORITY_TIERS.marketingBaseline);
  if (path.startsWith("/blog")) return content("web_news", AUTHORITY_TIERS.news);
  if (WACL_DENY_RE.test(path)) return junk("dev-ops");
  // Default-allow: flat bespoke marketing/info slugs from page-sitemap.
  return content("web_capabilities", AUTHORITY_TIERS.marketingBaseline);
}

// --- modernforms.com — ALLOWLIST over page-sitemap (it's polluted) ---------

// The FAQ cluster ships TWO real, differently-pluralized slug spellings —
// /smart-fan-faqs-smart-advice/ AND /smart-fans-faqs-integration/. The
// optional-s pattern matches BOTH; a bare singular pattern silently drops the
// plural page under the allowlist-only policy (ratification objection 1).
const MF_FAQ_RE = /^\/smart-fans?-faqs-[a-z-]+$/;
const MF_ALLOW: Record<string, string> = {
  "/who-we-are": "web_company",
  "/fantechnology": "web_technology",
  "/warranty": "web_warranty",
  "/fans/integration": "web_faq",
  "/fans/over-the-air-updates": "web_faq",
  "/fans/smart-advice": "web_faq",
  "/fans/support-videos": "web_faq",
  "/product-registration": "web_faq",
  "/where-to-buy": "web_faq",
};
const MF_TIER: Record<string, number> = {
  web_company: AUTHORITY_TIERS.brandCorporate,
  web_technology: AUTHORITY_TIERS.brandCorporate,
};

function classifyModernforms(path: string, sitemapFile: string | null): Classification {
  const c = commonJunk(path);
  if (c) return c;
  if (PRODUCT_PATH_RE.test(path)) return { kind: "product", region: null, ingest: false };
  if (path.startsWith("/product-category/")) return skip("category");
  // News is classified by sitemap PROVENANCE — post-sitemap slugs are flat.
  if (sitemapFile && /^post-sitemap\d*\.xml$/.test(sitemapFile)) {
    return content("web_news", AUTHORITY_TIERS.news);
  }
  if (path.startsWith("/blog")) return content("web_news", AUTHORITY_TIERS.news);
  if (path.startsWith("/nature/")) return content("web_technology", AUTHORITY_TIERS.brandCorporate);
  if (MF_FAQ_RE.test(path)) return content("web_faq", AUTHORITY_TIERS.marketingBaseline);
  const allowed = MF_ALLOW[path];
  if (allowed) return content(allowed, MF_TIER[allowed] ?? AUTHORITY_TIERS.marketingBaseline);
  return junk("not-allowlisted");
}

// --- schonbek.com — page-sitemap-scoped denylist; intl = category surface --

const SCHONBEK_PAGE_DENY_LITERAL = new Set([
  "/ppidjump", "/qrcodes", "/site-map", "/image-importer", "/curated-order-lookup",
  "/press-2", "/new-home-page", "/who-we-are",
]);
const SCHONBEK_PAGE_DENY_RE =
  /(^\/(admin|reports?|thank-you|rsvp|test|rss)[-_/])|([-_]reports?($|[-_]))|(-old($|[-_]))|(_$)/i;
const SCHONBEK_CARE = new Set(["/education", "/lighting-care", "/crystal-care", "/finish-care"]);
const DATED_POST_RE = /^\/\d{4}\/\d{2}\/[a-z0-9-]+$/;

function classifySchonbek(path: string, sitemapFile: string | null): Classification {
  const c = commonJunk(path);
  if (c) return c;
  if (PRODUCT_PATH_RE.test(path)) return { kind: "product", region: null, ingest: false };
  // /products listing (the ?product= facet was stripped at canonicalization —
  // product sitemaps are the sole authoritative PDP frontier source).
  if (path === "/products" || path.startsWith("/products/")) return skip("category");
  if (path === "/international" || path.startsWith("/international/")) return skip("category");
  if (path === "/literature" || path.startsWith("/literature/")) return skip("resource");
  // The dev/ops denylist is SCOPED to page-sitemap provenance so numbered PDP
  // slugs (adley-2) can never be caught by the `-2` style patterns — and it
  // runs BEFORE content typing so /press-2 (stale dup) can't ride the /press
  // news prefix into the corpus.
  const fromPageSitemap = sitemapFile ? /^page-sitemap\d*\.xml$/.test(sitemapFile) : true;
  if (fromPageSitemap) {
    if (SCHONBEK_PAGE_DENY_LITERAL.has(path)) return junk("dev-ops");
    if (SCHONBEK_PAGE_DENY_RE.test(path)) return junk("dev-ops");
  }
  if (path === "/our-story") return content("web_company", AUTHORITY_TIERS.brandCorporate);
  if (path.startsWith("/blog") || path.startsWith("/stories") || path.startsWith("/press") || DATED_POST_RE.test(path)) {
    return content("web_news", AUTHORITY_TIERS.news);
  }
  if (SCHONBEK_CARE.has(path)) return content("web_faq", AUTHORITY_TIERS.marketingBaseline);
  if (path === "/warranty") return content("web_warranty", AUTHORITY_TIERS.marketingBaseline);
  if (path.startsWith("/brands/")) return content("web_capabilities", AUTHORITY_TIERS.marketingBaseline);
  return content("web_capabilities", AUTHORITY_TIERS.marketingBaseline);
}

// --- aispire.com — /product regex; comparison pages denylisted -------------

// Live-verified: the comparison chart is ONE raster image naming real
// competitor products/companies; no separable safe text exists. Per Davis's
// guardrail (public bot never names competitors) both stay out entirely.
const AISPIRE_DENY = new Set(["/comparison", "/abicuscomparison", "/resources-old"]);

function classifyAispire(path: string): Classification {
  const c = commonJunk(path);
  if (c) return c;
  if (AISPIRE_DENY.has(path)) return junk("competitor-comparison-or-stale");
  // Classified by PATH REGEX, not sitemap membership — product-sitemap.xml's
  // first entry is the shop root.
  if (PRODUCT_PATH_RE.test(path)) return { kind: "product", region: null, ingest: false };
  if (path === "/shop" || path.startsWith("/shop/")) return skip("category");
  if (path.startsWith("/product-category/")) return skip("category");
  if (path === "/company") return content("web_company", AUTHORITY_TIERS.aispireCorporate);
  if (path.startsWith("/blog")) return content("web_news", AUTHORITY_TIERS.news);
  return content("web_capabilities", AUTHORITY_TIERS.marketingBaseline);
}

// --- wacarchitectural.com — Blazor, region-split, seeded BFS ---------------

const WACARCH_REGION_RE = /^\/(na|int)(\/|$)/;
const WACARCH_PDP_RE = /^\/(na|int)\/product-detail\/\d+$/;
const WACARCH_DETAIL = /^\/(na|int)\/(news-detail|project-detail)\/\d+$/;
// Base (unfaceted) listings: /products[/{indoor|outdoor}[/{numericId}]].
// A non-numeric 4th segment (or any 5th) is a live filter facet.
const WACARCH_LISTING_RE = /^\/(na|int)\/(projects|news|products(\/(indoor|outdoor)(\/\d+)?)?)$/;

function classifyWacarchitectural(path: string): Classification {
  const m = path.match(WACARCH_REGION_RE);
  if (!m) return skip("no-region"); // root redirects by IP; only /na|/int namespaces are real
  const region = m[1] as "na" | "int";
  if (path === `/${region}` || path === `/${region}/about`) {
    return content("web_company", AUTHORITY_TIERS.brandCorporate, region);
  }
  if (path === `/${region}/contact`) return junk("legal");
  if (WACARCH_PDP_RE.test(path)) {
    // No catalog rows exist yet (Sales Layer add pending) — PDP prose is the
    // interim product knowledge, so this brand ALONE ingests web_product.
    return { kind: "product", region, ingest: true };
  }
  const d = path.match(WACARCH_DETAIL);
  if (d) {
    return d[2] === "news-detail"
      ? content("web_news", AUTHORITY_TIERS.news, region)
      : content("web_capabilities", AUTHORITY_TIERS.news, region, true); // project case studies: opt-in
  }
  if (WACARCH_LISTING_RE.test(path)) return { kind: "listing", region };
  if (path.startsWith(`/${region}/products/`)) return junk("filter-facet");
  if (path === `/${region}/resources`) return skip("resource");
  return skip("unmapped");
}

// --- dispatcher -------------------------------------------------------------

export function classify(
  siteKey: string,
  path: string,
  sitemapFile: string | null = null,
): Classification {
  switch (siteKey) {
    case "wacgroup": return classifyWacgroup(path);
    case "waclighting": return classifyWaclighting(path);
    case "modernforms": return classifyModernforms(path, sitemapFile);
    case "schonbek": return classifySchonbek(path, sitemapFile);
    case "aispire": return classifyAispire(path);
    case "wacarchitectural": return classifyWacarchitectural(path);
    default: return skip("unknown-site");
  }
}
