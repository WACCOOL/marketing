import { describe, expect, it } from "vitest";
import {
  buildSupplementOverlay,
  clearFeatureOverlay,
  extractModels,
  levenshtein,
  matchSupplementUnits,
  overlayFeatures,
  parseMfPdfPages,
  parsePptxSlides,
  type SupplementGroup,
} from "./matchSupplement.js";
import { mapAnchorsToGroups } from "./anchorMap.js";
import type { GroupRowSpan } from "./parseMaster.js";

/**
 * ALL fixtures here are synthetic (the repo is public — real deck/pdf data
 * must never be committed). Names and model numbers are invented lookalikes
 * that reproduce the structural quirks of the real sources.
 */

// ---------------------------------------------------------------------------
// model token extraction
// ---------------------------------------------------------------------------

describe("extractModels", () => {
  it("expands compact ranges and keeps finish suffixes", () => {
    expect(extractModels("Pendant | WSW440918/24-BK | ZORVIT")).toEqual([
      "WSW440918-BK",
      "WSW440924-BK",
    ]);
  });

  it("splits slash-joined full models and multi-suffix chains", () => {
    expect(
      extractModels("FM740621/FM740628-WT/GO and WS925717-TWA-XX"),
    ).toEqual(["FM740621", "FM740628-WT/GO", "WS925717-TWA-XX"]);
  });

  it("keeps a trailing R variant and 2-letter prefixes with 5 digits", () => {
    expect(extractModels("PD918603R plus BL99808-XX")).toEqual([
      "PD918603R",
      "BL99808-XX",
    ]);
  });

  it("ignores plain words, CCT lists and dates", () => {
    expect(
      extractModels("4CCT (2700K/3000K/3500K/4000K) 07.13.26 USB-C WAC HOME"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// pptx lane
// ---------------------------------------------------------------------------

describe("parsePptxSlides", () => {
  it("skips section slides (no models) and parses product slides", () => {
    const { units, skipped } = parsePptxSlides([
      { index: 1, paragraphs: ["2027 INTRODUCTIONS"], imageIds: [] },
      { index: 2, paragraphs: ["OUTDOOR"], imageIds: [] },
      {
        index: 3,
        paragraphs: [
          "Outdoor Sconce",
          "Hammered Texture",
          "4CCT",
          "BK",
          "26inches",
          "WSW440926-BK ",
          "ZORVIT",
        ],
        imageIds: ["media/image9.png"],
      },
    ]);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toContain("slide 1");
    expect(units).toHaveLength(1);
    const u = units[0]!;
    expect(u.ref).toBe("slide 3");
    expect(u.name).toBe("ZORVIT");
    expect(u.modelBases).toEqual(["WSW440926"]);
    // finish code + pure size dropped (structured data); features kept
    expect(u.bullets).toEqual(["Outdoor Sconce", "Hammered Texture", "4CCT"]);
    expect(u.imageIds).toEqual(["media/image9.png"]);
  });

  it("drops pure size segments but keeps descriptive ones", () => {
    const { units } = parsePptxSlides([
      {
        index: 8,
        paragraphs: [
          "Flush Mount",
          "18/24 INCHES",
          "10 & 15 Inches",
          "9inches, 12inches, 16inches",
          "3 Light 6/9/14inch",
          "Dark Sky Friendly",
          "FM740628-WT",
          "VOLTZ",
        ],
        imageIds: [],
      },
    ]);
    expect(units[0]!.bullets).toEqual([
      "Flush Mount",
      "3 Light 6/9/14inch",
      "Dark Sky Friendly",
    ]);
  });

  it("finds a name that shares a paragraph with the model", () => {
    const { units } = parsePptxSlides([
      {
        index: 4,
        paragraphs: ["Outdoor Pendant", "3000K", "WSW440916/24-BK KAGEY"],
        imageIds: [],
      },
    ]);
    expect(units[0]!.name).toBe("KAGEY");
    expect(units[0]!.modelBases).toEqual(["WSW440916", "WSW440924"]);
  });

  it("ignores deck furniture when picking the name and bullets", () => {
    const { units } = parsePptxSlides([
      {
        index: 5,
        paragraphs: [
          "Pendant",
          "Faux Alabaster",
          "AB & BK",
          "PD915746-XX ",
          "KABUNO",
          "Inspiration",
          "Big Player",
        ],
        imageIds: [],
      },
    ]);
    expect(units[0]!.name).toBe("KABUNO");
    expect(units[0]!.bullets).toEqual(["Pendant", "Faux Alabaster"]);
  });

  it("keeps a model-less product slide as a name-only unit", () => {
    const { units, skipped } = parsePptxSlides([
      {
        index: 9,
        paragraphs: [
          "Task Light",
          "Rotatable",
          "Touch Button",
          "PENDING",
          "ORBLET",
          "Inspiration",
        ],
        imageIds: [],
      },
    ]);
    expect(skipped).toHaveLength(0);
    expect(units).toHaveLength(1);
    expect(units[0]!.name).toBe("ORBLET");
    expect(units[0]!.modelBases).toEqual([]);
    expect(units[0]!.bullets).toEqual(["Task Light", "Rotatable", "Touch Button"]);
  });

  it("drops compound finish/CCT/size crumb segments from slide bullets", () => {
    const { units } = parsePptxSlides([
      {
        index: 10,
        paragraphs: [
          "Outdoor Sconce",
          "3000K – BK",
          "AB Indoor",
          "BK Indoor/Outdoor",
          "AB & BN Finish",
          "4CCT",
          "Dark Sky",
          "BK with AB ribbed collar",
          "WSW885705-BK",
          "VOLTZ",
        ],
        imageIds: [],
      },
    ]);
    expect(units[0]!.bullets).toEqual([
      "Outdoor Sconce",
      "4CCT", // single token stays
      "Dark Sky",
      "BK with AB ribbed collar", // descriptive despite the codes
    ]);
  });

  it("accepts mixed-case and multi-word names", () => {
    const { units } = parsePptxSlides([
      {
        index: 6,
        paragraphs: ["Task Light", "BL99808-XX", "LoyRD"],
        imageIds: [],
      },
      {
        index: 7,
        paragraphs: ["Outdoor Sconce", "WSW885705-BK", "SHORT HOP"],
        imageIds: [],
      },
    ]);
    expect(units[0]!.name).toBe("LoyRD");
    expect(units[1]!.name).toBe("SHORT HOP");
  });
});

// ---------------------------------------------------------------------------
// MF pdf lane
// ---------------------------------------------------------------------------

describe("parseMfPdfPages", () => {
  it("parses a product page: models, Name:, wrapped bullets", () => {
    const { units } = parseMfPdfPages([
      {
        index: 3,
        lines: [
          "Modern Forms. A WAC Group Brand.",
          "PDW870518,",
          "PMW870518, WSW870518",
          "& WSW870524",
          "Name: GRABBLE",
          "- Outdoor Pendant, Post Mount & Sconce",
          "- Wet Rated",
          "- Glossy Opal Glass with a very long",
          "wrapped continuation line",
          "- BK Finish",
        ],
      },
    ]);
    expect(units).toHaveLength(1);
    const u = units[0]!;
    expect(u.name).toBe("GRABBLE");
    expect(u.modelBases).toEqual([
      "PDW870518",
      "PMW870518",
      "WSW870518",
      "WSW870524",
    ]);
    // "BK Finish" is a spec crumb (structured data) and is dropped.
    expect(u.bullets).toEqual([
      "Outdoor Pendant, Post Mount & Sconce",
      "Wet Rated",
      "Glossy Opal Glass with a very long wrapped continuation line",
    ]);
  });

  it("drops compound spec-crumb bullets, keeps descriptive ones", () => {
    const { units } = parseMfPdfPages([
      {
        index: 6,
        lines: [
          "WS925717",
          "Name: VOLTZ",
          "- Indoor Sconce",
          "- 18” Size",
          "- VB & PN Finish",
          "- 3000K",
          "- 4CCT (2700K/3000K/3500K/4000K)",
          "- Rotatable 350 degrees",
          "- Glossy Opal Glass",
        ],
      },
    ]);
    expect(units[0]!.bullets).toEqual([
      "Indoor Sconce",
      "3000K", // single token stays informative
      "Rotatable 350 degrees",
      "Glossy Opal Glass",
    ]);
  });

  it("reads a name from the following line when Name: ends a line", () => {
    const { units } = parseMfPdfPages([
      {
        index: 4,
        lines: ["WSW860212 & ", "WSW860218 Name:", "TURBINEE", "- Outdoor Wall Sconce"],
      },
    ]);
    expect(units[0]!.name).toBe("TURBINEE");
  });

  it("falls back to the Extension name when there is no Name:", () => {
    const { units } = parseMfPdfPages([
      {
        index: 11,
        lines: ["WS650928", "- Ballenna Extension", "- Indoor Sconce", "- Damp Rated"],
      },
    ]);
    expect(units[0]!.name).toBe("Ballenna");
    expect(units[0]!.bullets[0]).toBe("Ballenna Extension");
  });

  it("skips section pages and collection summary pages", () => {
    const { units, skipped } = parseMfPdfPages([
      { index: 2, lines: ["OUTDOOR SCONCES"] },
      {
        index: 45,
        lines: [
          "“GRABBLE” COLLECTION",
          "[ VB & PN finish // Etched Opal glass ]",
          "WS840218",
          "Indoor Sconce",
          "WS840228",
          "Bath Vanity",
        ],
      },
    ]);
    expect(units).toHaveLength(0);
    expect(skipped).toHaveLength(2);
    expect(skipped[1]).toContain("collection summary");
  });
});

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

const GROUPS: SupplementGroup[] = [
  { content_key: "mf:grable", name: "Grable", model_bases: ["WSW870518", "WSW870524", "PDW870518", "PMW870518"] },
  { content_key: "mf:tovler", name: "Tovler", model_bases: ["PD551418"] },
  { content_key: "mf:cazbie:wsw660312", name: "Cazbie", model_bases: ["WSW660312"] },
  { content_key: "mf:cazbie:wsw660315", name: "Cazbie", model_bases: ["WSW660315"] },
  { content_key: "mf:shellvana", name: "Shellvana", model_bases: ["WS624810"] },
];

function unit(over: Partial<{ name: string | null; modelBases: string[] }>) {
  return { name: null as string | null, modelBases: [] as string[], ...over };
}

describe("matchSupplementUnits", () => {
  it("matches by unique model-base intersection across several bases", () => {
    const [m] = matchSupplementUnits(
      [unit({ name: "GRABBLE", modelBases: ["PMW870518", "WSW870524"] })],
      GROUPS,
    );
    expect(m!.content_keys).toEqual(["mf:grable"]);
    expect(m!.via).toBe("model");
  });

  it("leaves a multi-hit across DIFFERENT products unmatched (ambiguous)", () => {
    const [m] = matchSupplementUnits(
      [unit({ name: null, modelBases: ["PD551418", "WS624810"] })],
      GROUPS,
    );
    expect(m!.content_keys).toEqual([]);
    expect(m!.reason).toContain("ambiguous");
  });

  it("matches every sibling when a family page spans same-named groups", () => {
    // A family page lists sconce + pendant bases; the master splits them
    // into sibling groups that share the name.
    const [m] = matchSupplementUnits(
      [unit({ name: "CAZBIE", modelBases: ["WSW660312", "WSW660315"] })],
      GROUPS,
    );
    expect(m!.content_keys).toEqual(["mf:cazbie:wsw660312", "mf:cazbie:wsw660315"]);
    expect(m!.via).toBe("model");
  });

  it("keeps the sibling rule out when the unit name disagrees", () => {
    const [m] = matchSupplementUnits(
      [unit({ name: "QUOZZLE", modelBases: ["WSW660312", "WSW660315"] })],
      GROUPS,
    );
    expect(m!.content_keys).toEqual([]);
    expect(m!.reason).toContain("ambiguous");
  });

  it("falls back to case-folded exact name match", () => {
    const [m] = matchSupplementUnits(
      [unit({ name: "TOVLER", modelBases: ["ZZ999999"] })],
      GROUPS,
    );
    expect(m!.content_keys).toEqual(["mf:tovler"]);
    expect(m!.via).toBe("name");
  });

  it("matches deck spelling drift via Levenshtein <= 2", () => {
    // Deck doubles a letter: GRABBLE vs master "Grable".
    const [m] = matchSupplementUnits([unit({ name: "GRABBLE" })], GROUPS);
    expect(m!.content_keys).toEqual(["mf:grable"]);
    expect(m!.via).toBe("name");
  });

  it("matches long-name drift via shared prefix >= 5", () => {
    const [m] = matchSupplementUnits([unit({ name: "SHELLVANNA" })], GROUPS);
    expect(m!.content_keys).toEqual(["mf:shellvana"]);
  });

  it("treats a duplicated master name as ambiguous", () => {
    const [m] = matchSupplementUnits([unit({ name: "Cazbie" })], GROUPS);
    expect(m!.content_keys).toEqual([]);
    expect(m!.reason).toContain("ambiguous");
  });

  it("reports units with no match at all", () => {
    const [m] = matchSupplementUnits([unit({ name: "QUOZZLE" })], GROUPS);
    expect(m!.content_keys).toEqual([]);
    expect(m!.reason).toContain("QUOZZLE");
  });
});

describe("levenshtein", () => {
  it("computes edit distance", () => {
    expect(levenshtein("grabble", "grable")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// overlay
// ---------------------------------------------------------------------------

describe("overlay", () => {
  it("merges several units of one product in order, deduplicated", () => {
    const overlay = buildSupplementOverlay([
      {
        content_key: "mf:grable",
        ref: "slide 4",
        bullets: ["Wet Rated", "Opal Glass"],
        imageKeys: ["descriptions/img/dweled_pptx/aa11.jpg"],
      },
      {
        content_key: "mf:grable",
        ref: "slide 5",
        bullets: ["Opal Glass", "Pendant Available"],
        imageKeys: ["descriptions/img/dweled_pptx/bb22.jpg"],
      },
    ]);
    const o = overlay.get("mf:grable")!;
    expect(o.bullets).toEqual(["Wet Rated", "Opal Glass", "Pendant Available"]);
    expect(o.imageKeys).toEqual([
      "descriptions/img/dweled_pptx/aa11.jpg",
      "descriptions/img/dweled_pptx/bb22.jpg",
    ]);
    expect(o.unitRefs).toEqual(["slide 4", "slide 5"]);
  });

  it("keeps images for a bullet-less unit without implying a feature wipe", () => {
    // Consumers must skip the feature overlay when bullets are empty (the
    // API guards this); the entry still carries the unit's images.
    const overlay = buildSupplementOverlay([
      {
        content_key: "mf:tovler",
        ref: "slide 9",
        bullets: [],
        imageKeys: ["descriptions/img/dweled_pptx/cc33.jpg"],
      },
    ]);
    const o = overlay.get("mf:tovler")!;
    expect(o.bullets).toEqual([]);
    expect(o.imageKeys).toEqual(["descriptions/img/dweled_pptx/cc33.jpg"]);
  });

  it("replaces features and preserves sheet originals, idempotently", () => {
    const product = {
      features: ["Sheet feature A", "Sheet feature B"],
      attributes: { hierarchy: "Pendants" } as Record<string, unknown>,
    };
    const once = overlayFeatures(product, ["Deck bullet 1"]);
    expect(once.features).toEqual(["Deck bullet 1"]);
    expect(once.attributes["sheetFeatures"]).toEqual([
      "Sheet feature A",
      "Sheet feature B",
    ]);
    // Re-overlay must not mistake deck bullets for sheet features.
    const twice = overlayFeatures(once, ["Deck bullet 2"]);
    expect(twice.features).toEqual(["Deck bullet 2"]);
    expect(twice.attributes["sheetFeatures"]).toEqual([
      "Sheet feature A",
      "Sheet feature B",
    ]);
    // Clearing restores the sheet features and drops the marker.
    const cleared = clearFeatureOverlay(twice);
    expect(cleared.features).toEqual(["Sheet feature A", "Sheet feature B"]);
    expect("sheetFeatures" in cleared.attributes).toBe(false);
    expect(cleared.attributes["hierarchy"]).toBe("Pendants");
  });
});

// ---------------------------------------------------------------------------
// anchor → group mapping
// ---------------------------------------------------------------------------

describe("mapAnchorsToGroups", () => {
  const spans: GroupRowSpan[] = [
    { content_key: "dweled:zalta", sheet: "Master Sheet", startRow: 4, endRow: 9 },
    { content_key: "dweled:kiglo", sheet: "Master Sheet", startRow: 10, endRow: 14 },
  ];

  it("assigns anchors inside a span and rejects the rest", () => {
    const out = mapAnchorsToGroups(
      [
        { sheet: "Master Sheet", row: 5, col: 1, imageId: "media/image1.png" },
        { sheet: "Master Sheet", row: 10, col: 1, imageId: "media/image2.png" },
        // header art above the data rows
        { sheet: "Master Sheet", row: 0, col: 0, imageId: "media/logo.png" },
        // wrong sheet entirely
        { sheet: "Other", row: 5, col: 1, imageId: "media/image3.png" },
      ],
      spans,
    );
    expect(out.map((a) => a.content_key)).toEqual([
      "dweled:zalta",
      "dweled:kiglo",
      null,
      null,
    ]);
  });
});
