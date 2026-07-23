import { describe, expect, it } from "vitest";
import { SEO_RULES } from "../productinfo.js";
import {
  DESC_TITLE_RANGE,
  itemNumberDigits,
  titleCaseName,
  titleFor,
  titleLengthOk,
} from "./titles.js";

// All product-shaped inputs are SYNTHETIC (public repo). The three pinned
// examples come verbatim from the "2026 Title Tag Prompt" docx itself.

describe("titleFor — docx-pinned formulas", () => {
  it("Schonbek: Name | digits | Luxury Crystal Type | Schonbek (docx example)", () => {
    expect(
      titleFor({
        brand: "Schonbek",
        collection: "Signature",
        name: "Bordeaux",
        productType: "Chandelier",
        modelBases: ["S5770"],
      }),
    ).toBe("Bordeaux | 5770 | Luxury Crystal Chandelier | Schonbek");
  });

  it("WAC Lighting: NAME TYPE | WAC LIGHTING (docx example)", () => {
    expect(
      titleFor({
        brand: "WAC Lighting",
        collection: "Dweled",
        name: "Capulet",
        productType: "Pendant",
        modelBases: ["ZZ99123"],
      }),
    ).toBe("CAPULET PENDANT | WAC LIGHTING");
  });

  it("Modern Forms: Name Type - Modern Forms with a hyphen, never a dash (docx example)", () => {
    const title = titleFor({
      brand: "Modern Forms",
      collection: "Luminaires",
      name: "Austen",
      productType: "Pendant",
      modelBases: ["ZZ91205"],
    });
    expect(title).toBe("Austen Pendant - Modern Forms");
    expect(title).not.toMatch(/[–—]/); // no en/em dash ever
  });
});

describe("titleFor — real-shape cases (synthetic data)", () => {
  it("uppercase sheet name normalizes to Title Case for Modern Forms", () => {
    expect(
      titleFor({
        brand: "Modern Forms",
        collection: "Luminaires",
        name: "GLOWLINE",
        productType: "Wall Sconce",
        modelBases: ["ZZ91410"],
      }),
    ).toBe("Glowline Wall Sconce - Modern Forms");
  });

  it("uppercase sheet name uppercases wholesale for WAC Lighting", () => {
    expect(
      titleFor({
        brand: "WAC Lighting",
        collection: "Dweled",
        name: "Brimlow",
        productType: "Flush Mount",
        modelBases: ["ZZ88012"],
      }),
    ).toBe("BRIMLOW FLUSH MOUNT | WAC LIGHTING");
  });

  it("Sigfor-style fallback name (Item N) flows through the Schonbek formula", () => {
    expect(
      titleFor({
        brand: "Schonbek",
        collection: "Beyond",
        name: "Item 7",
        productType: "Chandelier",
        modelBases: ["BXX55401O"],
      }),
    ).toBe("Item 7 | 55401 | Luxury Crystal Chandelier | Schonbek");
  });

  it("missing product type drops out without dangling separators", () => {
    expect(
      titleFor({
        brand: "WAC Lighting",
        collection: "Dweled",
        name: "Glimmet",
        productType: null,
        modelBases: ["ZZ88012"],
      }),
    ).toBe("GLIMMET | WAC LIGHTING");
    expect(
      titleFor({
        brand: "Modern Forms",
        collection: "Fans",
        name: "Vantrel",
        productType: null,
        modelBases: ["ZZ91060"],
      }),
    ).toBe("Vantrel - Modern Forms");
  });

  it("Schonbek with no model base omits the item-number segment", () => {
    expect(
      titleFor({
        brand: "Schonbek",
        collection: "Beyond",
        name: "Fictona",
        productType: "Pendant",
        modelBases: [],
      }),
    ).toBe("Fictona | Luxury Crystal Pendant | Schonbek");
  });

  it("missing name still yields a sane title", () => {
    expect(
      titleFor({
        brand: "WAC Lighting",
        collection: "Dweled",
        name: null,
        productType: "Pendant",
        modelBases: [],
      }),
    ).toBe("PENDANT | WAC LIGHTING");
  });

  it("fallback brands use {name} {type} | {brand}", () => {
    expect(
      titleFor({
        brand: "Aispire",
        name: "Beamlet",
        productType: "Downlight",
        modelBases: ["AI55012"],
      }),
    ).toBe("Beamlet Downlight | Aispire");
    expect(
      titleFor({
        brand: "WAC Architectural",
        name: "Trimova",
        productType: "Recessed",
        modelBases: [],
      }),
    ).toBe("Trimova Recessed | WAC Architectural");
  });

  it("never truncates the formula output", () => {
    const long = titleFor({
      brand: "Schonbek",
      name: "An Exceptionally Long Synthetic Product Name",
      productType: "Twelve Light Crystal Chandelier",
      modelBases: ["S1234567"],
    });
    expect(long.length).toBeGreaterThan(DESC_TITLE_RANGE.max);
    expect(long).toContain("An Exceptionally Long Synthetic Product Name");
  });
});

describe("itemNumberDigits (docx: Item #, do not use letters)", () => {
  it("strips the letter prefix and trailing letter suffix", () => {
    expect(itemNumberDigits("BXX55401O")).toBe("55401");
  });
  it("keeps every digit of a letter-interleaved temporary number", () => {
    expect(itemNumberDigits("31MM0612")).toBe("310612");
  });
  it("takes the leading item number of a segmented base", () => {
    expect(itemNumberDigits("S6320-401H")).toBe("6320");
  });
  it("handles digit-only and empty bases", () => {
    expect(itemNumberDigits("5770")).toBe("5770");
    expect(itemNumberDigits("")).toBe("");
    expect(itemNumberDigits(undefined)).toBe("");
    expect(itemNumberDigits("NODIGITS")).toBe("");
  });
});

describe("titleCaseName", () => {
  it("capitalizes across spaces, hyphens and slashes", () => {
    expect(titleCaseName("SEMI-FLUSH mount")).toBe("Semi-Flush Mount");
    expect(titleCaseName("wall/ceiling SCONCE")).toBe("Wall/Ceiling Sconce");
  });

  it("passes digit-containing tokens through verbatim (temp-base names)", () => {
    expect(titleCaseName("41KJ0808")).toBe("41KJ0808");
    expect(titleCaseName("PENDANT 41KJ0808")).toBe("Pendant 41KJ0808");
    expect(titleCaseName("Item 7B")).toBe("Item 7B");
  });
});

describe("titleFor — digit tokens survive the Schonbek name path", () => {
  it("a temp-base fallback name is not lowercased", () => {
    expect(
      titleFor({
        brand: "Schonbek",
        collection: "Beyond",
        name: "41KJ0808",
        productType: "Chandelier",
        modelBases: ["41KJ0808"],
      }),
    ).toBe("41KJ0808 | 410808 | Luxury Crystal Chandelier | Schonbek");
  });
});

describe("DESC_TITLE_RANGE", () => {
  it("stays tied to the shared SEO title rule (50-60)", () => {
    expect(DESC_TITLE_RANGE).toEqual(SEO_RULES.seo_title);
  });
  it("titleLengthOk brackets the range", () => {
    expect(titleLengthOk("x".repeat(49))).toBe(false);
    expect(titleLengthOk("x".repeat(50))).toBe(true);
    expect(titleLengthOk("x".repeat(60))).toBe(true);
    expect(titleLengthOk("x".repeat(61))).toBe(false);
  });
});
