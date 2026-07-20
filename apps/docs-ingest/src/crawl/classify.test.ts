import { describe, expect, it } from "vitest";
import { classify, type Classification } from "./classify.js";

const kind = (c: Classification) => c.kind;
const docType = (c: Classification) => (c.kind === "content" ? c.docType : null);
const authority = (c: Classification) => (c.kind === "content" ? c.authority : null);

describe("classify: wacgroup.com — 7 keep / 4 junk, all tier 1.5", () => {
  it("keeps the 7 audited pages at corporate authority", () => {
    const expected: Record<string, string> = {
      "/about": "web_company",
      "/about/responsibility": "web_company",
      "/technology": "web_technology",
      "/lightandhealth": "web_technology",
      "/commercial": "web_capabilities",
      "/residential": "web_capabilities",
      "/custom": "web_capabilities",
    };
    for (const [path, dt] of Object.entries(expected)) {
      const c = classify("wacgroup", path);
      expect(kind(c), path).toBe("content");
      expect(docType(c), path).toBe(dt);
      expect(authority(c), path).toBe(1.5);
    }
  });

  it("junks the 4 audited non-pages including the near-dup root", () => {
    for (const path of ["/", "/contact-us", "/terms-and-conditions", "/privacy-policy"]) {
      expect(kind(classify("wacgroup", path)), path).toBe("junk");
    }
  });

  it("skips (reports) anything outside the audited 11-URL inventory", () => {
    expect(kind(classify("wacgroup", "/news"))).toBe("skip");
    expect(kind(classify("wacgroup", "/leadership"))).toBe("skip");
  });
});

describe("classify: waclighting.com", () => {
  it("routes PDPs to reconciliation, never ingestion", () => {
    const c = classify("waclighting", "/product/fr-w1801");
    expect(c).toEqual({ kind: "product", region: null, ingest: false });
  });

  it("skips category surfaces at any depth and literature landers", () => {
    expect(kind(classify("waclighting", "/product-category/track"))).toBe("skip");
    expect(kind(classify("waclighting", "/product-category/track/j-track/heads"))).toBe("skip");
    expect(kind(classify("waclighting", "/catalog"))).toBe("skip");
    expect(kind(classify("waclighting", "/literature/2024-catalog"))).toBe("skip");
  });

  it("classifies the nested /applications capability pages at brand tier", () => {
    for (const a of ["architectural", "hospitality", "residential"]) {
      const c = classify("waclighting", `/applications/${a}`);
      expect(docType(c)).toBe("web_capabilities");
      expect(authority(c)).toBe(1.2);
    }
    // an unlisted /applications slug is NOT the curated capability set — it
    // falls to the default-allow at marketing baseline, not brand tier
    expect(authority(classify("waclighting", "/applications/bogus"))).toBe(1.0);
  });

  it("types the bespoke flat slugs", () => {
    expect(docType(classify("waclighting", "/ourstory"))).toBe("web_company");
    expect(authority(classify("waclighting", "/ourstory"))).toBe(1.2);
    expect(docType(classify("waclighting", "/warranty"))).toBe("web_warranty");
    expect(docType(classify("waclighting", "/faq"))).toBe("web_faq");
    expect(docType(classify("waclighting", "/blog/some-post"))).toBe("web_news");
    expect(docType(classify("waclighting", "/dweled"))).toBe("web_capabilities");
  });

  it("junks the dev/ops denylist", () => {
    for (const p of [
      "/test-page", "/admin-tools", "/salesrep-portal", "/thank-you",
      "/coming-soon", "/configuratortool", "/csdemokit", "/landing-page-2", "/get-quote",
    ]) {
      expect(kind(classify("waclighting", p)), p).toBe("junk");
    }
  });

  it("default-allows unknown flat marketing slugs", () => {
    expect(kind(classify("waclighting", "/colorscaping"))).toBe("content");
    expect(kind(classify("waclighting", "/some-campaign"))).toBe("content");
  });
});

describe("classify: modernforms.com — allowlist over polluted page-sitemap", () => {
  it("REGRESSION (ratification objection 1): BOTH FAQ slug spellings survive the allowlist", () => {
    // singular "fan" spelling
    const singular = classify("modernforms", "/smart-fan-faqs-smart-advice", "page-sitemap.xml");
    // plural "fans" spelling
    const plural = classify("modernforms", "/smart-fans-faqs-integration", "page-sitemap.xml");
    expect(kind(singular)).toBe("content");
    expect(kind(plural)).toBe("content");
    expect(docType(singular)).toBe("web_faq");
    expect(docType(plural)).toBe("web_faq");
  });

  it("junks the sitemap pollution (admin/importer/reports/qrcodes...)", () => {
    for (const p of [
      "/reports/monthly", "/admin-dashboard", "/csv-importer", "/data-checker",
      "/ppidjump", "/qrcodes", "/contact-forms-submissions", "/random-unlisted-page",
    ]) {
      expect(kind(classify("modernforms", p, "page-sitemap.xml")), p).toBe("junk");
    }
  });

  it("keeps the audited allowlist", () => {
    expect(docType(classify("modernforms", "/who-we-are"))).toBe("web_company");
    expect(authority(classify("modernforms", "/who-we-are"))).toBe(1.2);
    expect(docType(classify("modernforms", "/fantechnology"))).toBe("web_technology");
    expect(docType(classify("modernforms", "/fans/over-the-air-updates"))).toBe("web_faq");
    expect(docType(classify("modernforms", "/nature/spanish-alabaster"))).toBe("web_technology");
    expect(docType(classify("modernforms", "/where-to-buy"))).toBe("web_faq");
  });

  it("classifies news by post-sitemap PROVENANCE (flat slugs)", () => {
    const c = classify("modernforms", "/introducing-the-new-fan", "post-sitemap.xml");
    expect(docType(c)).toBe("web_news");
    expect(authority(c)).toBe(0.9);
  });

  it("routes PDPs to reconciliation", () => {
    expect(kind(classify("modernforms", "/product/vox-60"))).toBe("product");
  });
});

