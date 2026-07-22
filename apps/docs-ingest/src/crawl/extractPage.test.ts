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

  it("Modern Forms dispatcher emits the dynamic-specsheet form, NEVER the PDP path", () => {
    // The PDP-path dispatcher (`/product/<slug>?download=specsN`) answers HTML
    // (not a PDF) to fetchers — the working route is dynamic-specsheet + ppid.
    const html = page(`<div class="pdp" data-ppid="8817"></div><a href="?download=specs5">Spec Sheet</a><p>${PARA}</p>`);
    const p = extractPage(html, "https://modernforms.com/product/vox-60", { siteKey: "modernforms", brand: "Modern Forms" });
    expect(p.evidence.specSheetUrl).toBe("https://modernforms.com/dynamic-specsheet/?download=specs5&ppid=8817");
  });

  it("Modern Forms dispatcher without a data-ppid yields NO spec-sheet URL", () => {
    // Without a ppid the dynamic endpoint can't be keyed; the PDP-path form is
    // known-broken, so nothing is emitted rather than a poisoned URL.
    const html = page(`<a href="?download=specs5">Spec Sheet</a><p>${PARA}</p>`);
    const p = extractPage(html, "https://modernforms.com/product/vox-60", { siteKey: "modernforms", brand: "Modern Forms" });
    expect(p.evidence.specSheetUrl).toBeNull();
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

describe("harvestAccessorySlugs — PDP accessory-section evidence (compat Phase 2)", () => {
  const WAC_COMPONENTS = `
    <h2>Product Details</h2><p>Recessed housing.</p>
    <h3 id="components">Components</h3>
    <div class="product-belt">
      <a href="https://waclighting.com/product/trim-r2asdt/"><img src="/t1.png">R2 Round Trim</a>
      <a href="/product/trim-r2asat">R2 Adjustable Trim</a>
      <a href="/product/trim-r2asdt/?finish=bk">duplicate with params</a>
    </div>
    <h3 id="related">Related</h3>
    <div class="product-belt"><a href="/product/unrelated-thing">Other belt (out of window)</a></div>
    <footer><a href="/product/all">nav</a></footer>`;

  it("waclighting: harvests the #components product-belt slugs, window-bounded at the next heading", () => {
    const html = page(WAC_COMPONENTS, `<title>Housing</title>`);
    const p = extractPage(html, "https://waclighting.com/product/housing-r2asd", { siteKey: "waclighting", brand: "WAC Lighting" });
    expect(p.evidence.accessorySlugs).toEqual(["trim-r2asdt", "trim-r2asat"]);
    // The later "related" belt and footer nav slug never leak in.
    expect(p.evidence.accessorySlugs).not.toContain("unrelated-thing");
    expect(p.evidence.accessorySlugs).not.toContain("all");
  });

  it("waclighting: no #components heading -> no slugs (a bare product-belt elsewhere is ignored)", () => {
    const html = page(`<div class="product-belt"><a href="/product/some-thing">x</a></div>`);
    const p = extractPage(html, "https://waclighting.com/product/plain", { siteKey: "waclighting", brand: "WAC Lighting" });
    expect(p.evidence.accessorySlugs).toEqual([]);
  });

  it("waclighting: the page's own slug is excluded", () => {
    const html = page(`<h3 id="components">Components</h3><a href="/product/housing-r2asd">self</a><a href="/product/trim-x">trim</a>`);
    const p = extractPage(html, "https://waclighting.com/product/housing-r2asd", { siteKey: "waclighting", brand: "WAC Lighting" });
    expect(p.evidence.accessorySlugs).toEqual(["trim-x"]);
  });

  it("modernforms: harvests Curated For You thumbnail-section a.product-link slugs only", () => {
    const html = page(`
      <a class="nav-link" href="/product/nav-decoy">nav decoy before section</a>
      <section class="thumbnail-section curated">
        <h2>Curated For You</h2>
        <a class="card product-link" href="https://modernforms.com/product/xl-downrod-dr72/">Downrod</a>
        <a class="product-link" href="/product/f-rcbt-remote">Remote</a>
        <a class="see-all" href="/product/see-all-decoy">not a product-link</a>
      </section>`, `<title>Wynd XL</title>`);
    const p = extractPage(html, "https://modernforms.com/product/wynd-xl", { siteKey: "modernforms", brand: "Modern Forms" });
    expect(p.evidence.accessorySlugs).toEqual(["xl-downrod-dr72", "f-rcbt-remote"]);
    expect(p.evidence.accessorySlugs).not.toContain("see-all-decoy");
    expect(p.evidence.accessorySlugs).not.toContain("nav-decoy");
  });

  it("modernforms: no thumbnail-section -> no slugs even if product-link anchors exist", () => {
    const html = page(`<a class="product-link" href="/product/loose-card">x</a>`);
    const p = extractPage(html, "https://modernforms.com/product/plain-fan", { siteKey: "modernforms", brand: "Modern Forms" });
    expect(p.evidence.accessorySlugs).toEqual([]);
  });

  it("other sites (schonbek excluded per plan) never harvest", () => {
    const html = page(`<h3 id="components"></h3><div class="thumbnail-section"><a class="product-link" href="/product/x-1">x</a></div>`);
    for (const siteKey of ["schonbek", "wacgroup", "aispire", "wacarchitectural"]) {
      const p = extractPage(html, `https://example.com/product/host`, { siteKey, brand: "b" });
      expect(p.evidence.accessorySlugs).toEqual([]);
    }
  });
});
