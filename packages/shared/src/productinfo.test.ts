import { describe, expect, it } from "vitest";
import {
  NORMALIZERS,
  SEO_LIMITS,
  combineCcts,
  extractRawCct,
  isCctNoValue,
  normalizeBeam,
  normalizeCct,
  normalizeVoltage,
  toCsv,
  truncateAtWord,
  normalizeBrand,
  defaultSeoTitle,
  defaultOgImage,
} from "./productinfo.js";

describe("normalizeCct", () => {
  // The exact inconsistent variants called out in PRD §6.3.
  it("normalizes a bare number", () => {
    expect(normalizeCct("3000")).toEqual({
      ok: true,
      normalized: "3000K",
      kind: "single",
    });
  });

  it("normalizes lowercase k", () => {
    expect(normalizeCct("3000k")).toEqual({
      ok: true,
      normalized: "3000K",
      kind: "single",
    });
  });

  it("flags the 300k typo instead of guessing 3000K", () => {
    const r = normalizeCct("300k");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/plausible/);
  });

  it.each(["3000/5000k", "3000k/5000k"])(
    "normalizes selectable multi-CCT %s",
    (raw) => {
      expect(normalizeCct(raw)).toEqual({
        ok: true,
        normalized: "3000K/5000K",
        kind: "multi",
      });
    },
  );

  it.each(["3000-5000k", "3000k-5000k", "3000K to 5000K"])(
    "normalizes range/tunable %s with an en dash",
    (raw) => {
      expect(normalizeCct(raw)).toEqual({
        ok: true,
        normalized: "3000K–5000K",
        kind: "range",
      });
    },
  );

  it("handles uppercase, spaces, kelvin word, and unicode dashes", () => {
    expect(normalizeCct(" 2700 K ")).toMatchObject({ normalized: "2700K" });
    expect(normalizeCct("2700 Kelvin")).toMatchObject({ normalized: "2700K" });
    expect(normalizeCct("2700K–5000K")).toMatchObject({
      normalized: "2700K–5000K",
    });
  });

  it("strips thousands separators without mis-splitting on the comma", () => {
    expect(normalizeCct("2,700K")).toMatchObject({ normalized: "2700K" });
  });

  it("sorts and de-duplicates multi values", () => {
    expect(normalizeCct("5000k/3000k/4000k/3000k")).toMatchObject({
      normalized: "3000K/4000K/5000K",
      kind: "multi",
    });
    // multi collapsing to one distinct value is a single
    expect(normalizeCct("3000/3000k")).toMatchObject({
      normalized: "3000K",
      kind: "single",
    });
  });

  it("flags what it cannot confidently parse", () => {
    for (const raw of [
      "",
      "   ",
      "warm white",
      "tunable 2700-5000k", // prose mixed in
      "2700.5k", // non-integer
      "30000k", // out of range
      "5000-3000k", // descending range
      "3000-4000/5000k", // mixed separators
      null,
      undefined,
    ]) {
      const r = normalizeCct(raw as string | null | undefined);
      expect(r.ok, `expected flag for ${JSON.stringify(raw)}`).toBe(false);
    }
  });
});

describe("isCctNoValue", () => {
  it("recognizes explicit no-value markers", () => {
    for (const raw of ["N/A", "n/a", "NA", "none", "-", "", "  ", null, undefined]) {
      expect(isCctNoValue(raw), `expected no-value for ${JSON.stringify(raw)}`).toBe(true);
    }
  });
  it("does not treat real values as empty", () => {
    expect(isCctNoValue("3000K")).toBe(false);
    expect(isCctNoValue("Amber")).toBe(false);
  });
});

