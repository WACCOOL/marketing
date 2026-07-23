import { describe, expect, it } from "vitest";
import { ANTI_FORMULAIC_RULE } from "./voiceDefaults.js";
import {
  DESC_META_RANGE,
  REFERENCE_BLOCK_LABEL,
  STRUCTURE_SEEDS,
  buildDescriptionPrompt,
  buildFactSheet,
  buildMetaPrompt,
  firstSentence,
  structureSeed,
  type PromptProduct,
} from "./prompts.js";

// All product-shaped inputs are SYNTHETIC (public repo).

const fullProduct: PromptProduct = {
  name: "Fictona",
  brand: "WAC Lighting",
  collection: "Dweled",
  year: 2027,
  family: "Fictona Family",
  product_type: "Pendant",
  diffuser_type: "Etched Glass",
  finishes: ["Aged Brass", "Matte Black"],
  sizes: [
    { length: "26", width: "5", height: "7" },
    { length: "32", width: "5", height: "7" },
  ],
  cct: ["2700K", "3000K"],
  features: ["Dimmable to 5%", "Field-adjustable cable"],
  model_numbers: ["ZZ12345-BK"],
  attributes: {
    romance: "A quiet arc of light for the entry.",
    variants: [
      { model: "ZZ12345-BK", finish: "Matte Black", cct: "3000K", size: "26" },
      { model: "ZZ12345-AB", finish: "Aged Brass", cct: null, size: null },
    ],
    sheet: { Lumens: "1200", Wattage: "14W" },
  },
};

const profile = {
  prompt: "Write 75-word catalog copy for this product.",
  voice_guidance: "Warm, inviting, design-forward but approachable.",
};

describe("structureSeed", () => {
  it("has at least 5 distinct strategies", () => {
    expect(STRUCTURE_SEEDS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(STRUCTURE_SEEDS).size).toBe(STRUCTURE_SEEDS.length);
  });

  it("rotates through every seed then wraps", () => {
    const n = STRUCTURE_SEEDS.length;
    const first = Array.from({ length: n }, (_, i) => structureSeed(i));
    expect(new Set(first).size).toBe(n);
    expect(structureSeed(n)).toBe(structureSeed(0));
    expect(structureSeed(n + 2)).toBe(structureSeed(2));
  });

  it("is negative-safe", () => {
    expect(STRUCTURE_SEEDS).toContain(structureSeed(-1));
  });
});

describe("firstSentence", () => {
  it("takes the first terminated sentence", () => {
    expect(firstSentence("A quiet arc of light. It floats over the table.")).toBe(
      "A quiet arc of light.",
    );
  });
  it("falls back to the whole text without terminal punctuation", () => {
    expect(firstSentence("  no punctuation here  ")).toBe("no punctuation here");
  });
  it("does not split on a decimal point", () => {
    expect(firstSentence("Spans 26.5 inches of shelf. More.")).toBe(
      "Spans 26.5 inches of shelf.",
    );
  });
  it("caps at 200 characters", () => {
    expect(firstSentence(`${"x".repeat(400)}.`).length).toBeLessThanOrEqual(200);
  });
});

describe("buildFactSheet — assembly completeness", () => {
  it("includes every provided fact", () => {
    const sheet = buildFactSheet(fullProduct);
    for (const expected of [
      "Fictona",
      "WAC Lighting",
      "Dweled",
      "2027",
      "Fictona Family",
      "Pendant",
      "Etched Glass",
      "Aged Brass",
      "Matte Black",
      "26 x 5 x 7",
      "32 x 5 x 7",
      "2700K",
      "3000K",
      "Dimmable to 5%",
      "Field-adjustable cable",
      "A quiet arc of light for the entry.",
      "Lumens: 1200",
      "Wattage: 14W",
      "ZZ12345-BK",
      "ZZ12345-AB",
      "finish Matte Black",
    ]) {
      expect(sheet).toContain(expected);
    }
  });

  it("omits absent fields instead of printing empty labels", () => {
    const sheet = buildFactSheet({
      name: "Beamlet",
      brand: "Aispire",
      collection: "Core",
      year: 2027,
      finishes: [],
      sizes: [],
      cct: [],
      features: [],
    });
    expect(sheet).toContain("Beamlet");
    expect(sheet).not.toContain("Finishes");
    expect(sheet).not.toContain("Diffuser");
    expect(sheet).not.toContain("Features:");
    expect(sheet).not.toContain("Variants");
  });

  it("falls back to bare model numbers when variants are absent", () => {
    const sheet = buildFactSheet({ ...fullProduct, attributes: {} });
    expect(sheet).toContain("Model numbers: ZZ12345-BK");
  });
});

