import { describe, expect, it } from "vitest";
import { canonicalizeUrl, extractLinks, keepsPagination } from "./url.js";

describe("canonicalizeUrl", () => {
  it("collapses www onto the apex for the WordPress sites", () => {
    expect(canonicalizeUrl("https://www.waclighting.com/ourstory/")?.url).toBe(
      "https://waclighting.com/ourstory",
    );
    expect(canonicalizeUrl("https://www.modernforms.com/who-we-are/")?.url).toBe(
      "https://modernforms.com/who-we-are",
    );
  });

  it("wacarchitectural goes the OPPOSITE way — apex onto www (audited 301)", () => {
    expect(canonicalizeUrl("https://wacarchitectural.com/na/about")?.url).toBe(
      "https://www.wacarchitectural.com/na/about",
    );
  });

  it("drops fragments, tracking, facet and session params", () => {
    expect(
      canonicalizeUrl(
        "https://waclighting.com/faq/?utm_source=x&fbclid=1&s=track&orderby=price&filter_finish=black#q3",
      )?.url,
    ).toBe("https://waclighting.com/faq");
  });

  it("strips schonbek's legacy ?product= facet — sitemaps are the sole PDP frontier source", () => {
    expect(canonicalizeUrl("https://schonbek.com/products/?product=arlington-12/")?.url).toBe(
      "https://schonbek.com/products",
    );
  });

  it("preserves bare ?p= ONLY on wacarchitectural base listings (v2.1 exception)", () => {
    // base category listing keeps its pagination (page 1 of 7 audited)...
    expect(
      canonicalizeUrl("https://www.wacarchitectural.com/na/products/indoor/12?p=3")?.url,
    ).toBe("https://www.wacarchitectural.com/na/products/indoor/12?p=3");
    // ...?p=1 collapses onto the base URL (no page-1 duplicate)...
    expect(
      canonicalizeUrl("https://www.wacarchitectural.com/na/products/indoor/12?p=1")?.url,
    ).toBe("https://www.wacarchitectural.com/na/products/indoor/12");
    // ...faceted variants never inherit the exception...
    expect(keepsPagination("www.wacarchitectural.com", "/na/products/indoor/12/fq")).toBe(false);
    // ...and every other host strips p entirely.
    expect(canonicalizeUrl("https://waclighting.com/blog/?p=4")?.url).toBe(
      "https://waclighting.com/blog",
    );
  });

  it("keeps projects/news pagination on wacarchitectural too", () => {
    expect(keepsPagination("www.wacarchitectural.com", "/na/projects")).toBe(true);
    expect(keepsPagination("www.wacarchitectural.com", "/int/news")).toBe(true);
    expect(keepsPagination("www.wacarchitectural.com", "/na/about")).toBe(false);
  });

  it("rejects off-roster hosts and non-http schemes", () => {
    expect(canonicalizeUrl("https://example.com/about")).toBeNull();
    expect(canonicalizeUrl("mailto:someone@wacgroup.com")).toBeNull();
  });

  it("resolves relative hrefs against the page URL", () => {
    expect(canonicalizeUrl("/na/product-detail/116", "https://www.wacarchitectural.com/na/products")?.url).toBe(
      "https://www.wacarchitectural.com/na/product-detail/116",
    );
  });
});

describe("extractLinks", () => {
  it("collects deduped canonical roster links from anchors", () => {
    const html = `
      <a href="/na/product-detail/116">A</a>
      <a href="/na/product-detail/116">dup</a>
      <a href="https://www.wacarchitectural.com/na/news-detail/42?utm_source=x">B</a>
      <a href="https://twitter.com/wac">off-roster</a>`;
    const links = extractLinks(html, "https://www.wacarchitectural.com/na/products/indoor/12");
    expect(links.map((l) => l.url).sort()).toEqual([
      "https://www.wacarchitectural.com/na/news-detail/42",
      "https://www.wacarchitectural.com/na/product-detail/116",
    ]);
  });
});
