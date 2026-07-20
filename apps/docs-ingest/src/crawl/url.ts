import { siteForHost } from "./sites.js";

/**
 * URL canonicalization — one URL, one frontier row.
 *
 * Rules (ratified plan A + v2.1 pagination exception):
 *  - https only, lowercase host, host aliases collapse onto the site's
 *    canonical host (www→apex everywhere EXCEPT wacarchitectural, which is
 *    apex→www — audited: its apex 301s to www);
 *  - fragments dropped;
 *  - tracking/facet/session params stripped (utm_*, s, p, paged, orderby,
 *    add-to-cart, filter_*, replytocom, brand, family, product, sessions);
 *  - PER-HOST EXCEPTION: bare `p` (pagination) is PRESERVED on
 *    wacarchitectural's base (unfaceted) category listings, /projects and
 *    /news listings — their `?p=N` pagination is the ONLY way the crawler
 *    sees pages 2..N (audit: /na/products/indoor/12 is page 1 of 7), and the
 *    facet-drop coverage argument depends on traversing it. Faceted 4th-segment
 *    category variants never inherit the exception;
 *  - trailing slash collapsed (except root);
 *  - remaining query params sorted for stable identity.
 */

const STRIP_EXACT = new Set([
  "s", "p", "paged", "orderby", "order", "add-to-cart", "replytocom",
  "brand", "family", "product", "t",
  "phpsessid", "sessionid", "sid", "fbclid", "gclid", "msclkid",
]);
const STRIP_PREFIX = ["utm_", "filter_", "query_type_", "pa_"];

/** wacarchitectural listing paths whose bare `?p=` pagination must survive
 *  canonicalization. Base category listings are at most
 *  /{region}/products[/{indoor|outdoor}[/{categoryId}]] with a NUMERIC
 *  category id — a 4th non-numeric segment (or a 5th segment) is a live
 *  filter facet, which never keeps `p`. */
const WACARCH_PAGINATED = /^\/(na|int)\/(projects|news|products(\/(indoor|outdoor)(\/\d+)?)?)$/;

export function keepsPagination(host: string, path: string): boolean {
  const site = siteForHost(host);
  if (!site || site.key !== "wacarchitectural") return false;
  return WACARCH_PAGINATED.test(stripTrailingSlash(path));
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export interface CanonicalUrl {
  url: string;
  host: string;
  path: string;
  siteKey: string | null;
}

/** Canonicalize a discovered URL. Returns null for non-http(s), unknown hosts,
 *  or obvious non-page schemes — the frontier only holds roster URLs. */
export function canonicalizeUrl(raw: string, baseUrl?: string): CanonicalUrl | null {
  let u: URL;
  try {
    u = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  const site = siteForHost(u.hostname);
  if (!site) return null;
  const host = site.host;

  let path = stripTrailingSlash(u.pathname.toLowerCase());
  if (!path.startsWith("/")) path = `/${path}`;

  const keepP = keepsPagination(host, path);
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    const key = k.toLowerCase();
    if (key === "p" && keepP) {
      // page 1 is the base URL itself — don't mint a ?p=1 duplicate.
      if (v !== "" && v !== "1") kept.push([key, v]);
      continue;
    }
    if (STRIP_EXACT.has(key)) continue;
    if (STRIP_PREFIX.some((p) => key.startsWith(p))) continue;
    kept.push([key, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = kept.length
    ? `?${kept.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`
    : "";

  return {
    url: `https://${host}${path}${query}`,
    host,
    path,
    siteKey: site.key,
  };
}

/** Extract + canonicalize every same-roster href in an HTML document. */
export function extractLinks(html: string, pageUrl: string): CanonicalUrl[] {
  const out = new Map<string, CanonicalUrl>();
  const re = /<a\s[^>]*href\s*=\s*["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) != null) {
    const c = canonicalizeUrl(m[1]!, pageUrl);
    if (c && !out.has(c.url)) out.set(c.url, c);
  }
  return [...out.values()];
}
