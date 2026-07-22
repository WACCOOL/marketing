// =============================================================================
// PDP accessory reconciliation (compat plan v2.1 Phase 2 / §D): pdp_urls slug
// inversion, owner/ref resolution with per-site provenance labeling, the
// in-payload dedup, and the source-scoped prune posture (never sales_layer).
// =============================================================================
import { describe, expect, it } from "vitest";
import { accessoryPruneDecision } from "@wac/shared";
import {
  ACCESSORY_SITES,
  buildPdpAccessoryRows,
  invertPdpUrls,
  type FrontierAccessoryPdp,
} from "./reconcileAccessories.js";

const STAMP = "2026-07-22T00:00:00.000Z";

const PDP_URLS = [
  { sku: "2001", brand: "WAC", slug: "housing-r2asd", url: "https://waclighting.com/product/housing-r2asd/" },
  { sku: "2002", brand: "WAC", slug: "trim-r2asdt", url: "https://waclighting.com/product/trim-r2asdt/" },
  // url null — site derived from the canonical brand's domain, slug column used.
  { sku: "2003", brand: "WAC", slug: "trim-r2asat", url: null },
  { sku: "8817", brand: "MOF", slug: "wynd-xl", url: "https://modernforms.com/product/wynd-xl/" },
  { sku: "8901", brand: "MOF", slug: "xl-downrod-dr72", url: "https://modernforms.com/product/xl-downrod-dr72/" },
  // Same slug on TWO different skus -> ambiguous, never resolved.
  { sku: "9001", brand: "MOF", slug: "shared-slug", url: "https://modernforms.com/product/shared-slug/" },
  { sku: "9002", brand: "MOF", slug: "shared-slug", url: "https://modernforms.com/product/shared-slug/" },
  // Legacy '?s=' search fallback url — no /product/ path; slug column still resolves.
  { sku: "2004", brand: "WAC", slug: "sole-r1", url: "https://waclighting.com/?s=SOLE-R1" },
];

describe("invertPdpUrls", () => {
  const { bySlug, collisions } = invertPdpUrls(PDP_URLS);

  it("keys (site, slug) from the row url's host and path", () => {
    expect(bySlug.get("waclighting housing-r2asd")).toBe("2001");
    expect(bySlug.get("modernforms wynd-xl")).toBe("8817");
  });

  it("falls back to brand domain + slug column when url is null or slug-less", () => {
    expect(bySlug.get("waclighting trim-r2asat")).toBe("2003");
    expect(bySlug.get("waclighting sole-r1")).toBe("2004");
  });

  it("drops ambiguous slugs (two skus, one slug) and counts them", () => {
    expect(bySlug.has("modernforms shared-slug")).toBe(false);
    expect(collisions).toBe(1);
  });

  it("the same sku appearing twice with the same slug is NOT a collision", () => {
    const { bySlug: b, collisions: c } = invertPdpUrls([
      { sku: "X", brand: "WAC", slug: "dup", url: "https://waclighting.com/product/dup/" },
      { sku: "X", brand: "WAC", slug: "dup", url: null },
    ]);
    expect(b.get("waclighting dup")).toBe("X");
    expect(c).toBe(0);
  });
});

const pdp = (over: Partial<FrontierAccessoryPdp>): FrontierAccessoryPdp => ({
  url: "https://waclighting.com/product/housing-r2asd/",
  host: "waclighting.com",
  site: "waclighting",
  discovered_slug: "housing-r2asd",
  accessory_slugs: null,
  ...over,
});

