import { describe, expect, it } from "vitest";
import {
  BRAND_NORMALIZATION,
  DOMAIN,
  MODERN_FORMS_SPEC_TEMPLATES,
  SCRAPEABLE,
  SKIP_SLUGS,
  canonicalBrand,
  canonicalPdpUrl,
  extractSpecSheet,
  firstSlugFromHtml,
  modernFormsPpid,
  modernFormsSpecUrl,
  schonbekSpecSheet,
} from "./taxonomy.js";

describe("canonicalBrand", () => {
  it("maps every raw Sales Layer code to its canonical brand", () => {
    expect(canonicalBrand("WAC")).toBe("WAC Lighting");
    expect(canonicalBrand("DWEL")).toBe("WAC Lighting");
    expect(canonicalBrand("MOF")).toBe("Modern Forms");
    expect(canonicalBrand("MFF")).toBe("Modern Forms");
    expect(canonicalBrand("SIGNATURE")).toBe("Schonbek");
    expect(canonicalBrand("BEYOND")).toBe("Schonbek");
    expect(canonicalBrand("FOREVER")).toBe("Schonbek");
    expect(canonicalBrand("AISPIRE")).toBe("AiSpire");
  });

  it("is case/whitespace-insensitive and null-safe", () => {
    expect(canonicalBrand(" mof ")).toBe("Modern Forms");
    expect(canonicalBrand("Signature")).toBe("Schonbek");
    expect(canonicalBrand("UNKNOWN")).toBeNull();
    expect(canonicalBrand(null)).toBeNull();
    expect(canonicalBrand(undefined)).toBeNull();
    expect(canonicalBrand("")).toBeNull();
  });

  it("every normalized brand has a domain", () => {
    for (const brand of new Set(Object.values(BRAND_NORMALIZATION))) {
      expect(DOMAIN[brand], `${brand} missing from DOMAIN`).toBeTruthy();
    }
  });
});

describe("SCRAPEABLE", () => {
  it("excludes Schonbek (search-only) and includes the other three", () => {
    expect(SCRAPEABLE.has("Schonbek")).toBe(false);
    expect(SCRAPEABLE.has("WAC Lighting")).toBe(true);
    expect(SCRAPEABLE.has("Modern Forms")).toBe(true);
    expect(SCRAPEABLE.has("AiSpire")).toBe(true);
  });
});

describe("canonicalPdpUrl", () => {
  it("builds the canonical PDP URL for a slug", () => {
    expect(canonicalPdpUrl("WAC Lighting", "j2-track")).toBe(
      "https://waclighting.com/product/j2-track/",
    );
    expect(canonicalPdpUrl("Schonbek", "arlington-12")).toBe(
      "https://schonbek.com/product/arlington-12/",
    );
  });

  it("returns null for a null slug or unknown brand", () => {
    expect(canonicalPdpUrl("WAC Lighting", null)).toBeNull();
    expect(canonicalPdpUrl("Not A Brand", "slug")).toBeNull();
  });
});

describe("firstSlugFromHtml", () => {
  it("returns the first non-junk product slug", () => {
    const html =
      '<a href="/product/all/">all</a> <a href="/product/fr-w1801/">hit</a> <a href="/product/other-1/">x</a>';
    expect(firstSlugFromHtml(html)).toBe("fr-w1801");
  });

  it("skips every SKIP_SLUGS entry", () => {
    const junk = [...SKIP_SLUGS].map((s) => `<a href="/product/${s}/">${s}</a>`).join("");
    expect(firstSlugFromHtml(junk)).toBeNull();
  });

  it("is stateless across calls despite the global regex", () => {
    const html = '<a href="/product/abc-123/">x</a>';
    expect(firstSlugFromHtml(html)).toBe("abc-123");
    expect(firstSlugFromHtml(html)).toBe("abc-123");
  });

  it("handles null html", () => {
    expect(firstSlugFromHtml(null)).toBeNull();
  });
});

describe("extractSpecSheet", () => {
  it("WAC Lighting: builds the dispatcher URL on the PDP slug", () => {
    const html = '<a href="?download=specs12">Spec Sheet</a>';
    expect(extractSpecSheet("WAC Lighting", html, "j2-track")).toBe(
      "https://waclighting.com/product/j2-track/?download=specs12",
    );
  });

  it("WAC Lighting: null without a slug even when the dispatcher is present", () => {
    expect(extractSpecSheet("WAC Lighting", '<a href="?download=specs5">x</a>', null)).toBeNull();
  });

  it("AiSpire: prefers the S3 _SPSHT.pdf, falls back to _INSSHT.pdf", () => {
    const both =
      '<a href="https://aispire.s3.amazonaws.com/docs/A2RU-447_SPSHT.pdf">s</a>' +
      '<a href="https://aispire.s3.amazonaws.com/docs/A2RU-447_INSSHT.pdf">i</a>';
    expect(extractSpecSheet("AiSpire", both, "a2ru")).toBe(
      "https://aispire.s3.amazonaws.com/docs/A2RU-447_SPSHT.pdf",
    );
    const instOnly = '<a href="https://aispire.s3.amazonaws.com/docs/TRIM-1_INSSHT.pdf">i</a>';
    expect(extractSpecSheet("AiSpire", instOnly, "trim-1")).toBe(
      "https://aispire.s3.amazonaws.com/docs/TRIM-1_INSSHT.pdf",
    );
  });

  it("other brands and null html return null", () => {
    expect(extractSpecSheet("Modern Forms", "<html/>", "slug")).toBeNull();
    expect(extractSpecSheet("Schonbek", "<html/>", "slug")).toBeNull();
    expect(extractSpecSheet("WAC Lighting", null, "slug")).toBeNull();
  });
});

describe("Modern Forms spec helpers", () => {
  it("extracts the data-ppid", () => {
    expect(modernFormsPpid('<div data-ppid="8817">')).toBe("8817");
    expect(modernFormsPpid("<div>")).toBeNull();
    expect(modernFormsPpid(null)).toBeNull();
  });

  it("builds the dynamic-specsheet URL", () => {
    expect(modernFormsSpecUrl("8817", 5)).toBe(
      "https://modernforms.com/dynamic-specsheet/?download=specs5&ppid=8817",
    );
  });

  it("probes specs5 first (the ~96% fast path)", () => {
    expect(MODERN_FORMS_SPEC_TEMPLATES[0]).toBe(5);
    expect(new Set(MODERN_FORMS_SPEC_TEMPLATES).size).toBe(MODERN_FORMS_SPEC_TEMPLATES.length);
  });
});

describe("schonbekSpecSheet", () => {
  it("maps each raw sub-brand to its PHP template", () => {
    expect(schonbekSpecSheet("SIGNATURE", "4324")).toBe(
      "https://schonbek.com/downloads/specsheet/signatureld.php?ppid=4324",
    );
    expect(schonbekSpecSheet("beyond", "9")).toBe(
      "https://schonbek.com/downloads/specsheet/led-beyond1.php?ppid=9",
    );
    expect(schonbekSpecSheet("Forever", "77")).toBe(
      "https://schonbek.com/downloads/specsheet/forever.php?ppid=77",
    );
  });

  it("returns null for unknown or missing sub-brand", () => {
    expect(schonbekSpecSheet("WAC", "1")).toBeNull();
    expect(schonbekSpecSheet(null, "1")).toBeNull();
    expect(schonbekSpecSheet(undefined, "1")).toBeNull();
  });
});
