import { describe, expect, it } from "vitest";
import { buildOrganizationJsonLd, buildProductPageJsonLd } from "./seo.js";
import { classifyCctType, combineCctTypes, slugifyName, isValidUrlSlug, canonicalUrlFor, brandSite } from "./productinfo.js";

const BASE = {
  ppid: "3367",
  name: "Strut LED Pendant",
  description: "A pendant.",
  brand: "WAC Lighting",
  canonicalUrl: "https://www.waclighting.com/products/strut-led-pendant",
  images: ["https://cdn.example.com/strut.jpg"],
  category: "Pendants",
  siteBase: "https://www.waclighting.com",
};

describe("buildProductPageJsonLd", () => {
  it("emits ProductGroup + hasVariant for pages with variants — no offers, no variant urls", () => {
    const { jsonld, issues } = buildProductPageJsonLd({
      ...BASE,
      variants: [
        {
          sku: "PD-1234-BK",
          finish: "Black",
          cct: "3000K",
          specs: { CCT: "3000K", Wattage: "22W", Finish: "Black" },
        },
        {
          sku: "PD-1234-WT",
          finish: "White",
          cct: "3000K",
          specs: { CCT: "3000K", Wattage: "22W", Finish: "White" },
        },
      ],
    });
    const group = jsonld[0] as Record<string, unknown>;
    expect(group["@type"]).toBe("ProductGroup");
    expect(group.productGroupID).toBe("3367");
    expect(group.variesBy).toEqual(["https://schema.org/color"]);
    const variants = group.hasVariant as Record<string, unknown>[];
    expect(variants).toHaveLength(2);
    expect(variants[0]).toMatchObject({
      sku: "PD-1234-BK",
      mpn: "PD-1234-BK",
      name: "Strut LED Pendant, Black, 3000K",
      color: "Black",
    });
    const serialized = JSON.stringify(jsonld);
    expect(serialized).not.toMatch(/offers|priceValidUntil|shippingDetails|MerchantReturnPolicy/);
    expect(variants[0]!.url).toBeUndefined();
    expect(issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("emits a plain Product (never a page-level Product beside a group) without variants", () => {
    const { jsonld } = buildProductPageJsonLd({
      ...BASE,
      variants: [],
      productSpecs: { Wattage: "22W" },
    });
    const types = jsonld.map((n) => (n as Record<string, unknown>)["@type"]);
    expect(types).toEqual(["Product", "BreadcrumbList"]);
  });

  it("flags required fields as errors and missing specs as warnings", () => {
    const { issues } = buildProductPageJsonLd({
      ...BASE,
      description: null,
      brand: null,
      images: [],
      variants: [{ sku: "X-1", specs: {} }],
    });
    const errors = issues.filter((i) => i.level === "error").map((i) => i.message);
    expect(errors.join(" ")).toMatch(/description/);
    expect(errors.join(" ")).toMatch(/brand/);
    expect(errors.join(" ")).toMatch(/image/);
    expect(issues.some((i) => i.level === "warn" && /specs/.test(i.message))).toBe(true);
  });

  it("builds a breadcrumb Home → Category → Product", () => {
    const { jsonld } = buildProductPageJsonLd({ ...BASE, variants: [] });
    const crumb = jsonld.find(
      (n) => (n as Record<string, unknown>)["@type"] === "BreadcrumbList",
    ) as { itemListElement: { name: string; item?: string }[] };
    expect(crumb.itemListElement.map((e) => e.name)).toEqual([
      "Home",
      "Pendants",
      "Strut LED Pendant",
    ]);
  });
});

describe("buildOrganizationJsonLd", () => {
  it("emits name/url/logo/sameAs", () => {
    expect(
      buildOrganizationJsonLd({
        name: "WAC Lighting",
        url: "https://www.waclighting.com",
        logo: "https://www.waclighting.com/logo.png",
        sameAs: ["https://www.instagram.com/waclighting"],
      }),
    ).toMatchObject({ "@type": "Organization", name: "WAC Lighting" });
  });
});

describe("classifyCctType", () => {
  it("classifies from the zcct code first", () => {
    expect(classifyCctType("TWA", null)).toMatchObject({ normalized: "CCT Tunable" });
    expect(classifyCctType("TWB", "2700K-6500K")).toMatchObject({ normalized: "CCT Tunable" });
    expect(classifyCctType("CS", "2700K/3000K/3500K/4000K/5000K")).toMatchObject({
      normalized: "CCT Selectable",
    });
    expect(classifyCctType("9CS", null)).toMatchObject({ normalized: "CCT Selectable" });
    expect(classifyCctType("CC", null)).toMatchObject({ normalized: "Color Changing" });
    expect(classifyCctType("RGB", null)).toMatchObject({ normalized: "Color Changing" });
  });

  it("falls back to the parsed description", () => {
    expect(classifyCctType("930", "3000K")).toMatchObject({ normalized: "Fixed CCT" });
    expect(classifyCctType(null, "2700K/3000K")).toMatchObject({ normalized: "CCT Selectable" });
    expect(classifyCctType(null, "1800K-4000K")).toMatchObject({ normalized: "CCT Tunable" });
    expect(classifyCctType(null, "R, G, B, 1800K - 6500K")).toMatchObject({
      normalized: "Color Changing",
    });
  });

  it("flags the unclassifiable", () => {
    expect(classifyCctType("WD", "Warm Dim").ok).toBe(false);
  });
});

describe("combineCctTypes", () => {
  it("agrees → that type; disagrees → flagged", () => {
    expect(combineCctTypes(["Fixed CCT", "Fixed CCT"])).toMatchObject({
      normalized: "Fixed CCT",
    });
    const r = combineCctTypes(["Fixed CCT", "CCT Tunable"]);
    expect(r.ok).toBe(false);
  });
});

describe("slug + canonical helpers", () => {
  it("slugifies product names", () => {
    expect(slugifyName("InvisiLED® 5' Surface Mounted Channel")).toBe(
      "invisiled-5-surface-mounted-channel",
    );
    expect(isValidUrlSlug("invisiled-5-surface-mounted-channel")).toBe(true);
    expect(isValidUrlSlug("Bad_Slug")).toBe(false);
  });

  it("builds brand-aware canonical URLs", () => {
    expect(canonicalUrlFor("Modern Forms", "aura-fan")).toBe(
      "https://modernforms.com/products/aura-fan",
    );
    expect(canonicalUrlFor("Unknown Brand", "x")).toBe(
      "https://www.waclighting.com/products/x",
    );
  });

  it("maps WAC Architectural to its own site, not the waclighting default", () => {
    expect(brandSite("WAC Architectural")).toBe("https://www.wacarchitectural.com");
    expect(brandSite("wac architectural")).toBe("https://www.wacarchitectural.com");
    // PDPs there are /na/product-detail/{numericId} — no slug route exists,
    // so the best-guess canonical is the brand site itself.
    expect(canonicalUrlFor("WAC Architectural", "some-product")).toBe(
      "https://www.wacarchitectural.com",
    );
  });
});

import { diffFamilyCopies } from "./productinfo.js";

describe("diffFamilyCopies", () => {
  it("marks sentences shared by every family member as common", () => {
    const a = "Calliope brings sculpted light. The 24-inch pendant suits entries.";
    const b = "Calliope brings sculpted light. The 36-inch chandelier anchors dining rooms.";
    const [da, db] = diffFamilyCopies([a, b]);
    expect(da![0]).toMatchObject({ common: true });
    expect(da![1]).toMatchObject({ common: false });
    expect(db![1]!.text).toMatch(/36-inch/);
    expect(db![1]!.common).toBe(false);
  });

  it("a single copy has no common baseline", () => {
    const [only] = diffFamilyCopies(["One sentence."]);
    expect(only![0]!.common).toBe(false);
  });
});
