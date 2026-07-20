import { describe, expect, it } from "vitest";
import { isAllowed, looksLikeRobots, parseRobots } from "./robots.js";
import { looksLikeXml, parseSitemap, sitemapBasename } from "./sitemap.js";

describe("looksLikeRobots — the wacarchitectural HTML-shell guard", () => {
  it("rejects an HTML-shaped 200 (Blazor catch-all serves markup for /robots.txt)", () => {
    expect(looksLikeRobots("<!DOCTYPE html><html><head>...", "text/html")).toBe(false);
    expect(looksLikeRobots("  <html><body>app shell</body></html>", null)).toBe(false);
  });

  it("accepts a real robots file", () => {
    expect(looksLikeRobots("User-agent: *\nDisallow: /wp-admin/\n", "text/plain")).toBe(true);
    expect(looksLikeRobots("# comment\nSitemap: https://x.com/sitemap.xml", null)).toBe(true);
  });

  it("rejects empty or prose bodies", () => {
    expect(looksLikeRobots("", "text/plain")).toBe(false);
    expect(looksLikeRobots("welcome to our site", null)).toBe(false);
  });
});

describe("parseRobots", () => {
  const WACGROUP = `User-agent: *\nCrawl-delay: 10\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\nSitemap: https://wacgroup.com/sitemap.xml\n`;

  it("reads the wildcard group's crawl-delay (wacgroup's 10s applies to us)", () => {
    const r = parseRobots(WACGROUP);
    expect(r.crawlDelaySec).toBe(10);
    expect(r.sitemaps).toEqual(["https://wacgroup.com/sitemap.xml"]);
  });

  it("a delay scoped to a named scraper bot does NOT apply to us", () => {
    const r = parseRobots(
      `User-agent: SemrushBot\nCrawl-delay: 30\nDisallow: /\n\nUser-agent: *\nDisallow: /wp-admin/\n`,
    );
    expect(r.crawlDelaySec).toBeNull();
    expect(isAllowed(r, "/about")).toBe(true);
  });

  it("longest-match allow overrides disallow", () => {
    const r = parseRobots(WACGROUP);
    expect(isAllowed(r, "/wp-admin/settings")).toBe(false);
    expect(isAllowed(r, "/wp-admin/admin-ajax.php")).toBe(true);
    expect(isAllowed(r, "/about")).toBe(true);
  });

  it("supports * wildcards and $ anchors", () => {
    const r = parseRobots(`User-agent: *\nDisallow: /*.pdf$\nDisallow: /private*\n`);
    expect(isAllowed(r, "/docs/spec.pdf")).toBe(false);
    expect(isAllowed(r, "/docs/spec.pdf?x=1")).toBe(true);
    expect(isAllowed(r, "/private-area/page")).toBe(false);
  });
});

describe("parseSitemap", () => {
  it("rejects HTML-shaped bodies (the catch-all guard again)", () => {
    expect(parseSitemap("<!DOCTYPE html><html>...</html>", "text/html").kind).toBe("invalid");
  });

  it("parses a urlset with lastmod", () => {
    const xml = `<?xml version="1.0"?><urlset xmlns="x">
      <url><loc>https://schonbek.com/product/arlington-12/</loc><lastmod>2026-07-01</lastmod></url>
      <url><loc>https://schonbek.com/product/adley-2/</loc></url>
    </urlset>`;
    const p = parseSitemap(xml);
    expect(p.kind).toBe("urlset");
    if (p.kind === "urlset") {
      expect(p.urls).toEqual([
        { loc: "https://schonbek.com/product/arlington-12/", lastmod: "2026-07-01" },
        { loc: "https://schonbek.com/product/adley-2/", lastmod: null },
      ]);
    }
  });

  it("parses a sitemap index — BOTH schonbek product files must surface", () => {
    const xml = `<?xml version="1.0"?><sitemapindex xmlns="x">
      <sitemap><loc>https://schonbek.com/product-sitemap.xml</loc></sitemap>
      <sitemap><loc>https://schonbek.com/product-sitemap2.xml</loc></sitemap>
      <sitemap><loc>https://schonbek.com/page-sitemap.xml</loc></sitemap>
    </sitemapindex>`;
    const p = parseSitemap(xml);
    expect(p.kind).toBe("index");
    if (p.kind === "index") {
      expect(p.sitemaps.map((s) => sitemapBasename(s.loc))).toEqual([
        "product-sitemap.xml", "product-sitemap2.xml", "page-sitemap.xml",
      ]);
    }
  });

  it("decodes XML entities in locs", () => {
    const p = parseSitemap(`<?xml version="1.0"?><urlset><url><loc>https://x.com/a?b=1&amp;c=2</loc></url></urlset>`);
    if (p.kind === "urlset") expect(p.urls[0]!.loc).toBe("https://x.com/a?b=1&c=2");
  });

  it("looksLikeXml tolerates mislabeled content-type when the body is XML", () => {
    expect(looksLikeXml('<?xml version="1.0"?><urlset></urlset>', "text/html")).toBe(true);
  });
});