describe("buildDescriptionPrompt", () => {
  const built = buildDescriptionPrompt({
    profile,
    product: fullProduct,
    referenceCopy: [{ name: "Glowline", copy: "Soft light for quiet rooms." }],
    avoidOpenings: ["A quiet arc of light.", "Suspended from a slim cable."],
    structureSeed: structureSeed(2),
  });
  const systemText = built.system.map((b) => b.text).join("\n\n");

  it("system = voice guidance, labeled references, anti-formulaic rules", () => {
    expect(built.system).toHaveLength(3);
    expect(built.system[0]!.text).toBe(profile.voice_guidance);
    expect(built.system[1]!.text).toContain(REFERENCE_BLOCK_LABEL);
    expect(built.system[1]!.text).toContain("Soft light for quiet rooms.");
    expect(built.system[2]!.text).toContain(ANTI_FORMULAIC_RULE);
  });

  it("threads the structure seed and the avoid-list", () => {
    expect(systemText).toContain(structureSeed(2));
    expect(systemText).toContain("Do NOT open with any pattern resembling:");
    expect(systemText).toContain('"A quiet arc of light."');
    expect(systemText).toContain('"Suspended from a slim cable."');
  });

  it("bakes in the copy rules: 75 words, no invented specs, no em dashes, WAC Group", () => {
    expect(systemText).toContain("75 words");
    expect(systemText).toContain("Never invent specifications");
    expect(systemText).toContain("em dashes");
    expect(systemText).toContain("WAC Group, never WAC alone");
    expect(systemText).not.toMatch(/—/); // scaffolding itself has no em dash
  });

  it("user = profile prompt + complete fact sheet", () => {
    expect(built.user.startsWith(profile.prompt)).toBe(true);
    expect(built.user).toContain(buildFactSheet(fullProduct));
  });

  it("drops empty sections cleanly", () => {
    const bare = buildDescriptionPrompt({
      profile: { prompt: "Write copy.", voice_guidance: "  " },
      product: fullProduct,
      referenceCopy: [],
      avoidOpenings: [],
      structureSeed: structureSeed(0),
    });
    expect(bare.system).toHaveLength(1); // only the anti-formulaic block
    expect(bare.system[0]!.text).not.toContain("Do NOT open with");
  });

  it("caps runaway reference copy per reference", () => {
    const long = buildDescriptionPrompt({
      profile,
      product: fullProduct,
      referenceCopy: [{ name: "Verbose", copy: "y".repeat(6000) }],
      avoidOpenings: [],
      structureSeed: structureSeed(0),
    });
    const refBlock = long.system.find((b) => b.text.includes(REFERENCE_BLOCK_LABEL))!;
    expect(refBlock.text.length).toBeLessThan(1600);
  });
});

describe("buildMetaPrompt", () => {
  const built = buildMetaPrompt({
    product: fullProduct,
    title: "FICTONA PENDANT | WAC LIGHTING",
    description: "A quiet arc of light. It floats over the table.",
    avoidMetas: ["Discover the Beamlet downlight from WAC Group."],
  });

  it("states the 50-160 char rule and the action-verb rule", () => {
    const sys = built.system.map((b) => b.text).join("\n");
    expect(sys).toContain(`${DESC_META_RANGE.min} to ${DESC_META_RANGE.max} characters`);
    expect(sys).toContain("action-oriented verb");
    expect(sys).toContain("WAC Group, never WAC alone");
  });

  it("references the current description and the page title", () => {
    expect(built.user).toContain("A quiet arc of light. It floats over the table.");
    expect(built.user).toContain("FICTONA PENDANT | WAC LIGHTING");
    expect(built.user).toContain("Fictona Pendant");
  });

  it("threads the avoid-list of sibling metas", () => {
    expect(built.user).toContain(
      '"Discover the Beamlet downlight from WAC Group."',
    );
    const bare = buildMetaPrompt({
      product: fullProduct,
      title: "T",
      description: "D.",
      avoidMetas: [],
    });
    expect(bare.user).not.toContain("Recently used meta descriptions");
  });

  it("DESC_META_RANGE is the docx 50-160 rule", () => {
    expect(DESC_META_RANGE).toEqual({ min: 50, max: 160 });
  });
});