describe("classify: schonbek.com", () => {
  it("routes PDPs to reconciliation — including numbered slugs the denylist must not catch", () => {
    const c = classify("schonbek", "/product/adley-2", "product-sitemap2.xml");
    expect(c).toEqual({ kind: "product", region: null, ingest: false });
  });

  it("scopes the dev/ops denylist to page-sitemap provenance only", () => {
    // '-2' style and '_'-suffix patterns junk page-sitemap entries...
    expect(kind(classify("schonbek", "/press-2", "page-sitemap.xml"))).toBe("junk");
    expect(kind(classify("schonbek", "/new-home-page", "page-sitemap.xml"))).toBe("junk");
    expect(kind(classify("schonbek", "/admin-tools", "page-sitemap.xml"))).toBe("junk");
    expect(kind(classify("schonbek", "/monthly_reports", "page-sitemap.xml"))).toBe("junk");
    expect(kind(classify("schonbek", "/homepage-old", "page-sitemap.xml"))).toBe("junk");
  });

  it("junks the stale /who-we-are near-dup but keeps /our-story at brand tier", () => {
    expect(kind(classify("schonbek", "/who-we-are", "page-sitemap.xml"))).toBe("junk");
    const c = classify("schonbek", "/our-story", "page-sitemap.xml");
    expect(docType(c)).toBe("web_company");
    expect(authority(c)).toBe(1.2);
  });

  it("skips the /products listing and the /international category surface", () => {
    expect(kind(classify("schonbek", "/products"))).toBe("skip");
    expect(kind(classify("schonbek", "/international"))).toBe("skip");
    expect(kind(classify("schonbek", "/international/chandelier"))).toBe("skip");
    expect(kind(classify("schonbek", "/literature"))).toBe("skip");
  });

  it("types the care cluster, news (incl. dated posts), and sub-brand pages", () => {
    expect(docType(classify("schonbek", "/crystal-care"))).toBe("web_faq");
    expect(docType(classify("schonbek", "/warranty"))).toBe("web_warranty");
    expect(docType(classify("schonbek", "/stories/a-heritage-piece"))).toBe("web_news");
    expect(docType(classify("schonbek", "/2024/05/some-announcement"))).toBe("web_news");
    expect(docType(classify("schonbek", "/brands/beyond"))).toBe("web_capabilities");
  });
});

describe("classify: aispire.com", () => {
  it("classifies PDPs by path regex, not sitemap membership — shop root skipped", () => {
    expect(kind(classify("aispire", "/product/a2ru-447", "product-sitemap.xml"))).toBe("product");
    expect(kind(classify("aispire", "/shop", "product-sitemap.xml"))).toBe("skip");
  });

  it("denylists the competitor-comparison pages (live-verified: raster chart naming competitors)", () => {
    expect(kind(classify("aispire", "/comparison"))).toBe("junk");
    expect(kind(classify("aispire", "/abicuscomparison"))).toBe("junk");
    expect(kind(classify("aispire", "/resources-old"))).toBe("junk");
  });

  it("company page carries the aiSpire tier (1.1 — below the 4 main brands)", () => {
    const c = classify("aispire", "/company");
    expect(docType(c)).toBe("web_company");
    expect(authority(c)).toBe(1.1);
  });
});

describe("classify: wacarchitectural.com — region-split Blazor site", () => {
  it("region roots and /about are brand-corporate content, region-attributed", () => {
    for (const [path, region] of [["/na", "na"], ["/int", "int"], ["/na/about", "na"], ["/int/about", "int"]] as const) {
      const c = classify("wacarchitectural", path);
      expect(kind(c), path).toBe("content");
      expect(docType(c), path).toBe("web_company");
      expect(authority(c), path).toBe(1.2);
      expect(c.kind === "content" && c.region, path).toBe(region);
    }
  });

  it("PDPs are numeric-ID routes, region-attributed, and INGESTED (interim product knowledge)", () => {
    const na = classify("wacarchitectural", "/na/product-detail/116");
    const int = classify("wacarchitectural", "/int/product-detail/116");
    expect(na).toEqual({ kind: "product", region: "na", ingest: true });
    expect(int).toEqual({ kind: "product", region: "int", ingest: true });
    // NA and INT are DISTINCT rows (specs differ per region) — same id, both kept.
  });

  it("base category listings + /projects + /news are fetch-only listings", () => {
    for (const p of ["/na/products", "/na/products/indoor", "/na/products/indoor/12", "/na/projects", "/int/news"]) {
      expect(kind(classify("wacarchitectural", p)), p).toBe("listing");
    }
  });

  it("faceted 4th-segment category variants are junk, never listings", () => {
    expect(kind(classify("wacarchitectural", "/na/products/indoor/12/fq"))).toBe("junk");
    expect(kind(classify("wacarchitectural", "/na/products/outdoor/7/xyz"))).toBe("junk");
  });

  it("news details are news; project details are opt-in capabilities", () => {
    expect(docType(classify("wacarchitectural", "/na/news-detail/42"))).toBe("web_news");
    const proj = classify("wacarchitectural", "/na/project-detail/116");
    expect(proj.kind).toBe("content");
    expect(proj.kind === "content" && proj.optIn).toBe(true);
  });

  it("non-region paths are skipped (root geo-redirects by IP)", () => {
    expect(kind(classify("wacarchitectural", "/"))).toBe("skip");
    expect(kind(classify("wacarchitectural", "/anything"))).toBe("skip");
  });
});
