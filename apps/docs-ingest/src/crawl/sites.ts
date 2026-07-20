/**
 * The crawl roster — per-site facts the crawler needs before it touches the
 * network. Six sites (ratified plan + Davis 2026-07-20): wacgroup.com is the
 * corporate parent; wacarchitectural/waclighting/modernforms/schonbek are the
 * four MAIN brands; aispire.com is group-affiliated one level below.
 *
 * Everything here was live-audited during planning. The taxonomy that maps a
 * URL to keep/skip + doc_type lives in classify.ts; this file is identity,
 * discovery mode, and host canonicalization.
 */

export interface SiteConfig {
  /** Token used in THOM_CRAWL_SITES and crawl_frontier.site. */
  key: string;
  /** Canonical host (no scheme). NOTE wacarchitectural is www — the apex 301s
   *  to www and the site emits no <link rel=canonical> to derive it from. */
  host: string;
  /** Hosts that must normalize onto `host`. */
  hostAliases: string[];
  /** kb brand value for content from this site. */
  brand: string;
  /**
   * How URLs are discovered. 'sitemap' = robots Sitemap: directives +
   * /sitemap.xml fallback, recursing indexes. 'seeded-bfs' = hardcoded seeds +
   * link-following (wacarchitectural has neither robots.txt nor sitemap — its
   * Blazor catch-all 200s HTML for every unmatched path).
   */
  discovery: "sitemap" | "seeded-bfs";
  /** Seeds for seeded-bfs. NEVER the root '/': wacarchitectural's root is an
   *  IP-geolocation 302 (/na or /int + a wac_location cookie), so its outcome
   *  depends on the crawl runner's egress IP. */
  seeds?: string[];
  /** Sitemap FILES (by basename) to skip entirely. */
  sitemapSkip?: RegExp[];
  /** Politeness floor in ms between requests to this host (robots Crawl-delay,
   *  when larger, wins at runtime). */
  minDelayMs: number;
}

export const SITES: SiteConfig[] = [
  {
    key: "wacgroup",
    host: "wacgroup.com",
    hostAliases: ["www.wacgroup.com"],
    brand: "WAC Group",
    discovery: "sitemap",
    // robots Crawl-delay: 10 applies to * (audited) — runtime reads it too;
    // this floor just keeps us honest if robots ever goes missing.
    minDelayMs: 10_000,
  },
  {
    key: "wacarchitectural",
    host: "www.wacarchitectural.com",
    hostAliases: ["wacarchitectural.com"],
    brand: "WAC Architectural",
    discovery: "seeded-bfs",
    seeds: [
      "/na", "/na/products", "/na/products/indoor", "/na/products/outdoor",
      "/na/projects", "/na/news", "/na/resources", "/na/about",
      "/int", "/int/products", "/int/products/indoor", "/int/products/outdoor",
      "/int/projects", "/int/news", "/int/resources", "/int/about",
    ],
    minDelayMs: 1_000,
  },
  {
    key: "waclighting",
    host: "waclighting.com",
    hostAliases: ["www.waclighting.com"],
    brand: "WAC Lighting",
    discovery: "sitemap",
    sitemapSkip: [/wtb_online_vendor-sitemap/i, /author-sitemap/i],
    minDelayMs: 1_000,
  },
  {
    key: "modernforms",
    host: "modernforms.com",
    hostAliases: ["www.modernforms.com"],
    brand: "Modern Forms",
    discovery: "sitemap",
    sitemapSkip: [/author-sitemap/i],
    minDelayMs: 1_000,
  },
  {
    key: "schonbek",
    host: "schonbek.com",
    hostAliases: ["www.schonbek.com"],
    brand: "Schonbek",
    discovery: "sitemap",
    sitemapSkip: [/author-sitemap/i],
    minDelayMs: 1_000,
  },
  {
    key: "aispire",
    host: "aispire.com",
    hostAliases: ["www.aispire.com"],
    brand: "AiSpire",
    discovery: "sitemap", // no Sitemap: directive in robots — /sitemap.xml fallback is MANDATORY
    minDelayMs: 1_000,
  },
];

export const SITE_BY_KEY = new Map(SITES.map((s) => [s.key, s]));

export function siteForHost(host: string): SiteConfig | null {
  const h = host.toLowerCase();
  for (const s of SITES) {
    if (s.host === h || s.hostAliases.includes(h)) return s;
  }
  return null;
}

/** Parse THOM_CRAWL_SITES ("wacgroup,waclighting" | "all") into site configs. */
export function enabledSites(env: string | undefined): SiteConfig[] {
  const raw = (env ?? "").trim();
  if (!raw) return [];
  if (raw === "all") return SITES;
  const keys = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out: SiteConfig[] = [];
  for (const k of keys) {
    const site = SITE_BY_KEY.get(k);
    if (!site) throw new Error(`THOM_CRAWL_SITES: unknown site key "${k}"`);
    out.push(site);
  }
  return out;
}
