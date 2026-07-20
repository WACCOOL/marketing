import { describe, expect, it } from "vitest";
import {
  chunkableText,
  extractBreadcrumb,
  extractPage,
  extractPublishedAt,
  firstCanonical,
  firstMeta,
} from "./extractPage.js";

const PARA = "WAC Group unites four main lighting brands under one roof, with vertically integrated manufacturing and a global supply chain that spans three continents.";

function page(body: string, head = ""): string {
  return `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;
}

describe("firstMeta — first occurrence wins (wacgroup dual og block)", () => {
  it("takes the FIRST og:title when a second homepage-describing block follows", () => {
    const html = page("", `
      <meta property="og:title" content="About Us - WACGROUP" />
      <meta property="og:title" content="Home - WACGROUP" />`);
    expect(firstMeta(html, "og:title")).toBe("About Us - WACGROUP");
  });

  it("reads canonical from the first rel=canonical link", () => {
    const html = page("", `<link rel="canonical" href="https://wacgroup.com/about/" />`);
    expect(firstCanonical(html)).toBe("https://wacgroup.com/about/");
  });
});

describe("extractBreadcrumb", () => {
  it("prefers Yoast JSON-LD BreadcrumbList and drops pure-numeric segments", () => {
    const html = page("", `<script type="application/ld+json">${JSON.stringify({
      "@graph": [{
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home" },
          { "@type": "ListItem", position: 2, name: "8500" },
          { "@type": "ListItem", position: 3, name: "Smart Fans" },
        ],
      }],
    })}</script>`);
    expect(extractBreadcrumb(html)).toEqual(["Home", "Smart Fans"]);
  });

  it("falls back to a visible breadcrumb container", () => {
    const html = page(`<div class="breadcrumb"><a>Home</a> <a>Technology</a></div>`);
    expect(extractBreadcrumb(html)).toEqual(["Home", "Technology"]);
  });

  it("tolerates malformed JSON-LD", () => {
    const html = page("", `<script type="application/ld+json">{not json</script>`);
    expect(extractBreadcrumb(html)).toEqual([]);
  });
});

describe("extractPublishedAt", () => {
  it("prefers JSON-LD dateModified, falls back to article: meta", () => {
    const jsonld = page("", `<script type="application/ld+json">{"@type":"WebPage","dateModified":"2026-06-01T10:00:00+00:00"}</script>`);
    expect(extractPublishedAt(jsonld)).toBe("2026-06-01T10:00:00+00:00");
    const meta = page("", `<meta property="article:modified_time" content="2026-05-01T00:00:00Z" />`);
    expect(extractPublishedAt(meta)).toBe("2026-05-01T00:00:00Z");
  });
});

describe("extractPage — main content", () => {
  const opts = { siteKey: "wacgroup", brand: "WAC Group" };

  it("extracts content WITHOUT a <main> element (wacgroup theme) via full-body fallback", () => {
    const html = page(`
      <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
      <article><p>${PARA}</p></article>
      <article><p>Our facilities pair automated manufacturing with hand assembly, and every fixture is photometrically tested before it ships to customers worldwide.</p></article>
      <footer>© WAC Group. <a href="/privacy-policy">Privacy</a></footer>`);
    const p = extractPage(html, "https://wacgroup.com/about", opts);
    expect(p.jsShell).toBe(false);
    expect(p.text).toContain("four main lighting brands");
    expect(p.text).toContain("photometrically tested");
    expect(p.text).not.toContain("Privacy");
  });

  it("flags an empty Blazor/JS shell", () => {
    const html = page(`<div id="app"></div><script src="/blazor.web.js"></script>`);
    const p = extractPage(html, "https://www.wacarchitectural.com/na/x", { siteKey: "wacarchitectural", brand: "WAC Architectural" });
    expect(p.jsShell).toBe(true);
  });

  it("flags a soft 404 by title (wacarchitectural 200-for-everything)", () => {
    const html = page(`<p>${PARA}</p>`, `<title>Not Found | WAC Architectural</title>`);
    expect(extractPage(html, "https://www.wacarchitectural.com/na/product-detail/999999", { siteKey: "wacarchitectural", brand: "WAC Architectural" }).soft404).toBe(true);
  });

  it("summary comes from the body, never og:description", () => {
    const html = page(`<p>${PARA}</p>`, `<meta property="og:description" content="STATIC SITEWIDE TAGLINE" />`);
    const p = extractPage(html, "https://wacgroup.com/about", opts);
    expect(p.summary).toContain("four main lighting brands");
    expect(p.summary).not.toContain("STATIC SITEWIDE TAGLINE");
  });
});

describe("extractPage — PDP evidence harvest", () => {
  it("harvests model codes from asset filenames (WIES vocabulary)", () => {
    const html = page(`
      <img src="https://cdn.waclighting.com/products/FR-W1801-BK_IMRO_1.png" />
      <a href="/storage/specsheet_pdf/FR-W1801_SPSHT.pdf">Spec Sheet</a>
      <img src="/logo.png" />`);
    const p = extractPage(html, "https://waclighting.com/product/fr-w1801", { siteKey: "waclighting", brand: "WAC Lighting" });
    expect(p.evidence.modelCodes).toContain("FR-W1801-BK");
    expect(p.evidence.modelCodes).toContain("FR-W1801");
    expect(p.evidence.modelCodes).not.toContain("LOGO");
    expect(p.evidence.specSheetUrl).toBe("https://waclighting.com/storage/specsheet_pdf/FR-W1801_SPSHT.pdf");
  });

  it("falls back to the ?download=specs dispatcher on the page URL", () => {
    const html = page(`<a href="?download=specs12">Download Spec Sheet</a><p>${PARA}</p>`);
    const p = extractPage(html, "https://waclighting.com/product/j2-track", { siteKey: "waclighting", brand: "WAC Lighting" });
    expect(p.evidence.specSheetUrl).toBe("https://waclighting.com/product/j2-track?download=specs12");
  });

  it("captures Modern Forms data-ppid", () => {
    const html = page(`<div class="pdp" data-ppid="8817"></div>`);
    const p = extractPage(html, "https://modernforms.com/product/vox-60", { siteKey: "modernforms", brand: "Modern Forms" });
    expect(p.evidence.ppid).toBe("8817");
  });

  it("parses the Schonbek title into family + PPID (both title shapes)", () => {
    const withPpid = page("", `<title>Arlington | 1302E | Signature | Schonbek</title>`);
    const p1 = extractPage(withPpid, "https://schonbek.com/product/arlington-12", { siteKey: "schonbek", brand: "Schonbek" });
    expect(p1.evidence.schonbek).toEqual({ family: "Arlington", ppid: "1302E" });
    // ~40% of PDPs are bare "{Family} | Schonbek" — family captured, ppid null.
    const bare = page("", `<title>Bagatelle | Schonbek</title>`);
    const p2 = extractPage(bare, "https://schonbek.com/product/bagatelle-11", { siteKey: "schonbek", brand: "Schonbek" });
    expect(p2.evidence.schonbek).toEqual({ family: "Bagatelle", ppid: null });
  });

  it("harvests title-embedded order codes (aiSpire primary designated code)", () => {
    const html = page(`<p>${PARA}</p>`, `<title>A2RU-447-27 Recessed Uplight | AiSpire</title>`);
    const p = extractPage(html, "https://aispire.com/product/a2ru", { siteKey: "aispire", brand: "AiSpire" });
    expect(p.evidence.modelCodes).toContain("A2RU-447-27");
  });
});

describe("chunkableText — the header every chunk inherits", () => {
  it("stamps brand, breadcrumb, summary, date", () => {
    const html = page(`<p>${PARA}</p>`, `
      <title>About Us - WACGROUP</title>
      <script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[{"name":"Home"},{"name":"About"}]}</script>
      <script type="application/ld+json">{"@type":"WebPage","dateModified":"2026-06-01"}</script>`);
    const opts = { siteKey: "wacgroup", brand: "WAC Group" };
    const text = chunkableText(extractPage(html, "https://wacgroup.com/about", opts), opts);
    expect(text).toMatch(/^WAC Group — About Us - WACGROUP\nHome > About\n/);
    expect(text).toContain("Published: 2026-06-01");
    expect(text).toContain("four main lighting brands");
  });

  it("REGION LINE: /na and /int docs carry their availability, distinct per region", () => {
    const html = page(`<p>Recessed linear luminaire with regressed lens and 90+ CRI output for architectural applications in commercial interiors everywhere.</p>`, `<title>Model X | WAC Architectural</title>`);
    const base = { siteKey: "wacarchitectural", brand: "WAC Architectural" };
    const na = chunkableText(extractPage(html, "https://www.wacarchitectural.com/na/product-detail/116", base), { ...base, region: "na" });
    const int = chunkableText(extractPage(html, "https://www.wacarchitectural.com/int/product-detail/116", base), { ...base, region: "int" });
    expect(na).toContain("Availability: North America and the Caribbean only.");
    expect(int).toContain("Availability: international (rest of world), not available in China.");
    expect(na).not.toContain("rest of world");
  });
});
