import { describe, expect, it, vi } from "vitest";
import { crawlSite } from "./stepW.js";
import { SITE_BY_KEY } from "./sites.js";

/**
 * Step W integration over an injected fetch — no network, no DB server: the
 * Supabase client is a minimal in-memory stub capturing upserts.
 */

const PARA =
  "WAC Group unites four main lighting brands with vertically integrated manufacturing, global logistics, and photometric labs on three continents serving architects worldwide.";

function html(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

type Handler = (url: string) => { status: number; body?: string; headers?: Record<string, string> };

function fetchStub(routes: Record<string, Handler | { status: number; body?: string; headers?: Record<string, string> }>): typeof fetch {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    const route = routes[url];
    const r = typeof route === "function" ? route(url) : route ?? { status: 404, body: "not found" };
    return new Response(r.body ?? "", {
      status: r.status,
      headers: { "content-type": "text/html", ...(r.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
}

interface Captured {
  kb: Record<string, unknown>[];
  frontier: Record<string, unknown>[];
  kbUpdates: { match: Record<string, unknown>; patch: Record<string, unknown> }[];
}

function sbStub(existing: { frontier?: Record<string, unknown>[]; kb?: Record<string, unknown>[] } = {}): { sb: never; captured: Captured } {
  const captured: Captured = { kb: [], frontier: [], kbUpdates: [] };
  const table = (name: string) => {
    const rowsFor = () => (name === "crawl_frontier" ? existing.frontier ?? [] : existing.kb ?? []);
    const q = {
      _filters: {} as Record<string, unknown>,
      select: () => q,
      eq: (k: string, v: unknown) => { q._filters[k] = v; return q; },
      like: () => q,
      range: (from: number) => Promise.resolve({ data: from === 0 ? rowsFor() : [], error: null }),
      upsert: (rows: Record<string, unknown>[]) => {
        (name === "kb_documents" ? captured.kb : captured.frontier).push(...rows);
        return Promise.resolve({ error: null });
      },
      update: (patch: Record<string, unknown>) => {
        const chain = {
          eq: (k: string, v: unknown) => {
            q._filters[k] = v;
            return chain;
          },
          then: (resolve: (v: { error: null }) => void) => {
            captured.kbUpdates.push({ match: { ...q._filters }, patch });
            resolve({ error: null });
          },
        };
        return chain;
      },
    };
    return q;
  };
  return { sb: { from: table } as never, captured };
}

describe("crawlSite — sitemap discovery (wacgroup)", () => {
  const site = SITE_BY_KEY.get("wacgroup")!;

  const routes = {
    "https://wacgroup.com/robots.txt": {
      status: 200,
      body: "User-agent: *\nCrawl-delay: 0\nSitemap: https://wacgroup.com/sitemap.xml\n",
      headers: { "content-type": "text/plain" },
    },
    "https://wacgroup.com/sitemap.xml": {
      status: 200,
      body: `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://wacgroup.com/page-sitemap.xml</loc></sitemap></sitemapindex>`,
      headers: { "content-type": "text/xml" },
    },
    "https://wacgroup.com/page-sitemap.xml": {
      status: 200,
      body: `<?xml version="1.0"?><urlset>
        <url><loc>https://wacgroup.com/about/</loc></url>
        <url><loc>https://wacgroup.com/technology/</loc></url>
        <url><loc>https://wacgroup.com/privacy-policy/</loc></url>
        <url><loc>https://wacgroup.com/contact-us/</loc></url>
      </urlset>`,
      headers: { "content-type": "text/xml" },
    },
    "https://wacgroup.com/about": { status: 200, body: html("About Us - WACGROUP", `<p>${PARA}</p>`) },
    "https://wacgroup.com/technology": { status: 200, body: html("Technology - WACGROUP", `<p>${PARA}</p>`) },
  };

  it("captures the keep-pages as pending kb docs with authority, junk never fetched", async () => {
    const { sb, captured } = sbStub();
    const stats = await crawlSite(site, { sb, store: null, fetchImpl: fetchStub(routes), sleep: () => Promise.resolve(), log: () => {} },
      { dryRun: false, limit: null, harvestPdp: false, includeOptIn: false }, () => "2026-07-20T00:00:00Z");

    expect(stats.captured).toBe(2);
    expect(captured.kb).toHaveLength(2);
    for (const row of captured.kb) {
      expect(row.source_system).toBe("web_crawl");
      expect(row.scope).toBe("public");
      expect(row.brand).toBe("WAC Group");
      expect(row.authority).toBe(1.5);
      expect(row.status).toBe("pending_extract");
      expect(row.content_hash).toBeTruthy();
    }
    const types = captured.kb.map((r) => r.doc_type).sort();
    expect(types).toEqual(["web_company", "web_technology"]);
    // junk (privacy-policy, contact-us) never became frontier rows or fetches
    expect(captured.frontier.every((r) => !(r.url as string).includes("privacy"))).toBe(true);
  });

  it("is idempotent: unchanged hash → no kb row, no pending flip", async () => {
    const first = sbStub();
    await crawlSite(site, { sb: first.sb, store: null, fetchImpl: fetchStub(routes), sleep: () => Promise.resolve(), log: () => {} },
      { dryRun: false, limit: null, harvestPdp: false, includeOptIn: false }, () => "2026-07-20T00:00:00Z");
    const hashes = new Map(first.captured.kb.map((r) => [r.external_id as string, r.content_hash as string]));

    const second = sbStub({
      kb: [...hashes.entries()].map(([external_id, content_hash]) => ({ external_id, content_hash })),
    });
    const stats = await crawlSite(site, { sb: second.sb, store: null, fetchImpl: fetchStub(routes), sleep: () => Promise.resolve(), log: () => {} },
      { dryRun: false, limit: null, harvestPdp: false, includeOptIn: false }, () => "2026-07-20T00:00:00Z");
    expect(stats.captured).toBe(0);
    expect(stats.unchanged).toBe(2);
    expect(second.captured.kb).toHaveLength(0);
  });

  it("supersedes a kb doc when its page 404s", async () => {
    const gone = { ...routes, "https://wacgroup.com/about": { status: 404, body: "" } };
    const { sb, captured } = sbStub({ kb: [{ external_id: "https://wacgroup.com/about", content_hash: "x" }] });
    const stats = await crawlSite(site, { sb, store: null, fetchImpl: fetchStub(gone), sleep: () => Promise.resolve(), log: () => {} },
      { dryRun: false, limit: null, harvestPdp: false, includeOptIn: false }, () => "2026-07-20T00:00:00Z");
    expect(stats.superseded).toBe(1);
    expect(captured.kbUpdates).toContainEqual({
      match: { source_system: "web_crawl", external_id: "https://wacgroup.com/about" },
      patch: { status: "superseded" },
    });
  });

  it("flags a cf-ray 403 as bot_block (error, not permanent failure)", async () => {
    const blocked = {
      ...routes,
      "https://wacgroup.com/about": { status: 403, body: "denied", headers: { "cf-ray": "abc123" } },
    };
    const { sb, captured } = sbStub();
    const stats = await crawlSite(site, { sb, store: null, fetchImpl: fetchStub(blocked), sleep: () => Promise.resolve(), log: () => {} },
      { dryRun: false, limit: null, harvestPdp: false, includeOptIn: false }, () => "2026-07-20T00:00:00Z");
    expect(stats.botBlocked).toBe(1);
    const row = captured.frontier.find((r) => r.url === "https://wacgroup.com/about");
    expect(row?.doc_type_guess).toBe("error:bot_block");
  });
});

describe("crawlSite — seeded BFS (wacarchitectural)", () => {
  const site = SITE_BY_KEY.get("wacarchitectural")!;
  const H = "https://www.wacarchitectural.com";
  const shell = html("WAC Architectural", `<div id="app"></div>`);

  const routes: Record<string, { status: number; body?: string; headers?: Record<string, string> }> = {
    // Blazor catch-all: robots.txt and sitemap.xml return the HTML shell with 200.
    [`${H}/robots.txt`]: { status: 200, body: shell },
    [`${H}/na`]: { status: 200, body: html("WAC Architectural", `<p>${PARA}</p><a href="/na/products/indoor/12">Indoor</a>`) },
    [`${H}/na/products/indoor/12`]: {
      status: 200,
      body: html("Indoor | WAC Architectural",
        `<a href="/na/product-detail/116">Model X</a><a href="/na/products/indoor/12?p=2">2</a><a href="/na/products/indoor/12/FQ">facet</a><p>Category listing of thirteen luminaires spanning recessed, suspended, and surface families for commercial interior applications everywhere.</p>`),
    },
    [`${H}/na/products/indoor/12?p=2`]: {
      status: 200,
      body: html("Indoor p2 | WAC Architectural",
        `<a href="/na/product-detail/117">Model Y</a><p>Second page of the indoor category listing containing the remaining luminaires for specification in commercial interiors and hospitality projects.</p>`),
    },
    [`${H}/na/product-detail/116`]: {
      status: 200,
      body: html("LN2-RC Recessed Linear | WAC Architectural",
        `<p>Recessed linear luminaire, 90+ CRI, regressed lens, flangeless plaster-in options for seamless architectural ceilings in commercial environments worldwide.</p><a href="/assets/LN2-RC-35_SPSHT.pdf">Spec</a>`),
    },
    [`${H}/na/product-detail/117`]: {
      status: 200,
      body: html("Not Found | WAC Architectural", `<p>${PARA}</p>`), // soft 404
    },
  };
  // Seeds not routed above 404 harmlessly.

  it("BFS discovers via links, ingests PDPs region-attributed, junks facets, follows ?p=", async () => {
    const { sb, captured } = sbStub();
    const stats = await crawlSite(site, { sb, store: null, fetchImpl: fetchStub(routes), sleep: () => Promise.resolve(), log: () => {} },
      { dryRun: false, limit: null, harvestPdp: false, includeOptIn: false }, () => "2026-07-20T00:00:00Z");

    // /na (web_company) + /na/product-detail/116 (web_product) captured;
    // the soft-404 117 was NOT.
    const byId = new Map(captured.kb.map((r) => [r.external_id as string, r]));
    expect(byId.has(`${H}/na`)).toBe(true);
    const pdp = byId.get(`${H}/na/product-detail/116`);
    expect(pdp?.doc_type).toBe("web_product");
    expect(pdp?.authority).toBe(0.8);
    expect(pdp?.brand).toBe("WAC Architectural");
    expect(byId.has(`${H}/na/product-detail/117`)).toBe(false);
    expect(stats.superseded).toBeGreaterThanOrEqual(1); // the soft 404

    // pagination followed (page 2's PDP was discovered), facet junked
    expect(captured.frontier.some((r) => r.url === `${H}/na/products/indoor/12?p=2`)).toBe(true);
    expect(captured.frontier.some((r) => (r.url as string).endsWith("/12/fq"))).toBe(false);

    // evidence harvested on the ingested PDP row
    const fRow = captured.frontier.find((r) => r.url === `${H}/na/product-detail/116`);
    expect(fRow?.region).toBe("na");
    expect(fRow?.model_codes).toContain("LN2-RC-35");
    expect((fRow?.discovered_spec_sheet_url as string) ?? "").toContain("_SPSHT.pdf");
  });
});