describe("buildPdpAccessoryRows", () => {
  const { bySlug } = invertPdpUrls(PDP_URLS);

  it("writes waclighting Components refs as kind=component / source_field=components_section", () => {
    const built = buildPdpAccessoryRows(
      [pdp({ accessory_slugs: ["trim-r2asdt", "trim-r2asat"] })],
      bySlug,
      STAMP,
    );
    expect(built.rows).toHaveLength(2);
    expect(built.rows[0]).toEqual({
      product_sku: "2001",
      related_sku: "trim-r2asdt",
      related_product_sku: "2002",
      kind: "component",
      label: null,
      source_system: "web_crawl",
      source_field: "components_section",
      position: 1,
      synced_at: STAMP,
    });
    expect(built.rows[1]!.related_product_sku).toBe("2003");
    expect(built.ownersResolved).toBe(1);
  });

  it("writes modernforms Curated refs as kind=accessory / source_field=curated_for_you (the §D label split)", () => {
    const built = buildPdpAccessoryRows(
      [pdp({
        url: "https://modernforms.com/product/wynd-xl/",
        host: "modernforms.com",
        site: "modernforms",
        discovered_slug: "wynd-xl",
        accessory_slugs: ["xl-downrod-dr72"],
      })],
      bySlug,
      STAMP,
    );
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0]!.kind).toBe("accessory");
    expect(built.rows[0]!.source_field).toBe("curated_for_you");
    expect(built.rows[0]!.product_sku).toBe("8817");
    expect(built.rows[0]!.related_product_sku).toBe("8901");
  });

  it("keeps unresolved referenced slugs with related_product_sku null (never dropped)", () => {
    const built = buildPdpAccessoryRows(
      [pdp({ accessory_slugs: ["not-in-catalog", "shared-slug"] })],
      bySlug,
      STAMP,
    );
    expect(built.rows).toHaveLength(2);
    for (const r of built.rows) expect(r.related_product_sku).toBeNull();
    expect(built.rows.map((r) => r.related_sku)).toEqual(["not-in-catalog", "shared-slug"]);
  });

  it("skips PDPs whose OWN slug does not resolve (no product_sku, no row) and counts them", () => {
    const built = buildPdpAccessoryRows(
      [pdp({ discovered_slug: "unknown-host", url: "https://waclighting.com/product/unknown-host/", accessory_slugs: ["trim-r2asdt"] })],
      bySlug,
      STAMP,
    );
    expect(built.rows).toHaveLength(0);
    expect(built.ownersUnresolved).toBe(1);
  });

  it("never references the page's own slug and dedupes repeats (linkSeen; resolution upgrades)", () => {
    const built = buildPdpAccessoryRows(
      [pdp({ accessory_slugs: ["housing-r2asd", "trim-r2asdt", "trim-r2asdt"] })],
      bySlug,
      STAMP,
    );
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0]!.related_sku).toBe("trim-r2asdt");
  });

  it("ignores sites outside the roster (schonbek excluded per plan §D)", () => {
    const built = buildPdpAccessoryRows(
      [pdp({ site: "schonbek", host: "schonbek.com", url: "https://schonbek.com/product/arlington-12/", discovered_slug: "arlington-12", accessory_slugs: ["x-1"] })],
      bySlug,
      STAMP,
    );
    expect(built.rows).toHaveLength(0);
    expect(built.withSlugs).toBe(0);
    expect(Object.keys(ACCESSORY_SITES)).toEqual(["waclighting", "modernforms"]);
  });

  it("counts every RESOLVABLE scanned PDP into ownerSkusSeen (the prune guard's feed signal), slugs or not", () => {
    const built = buildPdpAccessoryRows(
      [
        pdp({ accessory_slugs: null }), // resolvable owner, nothing harvested this run
        pdp({
          url: "https://modernforms.com/product/wynd-xl/",
          host: "modernforms.com",
          site: "modernforms",
          discovered_slug: "wynd-xl",
          accessory_slugs: ["xl-downrod-dr72"],
        }),
      ],
      bySlug,
      STAMP,
    );
    expect(built.ownerSkusSeen).toEqual(new Set(["2001", "8817"]));
  });
});

describe("prune guard (PL7, shared decision) wired to the web_crawl scope", () => {
  it("a selector-breakage run (0 captured, owners still known) ABORTS the prune", () => {
    const d = accessoryPruneDecision({
      captured: 0,
      previous: 500,
      previousProductSkus: ["2001", "8817"],
      feedSkus: new Set(["2001", "8817"]),
    });
    expect(d.prune).toBe(false);
    expect(d.warn).toMatch(/ABORTED/);
  });

  it("a genuine shrink (owners gone from the frontier) prunes normally", () => {
    const d = accessoryPruneDecision({
      captured: 0,
      previous: 500,
      previousProductSkus: ["2001"],
      feedSkus: new Set<string>(),
    });
    expect(d.prune).toBe(true);
  });
});

describe("sales_layer isolation", () => {
  it("the reconciler's write/prune vocabulary is web_crawl-scoped and never names sales_layer", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./reconcileAccessories.ts", import.meta.url), "utf8"),
    );
    // Prune and guard reads are scoped to THIS source...
    expect(src).toContain(`.eq("source_system", "web_crawl")`);
    // ...and the string 'sales_layer' appears nowhere outside comments.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^\s*\*.*$/gm, "");
    expect(code).not.toContain("sales_layer");
    // Financial guardrail (house idiom): no price/financial keys written.
    for (const banned of ["price", "amount", "cost", "quote_net"]) {
      expect(code.toLowerCase().includes(`"${banned}`)).toBe(false);
      expect(code.toLowerCase().includes(`${banned}:`)).toBe(false);
    }
  });
});
