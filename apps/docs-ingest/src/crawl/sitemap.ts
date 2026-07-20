/**
 * Sitemap parsing — index recursion is the CALLER's job (it owns fetching);
 * this module classifies and parses one XML document at a time, with the same
 * shape validation as robots.ts (an HTML-shaped 200 is NOT a sitemap —
 * wacarchitectural's catch-all serves markup for /sitemap.xml too).
 */

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export type ParsedSitemap =
  | { kind: "index"; sitemaps: SitemapEntry[] }
  | { kind: "urlset"; urls: SitemapEntry[] }
  | { kind: "invalid" };

export function looksLikeXml(body: string, contentType: string | null): boolean {
  const t = body.trimStart();
  if (contentType && /text\/html/i.test(contentType) && !t.startsWith("<?xml")) return false;
  return t.startsWith("<?xml") || t.startsWith("<urlset") || t.startsWith("<sitemapindex");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}

function entriesOf(block: string): SitemapEntry | null {
  const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/i);
  if (!loc) return null;
  const lastmod = block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i);
  return { loc: decodeEntities(loc[1]!), lastmod: lastmod ? lastmod[1]!.trim() : null };
}

export function parseSitemap(body: string, contentType: string | null = null): ParsedSitemap {
  if (!looksLikeXml(body, contentType)) return { kind: "invalid" };
  if (/<sitemapindex[\s>]/i.test(body)) {
    const sitemaps: SitemapEntry[] = [];
    for (const m of body.matchAll(/<sitemap[\s>][\s\S]*?<\/sitemap>/gi)) {
      const e = entriesOf(m[0]);
      if (e) sitemaps.push(e);
    }
    return { kind: "index", sitemaps };
  }
  if (/<urlset[\s>]/i.test(body)) {
    const urls: SitemapEntry[] = [];
    for (const m of body.matchAll(/<url[\s>][\s\S]*?<\/url>/gi)) {
      const e = entriesOf(m[0]);
      if (e) urls.push(e);
    }
    return { kind: "urlset", urls };
  }
  return { kind: "invalid" };
}

/** Basename of a sitemap URL, for per-site skip lists and provenance
 *  classification (modernforms news lives in post-sitemap.xml). */
export function sitemapBasename(url: string): string {
  try {
    const p = new URL(url).pathname;
    return p.split("/").pop() ?? p;
  } catch {
    return url;
  }
}