describe("combineCcts", () => {
  // Real formats observed in the WAC catalog's zcct_desc field.
  it("collapses identical variant values to a single", () => {
    expect(combineCcts(["3000K", "3000K", "N/A"])).toMatchObject({
      normalized: "3000K",
      kind: "single",
    });
  });

  it("combines distinct fixed values into a sorted multi", () => {
    expect(combineCcts(["3000K", "2700K", "3500K"])).toMatchObject({
      normalized: "2700K/3000K/3500K",
      kind: "multi",
    });
    // multi-value variants merge into the union
    expect(combineCcts(["2700K/3000K", "3500K"])).toMatchObject({
      normalized: "2700K/3000K/3500K",
      kind: "multi",
    });
  });

  it("keeps a consistent range", () => {
    expect(combineCcts(["1800K-4000K", "1800K-4000K"])).toMatchObject({
      normalized: "1800K–4000K",
      kind: "range",
    });
  });

  it("flags mixed ranges and fixed values", () => {
    const r = combineCcts(["1800K-4000K", "3000K"]);
    expect(r.ok).toBe(false);
  });

  it("flags when any variant is unparseable", () => {
    const r = combineCcts(["3000K", "Amber"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could not be parsed/);
  });

  it("flags descending-range typos like 3000K-1800K", () => {
    expect(combineCcts(["3000K-1800K"]).ok).toBe(false);
  });

  it("reports all-N/A as no values", () => {
    const r = combineCcts(["N/A", "N/A"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no CCT/);
  });
});

describe("extractRawCct", () => {
  it("finds CCT-ish keys heuristically", () => {
    expect(extractRawCct({ cct: "3000k" })).toBe("3000k");
    expect(extractRawCct({ color_temperature: 2700 })).toBe("2700");
    expect(extractRawCct({ product_cct: "3000/5000K" })).toBe("3000/5000K");
    expect(extractRawCct({ colour_temp: "4000" })).toBe("4000");
  });

  it("ignores unrelated keys and empty values", () => {
    expect(extractRawCct({ name: "Sconce", lumens: "500" })).toBeNull();
    expect(extractRawCct({ cct: "" })).toBeNull();
  });

  it("joins multiple sources and de-duplicates", () => {
    expect(extractRawCct({ cct: "3000K", color_temp: "3000K" })).toBe("3000K");
    expect(extractRawCct({ cct: ["2700K", "3000K"] })).toBe("2700K/3000K");
  });

  it("honors a pinned preferred key", () => {
    expect(extractRawCct({ weird_field: "3500", cct: "x" }, "weird_field")).toBe(
      "3500",
    );
  });
});

describe("normalizeBeam", () => {
  // Real formats observed in zbeam_descript.
  it("canonicalizes case and abbreviations", () => {
    expect(normalizeBeam("Flood")).toMatchObject({ normalized: "Flood" });
    expect(normalizeBeam("ASYM")).toMatchObject({ normalized: "Asymmetrical" });
    expect(normalizeBeam("Asym")).toMatchObject({ normalized: "Asymmetrical" });
    expect(normalizeBeam("asymmetrical")).toMatchObject({ normalized: "Asymmetrical" });
    expect(normalizeBeam("Ultra Narrow")).toMatchObject({ normalized: "Ultra Narrow" });
  });

  it("handles comma multis with de-duplication", () => {
    expect(normalizeBeam("Narrow, Flood, Wide")).toMatchObject({
      normalized: "Narrow/Flood/Wide",
      kind: "multi",
    });
    expect(normalizeBeam("Asym, ASYM")).toMatchObject({ normalized: "Asymmetrical", kind: "single" });
  });

  it("flags unknown vocabulary like 'S to F'", () => {
    expect(normalizeBeam("S to F").ok).toBe(false);
    expect(normalizeBeam("").ok).toBe(false);
  });
});

describe("normalizeVoltage", () => {
  // Real formats observed in zvoltin.
  it("canonicalizes range spacing/unit drift to one format", () => {
    for (const raw of ["120-277 VAC", "120-277V", "120 -277 VAC"]) {
      expect(normalizeVoltage(raw)).toMatchObject({ normalized: "120-277 VAC" });
    }
  });

  it("handles singles, DC, and dual-mode units", () => {
    expect(normalizeVoltage("120 VAC")).toMatchObject({ normalized: "120 VAC" });
    expect(normalizeVoltage("48 VDC")).toMatchObject({ normalized: "48 VDC" });
    expect(normalizeVoltage("24 VAC/DC")).toMatchObject({ normalized: "24 VAC/VDC" });
    expect(normalizeVoltage("9-15 VAC")).toMatchObject({ normalized: "9-15 VAC" });
  });

  it("flags ambiguous low-voltage bare V and non-voltage values", () => {
    expect(normalizeVoltage("24V").ok).toBe(false); // AC or DC? unknowable
    expect(normalizeVoltage("USB-C").ok).toBe(false);
    expect(normalizeVoltage("3V (Requires 2 AAA batteries)").ok).toBe(false);
    expect(normalizeVoltage("277-120 VAC").ok).toBe(false); // descending
  });
});

describe("NORMALIZERS registry roll-ups", () => {
  it("unions beam values across variants", () => {
    expect(NORMALIZERS.beam.combine(["Spot", "Flood", "Spot"])).toMatchObject({
      normalized: "Spot/Flood",
      kind: "multi",
    });
  });

  it("flags products whose variants disagree on voltage", () => {
    const r = NORMALIZERS.voltage.combine(["120-277 VAC", "48 VDC"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/differ/);
  });

  it("agreeing voltages roll up cleanly", () => {
    expect(NORMALIZERS.voltage.combine(["120-277 VAC", "120-277V", "N/A"])).toMatchObject({
      normalized: "120-277 VAC",
    });
  });
});

describe("truncateAtWord", () => {
  it("returns short strings untouched", () => {
    expect(truncateAtWord("Modern sconce", 60)).toBe("Modern sconce");
  });

  it("cuts on a word boundary within the limit", () => {
    const out = truncateAtWord(
      "A beautifully crafted aluminum wall sconce for modern exteriors",
      40,
    );
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith(" ")).toBe(false);
    expect(out).toBe("A beautifully crafted aluminum wall");
  });

  it("respects the configured SEO limits", () => {
    const long = "word ".repeat(100);
    expect(truncateAtWord(long, SEO_LIMITS.seo_title).length).toBeLessThanOrEqual(
      SEO_LIMITS.seo_title,
    );
    expect(
      truncateAtWord(long, SEO_LIMITS.seo_meta_description).length,
    ).toBeLessThanOrEqual(SEO_LIMITS.seo_meta_description);
  });
});

describe("toCsv", () => {
  it("escapes quotes, commas, and newlines", () => {
    const csv = toCsv(
      ["sku", "value"],
      [
        ["WS-123", 'He said "hi", twice'],
        ["WS-456", "line1\nline2"],
        ["WS-789", null],
      ],
    );
    expect(csv).toBe(
      'sku,value\r\nWS-123,"He said ""hi"", twice"\r\nWS-456,"line1\nline2"\r\nWS-789,\r\n',
    );
  });
});

describe("normalizeBrand", () => {
  it("maps catalog brand values to canonical brands", () => {
    expect(normalizeBrand("WAC")).toBe("WAC Lighting");
    expect(normalizeBrand("wac lighting")).toBe("WAC Lighting");
    expect(normalizeBrand("WAC Landscape")).toBe("WAC Lighting");
    expect(normalizeBrand("WAC Architectural")).toBe("WAC Architectural");
    expect(normalizeBrand("Modern Forms")).toBe("Modern Forms");
    expect(normalizeBrand("Modern Forms Fans")).toBe("Modern Forms");
    expect(normalizeBrand("Schonbek")).toBe("Schonbek");
    expect(normalizeBrand("Aispire")).toBe("Aispire");
  });

  it("folds sub-brands into their parent", () => {
    expect(normalizeBrand("Ventrix")).toBe("WAC Lighting");
    expect(normalizeBrand("Limited")).toBe("WAC Lighting");
    expect(normalizeBrand("Dwel")).toBe("WAC Lighting");
    expect(normalizeBrand("dweLED")).toBe("WAC Lighting");
    expect(normalizeBrand("Beyond")).toBe("Schonbek");
    expect(normalizeBrand("Signature")).toBe("Schonbek");
    expect(normalizeBrand("Forever")).toBe("Schonbek");
  });

  it("detects unambiguous sub-brand tokens in the product name only", () => {
    expect(normalizeBrand(null, "dweLED Puck 5in")).toBe("WAC Lighting");
    expect(normalizeBrand("", "Ventrix Linear 4ft")).toBe("WAC Lighting");
    // Generic words never match from a name — too ambiguous.
    expect(normalizeBrand(null, "Beyond Limited Edition Sconce")).toBe(null);
  });

  it("returns null for unknown brands instead of guessing", () => {
    expect(normalizeBrand("Acme Lighting")).toBe(null);
    expect(normalizeBrand(null)).toBe(null);
  });
});

describe("defaultSeoTitle", () => {
  it("follows {name} – {category} | {brand}", () => {
    expect(
      defaultSeoTitle({ name: "Calliope 24in Pendant", category: "Pendants", brand: "WAC" }),
    ).toBe("Calliope 24in Pendant – Pendants | WAC Lighting");
  });

  it("drops missing segments cleanly", () => {
    expect(defaultSeoTitle({ name: "Calliope", brand: "Schonbek" })).toBe(
      "Calliope | Schonbek",
    );
    expect(defaultSeoTitle({ name: "Calliope", category: "Pendants" })).toBe(
      "Calliope – Pendants",
    );
    expect(defaultSeoTitle({ name: "Calliope" })).toBe("Calliope");
  });
});

describe("defaultOgImage", () => {
  it("prefers the image numbered 1, else the first", () => {
    expect(
      defaultOgImage([
        "https://cdn.x.com/p/WS-123-3.jpg",
        "https://cdn.x.com/p/WS-123-1.jpg",
        "https://cdn.x.com/p/WS-123-2.jpg",
      ]),
    ).toBe("https://cdn.x.com/p/WS-123-1.jpg");
    expect(defaultOgImage(["https://cdn.x.com/p/WS-9_01.png?v=2", "https://cdn.x.com/b.png"])).toBe(
      "https://cdn.x.com/p/WS-9_01.png?v=2",
    );
    expect(defaultOgImage(["https://cdn.x.com/hero.jpg"])).toBe("https://cdn.x.com/hero.jpg");
    expect(defaultOgImage([])).toBe(null);
  });

  it("does not treat trailing digits like 11 as image 1", () => {
    expect(
      defaultOgImage(["https://cdn.x.com/p/WS-123-11.jpg", "https://cdn.x.com/p/WS-123-4.jpg"]),
    ).toBe("https://cdn.x.com/p/WS-123-11.jpg"); // falls back to first, no -1 match
  });
});
