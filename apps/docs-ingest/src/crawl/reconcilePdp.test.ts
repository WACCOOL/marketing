import { describe, expect, it } from "vitest";
import { buildReverseIndex, resolvePdp, slugTokens } from "./reconcilePdp.js";

/** Catalog fixtures spanning the shapes the plan calls out: a lighting
 *  product with finish-suffixed asset codes, a FAN family (per-Kelvin/CRI
 *  variants — a different code axis than finishes), a Schonbek family with
 *  export PPIDs, and two families sharing an accessory-style code. */
const PRODUCTS = [
  {
    sku: "2095",
    brand: "WAC",
    family: "J2 Track",
    name: "J2 Track Head",
    variants: [{ sku: "J2-7011-BK" }, { sku: "J2-7011-WT" }],
    primary_image_url: "https://cdn/products/J2-7011-BK_IMRO_1.png",
    image_urls: [],
    ies_url: null,
  },
  {
    sku: "8817",
    brand: "MOF",
    family: "Vox",
    name: "Vox 60 Fan",
    variants: [{ sku: "FR-W1801-60L-2700K-90" }, { sku: "FR-W1801-60L-3500K-90" }],
    primary_image_url: "https://cdn/products/FR-W1801-60L_IMRO_1.png",
    image_urls: [],
    ies_url: null,
  },
  {
    sku: "4324",
    brand: "SIGNATURE",
    family: "Arlington",
    name: "Arlington Chandelier",
    variants: [{ sku: "1302E" }],
    primary_image_url: null,
    image_urls: [],
    ies_url: null,
  },
  {
    sku: "4400",
    brand: "SIGNATURE",
    family: "Arlington",
    name: "Arlington Chandelier 8 Light",
    variants: [{ sku: "1303E" }],
    primary_image_url: null,
    image_urls: [],
    ies_url: null,
  },
  {
    sku: "7001",
    brand: "AISPIRE",
    family: "Housings",
    name: "Modular Housing",
    variants: [{ sku: "AH-100" }],
    primary_image_url: "https://cdn/products/AH-100_IMRO_1.png",
    image_urls: [],
    ies_url: null,
  },
  {
    sku: "7002",
    brand: "AISPIRE",
    family: "Trims",
    name: "Modular Trim",
    variants: [{ sku: "AH-100" }], // same accessory code appears under a SECOND family
    primary_image_url: null,
    image_urls: [],
    ies_url: null,
  },
];

const index = buildReverseIndex(PRODUCTS);

describe("slugTokens", () => {
  it("yields the slug and its numeric-suffix strip", () => {
    expect(slugTokens("arlington-12")).toEqual(["ARLINGTON-12", "ARLINGTON"]);
    expect(slugTokens("j2-track")).toEqual(["J2-TRACK"]);
  });
});

describe("resolvePdp", () => {
  it("one_sku: asset model code resolves uniquely", () => {
    const r = resolvePdp(index, ["J2-7011-BK"]);
    expect(r).toEqual({ state: "one_sku", skus: ["2095"], family: "J2 Track" });
  });

  it("one_sku: fan family per-Kelvin variant codes (the non-finish axis) resolve", () => {
    const r = resolvePdp(index, ["FR-W1801-60L-3500K-90"]);
    expect(r.state).toBe("one_sku");
    expect(r.skus).toEqual(["8817"]);
  });

  it("family: evidence hits multiple SKUs of one family (Schonbek family-name slug)", () => {
    const r = resolvePdp(index, slugTokens("arlington-12"));
    expect(r.state).toBe("family");
    expect(r.family).toBe("Arlington");
    expect(new Set(r.skus)).toEqual(new Set(["4324", "4400"]));
  });

  it("one_sku: Schonbek export PPID WINS over its own family name (key-kind tiering)", () => {
    // A PPID-bearing Schonbek title yields BOTH the family name and the PPID.
    // Family keys are weak evidence: the code-shaped PPID must decide alone.
    const r = resolvePdp(index, ["ARLINGTON", "1302E"]);
    expect(r).toEqual({ state: "one_sku", skus: ["4324"], family: "Arlington" });
  });

  it("collision: an accessory code spanning families is never auto-written", () => {
    const r = resolvePdp(index, ["AH-100"]);
    expect(r.state).toBe("collision");
    expect(r.family).toBeNull();
  });

  it("unresolved: no evidence matched", () => {
    expect(resolvePdp(index, ["totally-unknown"]).state).toBe("unresolved");
    expect(resolvePdp(index, []).state).toBe("unresolved");
  });
});

describe("financial guardrail", () => {
  it("the reconciler's write vocabulary contains no price/financial keys", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./reconcilePdp.ts", import.meta.url), "utf8"),
    );
    for (const banned of ["price", "amount", "cost", "quote_net", "$"]) {
      // Allow '$' only inside template literals/regex — assert no column
      // named like a financial field is ever written.
      if (banned === "$") continue;
      expect(src.toLowerCase().includes(`"${banned}`)).toBe(false);
      expect(src.toLowerCase().includes(`${banned}:`)).toBe(false);
    }
  });
});
