import { describe, expect, it } from "vitest";
import {
  buildReverseIndex,
  isBadMfSpecForm,
  mfSpecCandidates,
  resolvePdp,
  slugTokens,
} from "./reconcilePdp.js";

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

describe("Modern Forms spec-sheet transform (403/HTML PDP-path dispatcher)", () => {
  it("recognizes the bad heal form and ONLY that form", () => {
    expect(isBadMfSpecForm("https://modernforms.com/product/cinema-7?download=specs5")).toBe(true);
    // The correct dynamic endpoint also carries download=specs — never a match.
    expect(isBadMfSpecForm("https://modernforms.com/dynamic-specsheet/?download=specs5&ppid=4003")).toBe(false);
    // WAC Lighting's PDP-path dispatcher WORKS — it must stay untouched.
    expect(isBadMfSpecForm("https://waclighting.com/product/j2-track?download=specs12")).toBe(false);
    expect(isBadMfSpecForm(null)).toBe(false);
    expect(isBadMfSpecForm("")).toBe(false);
  });

  it("builds probe candidates from the new harvest form (ppid param), harvested template first", () => {
    const cands = mfSpecCandidates("https://modernforms.com/dynamic-specsheet/?download=specs3&ppid=8817", null);
    expect(cands[0]).toBe("https://modernforms.com/dynamic-specsheet/?download=specs3&ppid=8817");
    expect(cands[1]).toBe("https://modernforms.com/dynamic-specsheet/?download=specs5&ppid=8817");
    // De-duped: specs3 appears once even though it's also in the shared order.
    expect(new Set(cands).size).toBe(cands.length);
    expect(cands).toHaveLength(8);
  });

  it("legacy bad-form rows fall back to the folded data-ppid evidence", () => {
    // data-ppid is folded into model_codes as the single all-digit entry
    // (asset/title codes always carry a hyphen) — and it is NOT always the
    // catalog sku, so the sku must never be used as the ppid.
    const cands = mfSpecCandidates(
      "https://modernforms.com/product/fusion?download=specs5",
      ["WS-6028-BN", "WS-6036", "1539"],
    );
    expect(cands[0]).toBe("https://modernforms.com/dynamic-specsheet/?download=specs5&ppid=1539");
  });

  it("no ppid, or an ambiguous one, yields no candidates", () => {
    expect(mfSpecCandidates("https://modernforms.com/product/fusion?download=specs5", ["WS-6028-BN"])).toEqual([]);
    expect(mfSpecCandidates("https://modernforms.com/product/fusion?download=specs5", ["1539", "4003"])).toEqual([]);
    expect(mfSpecCandidates(null, null)).toEqual([]);
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
