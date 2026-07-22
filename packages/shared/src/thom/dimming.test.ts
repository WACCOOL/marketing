// =============================================================================
// Dimming pure-logic tests (plan §F): schema round-trip, normalization
// ordering (qualifier-strip FIRST — DC2), the DC1 status-derivation table over
// every audited comment string, slash-expansion on the exact audited strings
// (DC8), the DC10 fuzzy-tier table (DVCL-153P / DVCL-153PD / DVCL-153PH),
// pattern conversion, report-code derivation (DC9), and the stratified
// verification sampler (DC5).
// =============================================================================
import { describe, expect, it } from "vitest";
import {
  baseDimmerModel,
  commentsMatch,
  containsTierAllowed,
  deriveRowStatus,
  dimmerModelPart,
  expandRelatedModels,
  extractedDimmingReportSchema,
  likeToRegExp,
  normalizeDimmerModel,
  normalizeHyphens,
  normalizeRelatedModels,
  parseModeQualifier,
  patternToLike,
  phaseFromSectionHeader,
  pickVerificationSamples,
  rankDimmerMatches,
  reportCodeFromEntryPath,
  skuMatchesLikes,
  splitDimmerQuery,
  tokenAnchoredContains,
  verifyExtraction,
  type VerifiableRow,
} from "./dimming.js";

// --- schema round-trip -------------------------------------------------------

describe("extractedDimmingReportSchema", () => {
  it("round-trips a full report and applies defaults", () => {
    const parsed = extractedDimmingReportSchema.parse({
      report_code: null,
      product_family: '5" Tube & Cube Architectural',
      skus_tested: ["DS-WS05-F30A-WT"],
      related_model_patterns: ["DS-CD05-*"],
      test_voltage_range: "120-277VAC",
      control_types: ["ELV", "0-10V"],
      test_notes: null,
      rows: [
        {
          page: 1,
          section_header: "Adaptive Phase Dimmers",
          manufacturer: "Legrand",
          dimmer_series: "Adorne Touch (ELV)",
          dimmer_model: "ADTH700RMTUM1",
          phase_type: "adaptive",
          test_voltage: "120",
          low_end_pct: 9,
          comments: "Flicker below 9%",
        },
      ],
    });
    expect(parsed.rows[0]!.related_dimmer_models).toEqual([]);
    expect(parsed.rows[0]!.low_end_pct).toBe(9);
  });

  it("rejects an out-of-enum phase type", () => {
    expect(() =>
      extractedDimmingReportSchema.parse({
        report_code: "X",
        product_family: "f",
        rows: [
          {
            page: 1,
            section_header: "s",
            manufacturer: "m",
            dimmer_series: null,
            dimmer_model: "M-1",
            phase_type: "magnetic",
            test_voltage: "120",
            low_end_pct: null,
            comments: "",
          },
        ],
      }),
    ).toThrow();
  });
});

// --- normalization (DC2 ordering + U+2010) -----------------------------------

describe("normalization", () => {
  it("parses and strips the mode qualifier from the model cell", () => {
    expect(parseModeQualifier("Adorne Touch (ELV)")).toEqual({
      text: "Adorne Touch",
      qualifier: "elv",
    });
    expect(parseModeQualifier("ADTP703TU (TRIAC)")).toEqual({
      text: "ADTP703TU",
      qualifier: "triac",
    });
    expect(parseModeQualifier("DVCL-153P")).toEqual({ text: "DVCL-153P", qualifier: null });
  });

  it("strips the qualifier BEFORE collapsing spaces (DC2 — no fused garbage keys)", () => {
    // Naive space-collapse first would produce "ADTP703TU(ELV)".
    expect(normalizeDimmerModel("ADTP703TU (ELV)")).toBe("ADTP703TU");
    expect(normalizeDimmerModel("Adorne Touch (TRIAC)")).toBe("ADORNETOUCH");
  });

  it("fixes U+2010/U+2011 hyphens and drops spaces/periods, uppercased", () => {
    expect(normalizeDimmerModel("NTELV‐600")).toBe("NTELV-600");
    expect(normalizeDimmerModel("ma elv.600")).toBe("MAELV600");
    expect(normalizeHyphens("DS‐CD05‐*")).toBe("DS-CD05-*");
  });
});

// --- slash-expansion (DC8 — the exact audited strings) -----------------------

describe("expandRelatedModels", () => {
  const table: [string, string[]][] = [
    ["AYCL-153P/253P", ["AYCL-153P", "AYCL-253P"]],
    ["CTCL-150H/153P", ["CTCL-150H", "CTCL-153P"]],
    ["LECL-150H/153P", ["LECL-150H", "LECL-153P"]],
    ["HQRD-6ND/10D", ["HQRD-6ND", "HQRD-10D"]],
    ["RRD-6ND/10D", ["RRD-6ND", "RRD-10D"]],
    ["-", []],
    ["", []],
  ];
  for (const [cell, want] of table) {
    it(`expands ${JSON.stringify(cell)} -> ${JSON.stringify(want)}`, () => {
      expect(expandRelatedModels(cell)).toEqual(want);
    });
  }

  it("keeps a complete alternative with its own hyphen standalone", () => {
    expect(expandRelatedModels("MA-PRO/RRD-PRO")).toEqual(["MA-PRO", "RRD-PRO"]);
  });

  it("normalizes U+2010 in expanded keys and dedupes", () => {
    expect(normalizeRelatedModels(["AYCL‐153P/253P", "-", "AYCL-153P"])).toEqual([
      "AYCL-153P",
      "AYCL-253P",
    ]);
  });
});

// --- pattern conversion + matching -------------------------------------------

describe("patterns", () => {
  it("converts * to % with U+2010 fix + uppercase", () => {
    expect(patternToLike("DS‐CD05‐*")).toBe("DS-CD05-%");
    expect(patternToLike("dc-pd05-*")).toBe("DC-PD05-%");
  });

  it("matches SKUs against LIKE patterns, anchored", () => {
    expect(skuMatchesLikes("DS-CD05-F30A-WT", ["DS-CD05-%"])).toBe(true);
    expect(skuMatchesLikes("DS-CD0517-F30A", ["DS-CD05-%"])).toBe(false); // 17W family differs
    expect(skuMatchesLikes("XDS-CD05-F30A", ["DS-CD05-%"])).toBe(false); // anchored
    expect(likeToRegExp("DS-CD05-%").test("DS-CD05-ANYTHING")).toBe(true);
  });
});

// --- report code derivation (DC9) --------------------------------------------

describe("reportCodeFromEntryPath", () => {
  it("derives from the zip entry filename", () => {
    expect(reportCodeFromEntryPath("Tube_Cube_Architectural/5in Tube and Cube/E1801063-1_25W.pdf")).toBe(
      "E1801063-1_25W",
    );
    expect(reportCodeFromEntryPath("WAC-S2_V0_DIMREP.pdf")).toBe("WAC-S2_V0_DIMREP");
  });
});

// --- section header -> phase --------------------------------------------------

describe("phaseFromSectionHeader", () => {
  it("maps every real header generation", () => {
    expect(phaseFromSectionHeader("Adaptive Phase Dimmers")).toBe("adaptive");
    expect(phaseFromSectionHeader("Reverse Phase Dimmers (ELV)")).toBe("elv");
    expect(phaseFromSectionHeader("Forward Phase Dimmers (TRIAC)")).toBe("triac");
    expect(phaseFromSectionHeader("Forward Phase Dimmers (TRIAC) Cont.")).toBe("triac");
    expect(phaseFromSectionHeader("0-10V Dimmers")).toBe("zero_to_ten_v");
    expect(phaseFromSectionHeader("0‐10V Dimmers")).toBe("zero_to_ten_v");
    expect(phaseFromSectionHeader("iOS or Android APP")).toBe("other"); // DC12
  });
});

// --- status derivation table (DC1 — every audited comment string) ------------

describe("deriveRowStatus", () => {
  const cases: {
    low: number | null;
    comment: string;
    status: string;
    unknown?: boolean;
  }[] = [
    // Numeric low end, clean or caveated -> tested_compatible.
    { low: 7.0, comment: "", status: "tested_compatible" },
    { low: 9.0, comment: "Flicker below 9%", status: "tested_compatible" },
    { low: 4.0, comment: "Noise at 1 meter away", status: "tested_compatible" },
    { low: 2.0, comment: "Flicker below 96%", status: "tested_compatible" },
    // "Not Recommended" always wins, numeric or not.
    { low: 10.0, comment: "Not Recommended", status: "not_recommended" },
    { low: null, comment: "Not Recommended", status: "not_recommended" },
    { low: 3.0, comment: "not recommended", status: "not_recommended" },
    // Null low end + non-function list -> not_compatible.
    { low: null, comment: "Dimmer not responsive", status: "not_compatible" },
    { low: null, comment: "Does not find appropriate load", status: "not_compatible" },
    { low: null, comment: "277V phase control not supported", status: "not_compatible" },
    // Null low end + known issue vocabulary -> tested_issue (DC1 finds).
    { low: null, comment: "Flashing at all dimming levels", status: "tested_issue" },
    { low: null, comment: "Flashing at high dimming level", status: "tested_issue" },
    { low: null, comment: "Flash when switched on at maximum", status: "tested_issue" },
    { low: null, comment: "Per Lutron, not rated for LED", status: "tested_issue" },
    {
      low: null,
      comment: "Slider functional. Toggle on/off not functional",
      status: "tested_issue",
    },
    { low: null, comment: "Follow dimmer wiring without relay", status: "tested_issue" },
    // Null low end + blank or unknown comment -> tested_issue, flagged for review.
    { low: null, comment: "", status: "tested_issue", unknown: true },
    { low: null, comment: "Wobbles mysteriously at dusk", status: "tested_issue", unknown: true },
  ];
  for (const c of cases) {
    it(`low=${c.low} "${c.comment}" -> ${c.status}`, () => {
      const d = deriveRowStatus(c.low, c.comment);
      expect(d.status).toBe(c.status);
      if (c.unknown !== undefined) expect(d.unknownVocabulary).toBe(c.unknown);
    });
  }

  it("HARD RULE: a null low end can NEVER derive tested_compatible", () => {
    const comments = ["", "-", "anything at all", "Flashing at all dimming levels", "ok"];
    for (const comment of comments) {
      expect(deriveRowStatus(null, comment).status).not.toBe("tested_compatible");
    }
  });
});

// --- fuzzy tiers (DC10 table) ------------------------------------------------

const row = (
  manufacturer: string,
  norm: string,
  related: string[] = [],
): { manufacturer: string; dimmer_model_norm: string; related_dimmer_models_norm: string[] } => ({
  manufacturer,
  dimmer_model_norm: norm,
  related_dimmer_models_norm: related,
});

describe("rankDimmerMatches (DC10)", () => {
  const corpus = [
    row("Lutron", "DVCL-153PD"),
    row("Lutron", "MACL-153M-WH"),
    row("Lutron", "AYCL-153PH"),
    row("Lutron", "SCL-153P-WH"),
    row("Lutron", "MA-PRO", ["RRD-PRO"]),
    row("Leviton", "IPE04-1LZ"),
  ];

  it("exact match wins tier 1", () => {
    const m = rankDimmerMatches("DVCL-153PD", corpus);
    expect(m[0]!.row.dimmer_model_norm).toBe("DVCL-153PD");
    expect(m[0]!.tier).toBe("exact");
  });

  it("DVCL-153P finds DVCL-153PD as a base (closest) match, never AYCL-153PH", () => {
    const m = rankDimmerMatches("DVCL-153P", corpus);
    expect(m.length).toBeGreaterThan(0);
    expect(m[0]!.row.dimmer_model_norm).toBe("DVCL-153PD");
    expect(m[0]!.tier).toBe("base");
    expect(m.map((x) => x.row.dimmer_model_norm)).not.toContain("AYCL-153PH");
  });

  it("DVCL-153PH must NOT surface AYCL-153PH (cross-manufacturer junk pin)", () => {
    const m = rankDimmerMatches("DVCL-153PH", corpus);
    expect(m.map((x) => x.row.dimmer_model_norm)).not.toContain("AYCL-153PH");
    // It reduces to the DVCL base instead.
    expect(m[0]!.row.dimmer_model_norm).toBe("DVCL-153PD");
    expect(m[0]!.tier).toBe("base");
  });

  it("finish suffix reduces toward the base: DVCL-153P-WH -> DVCL-153PD family", () => {
    const m = rankDimmerMatches("DVCL-153P-WH", corpus);
    expect(m[0]!.row.dimmer_model_norm).toBe("DVCL-153PD");
  });

  it("related-models hit (MA-PRO tested 'for' RRD-PRO, DC8)", () => {
    const m = rankDimmerMatches("RRD-PRO", corpus);
    expect(m[0]!.row.dimmer_model_norm).toBe("MA-PRO");
    expect(m[0]!.tier).toBe("related");
  });

  it("manufacturer co-match: a named manufacturer restricts the pool", () => {
    const both = [...corpus, row("Leviton", "DVCL-153PD")];
    const m = rankDimmerMatches("Lutron DVCL-153PD", both);
    expect(m).toHaveLength(1);
    expect(m[0]!.row.manufacturer).toBe("Lutron");
  });

  it("contains tier requires >= 6 chars including a digit", () => {
    expect(containsTierAllowed("153")).toBe(false); // short
    expect(containsTierAllowed("ADORNE")).toBe(false); // no digit
    expect(containsTierAllowed("DVCL-153")).toBe(true);
    // "153P" is short + would hit five different models -> no contains matches.
    const m = rankDimmerMatches("153P", corpus);
    expect(m.filter((x) => x.tier === "contains")).toHaveLength(0);
  });

  it("contains tier is token-anchored (no mid-token hits)", () => {
    expect(tokenAnchoredContains("MACL-153M-WH", "153M")).toBe(true); // token start
    expect(tokenAnchoredContains("MACL-153M-WH", "ACL-153")).toBe(false); // mid-token
  });

  it("series words are dropped from the model query ('Caseta PD-5NE')", () => {
    expect(dimmerModelPart("Caseta PD-5NE")).toBe("PD-5NE");
    expect(dimmerModelPart("Adorne Touch")).toBe("Adorne Touch"); // no digit word
    const m = rankDimmerMatches("Diva DVCL-153PD", corpus);
    expect(m[0]!.tier).toBe("exact");
  });

  it("splitDimmerQuery detects a known manufacturer, longest first", () => {
    expect(splitDimmerQuery("Lutron DVCL-153P", ["Lutron", "Leviton"])).toEqual({
      manufacturer: "Lutron",
      modelQuery: "DVCL-153P",
    });
    expect(splitDimmerQuery("DVCL-153P", ["Lutron"])).toEqual({
      manufacturer: null,
      modelQuery: "DVCL-153P",
    });
  });

  it("baseDimmerModel keeps the manufacturer prefix distinct", () => {
    expect(baseDimmerModel("DVCL-153PD")).toBe("DVCL-153P");
    expect(baseDimmerModel("DVCL-153P-WH")).toBe("DVCL-153P");
    expect(baseDimmerModel("AYCL-153PH")).toBe("AYCL-153P");
    expect(baseDimmerModel("MACL-153M-WH")).toBe("MACL-153M");
  });
});

// --- stratified sampler (DC5) ------------------------------------------------

const vrow = (over: Partial<VerifiableRow>): VerifiableRow => ({
  page: 1,
  section_header: "Adaptive Phase Dimmers",
  phase_type: "adaptive",
  manufacturer: "Lutron",
  dimmer_model: "M-1",
  mode_qualifier: null,
  dimmer_model_norm: "M-1",
  test_voltage: "120",
  low_end_pct: 5,
  comments: "",
  ...over,
});

describe("pickVerificationSamples", () => {
  it("covers every section on every page (incl. page-2 Cont. bands)", () => {
    const rows: VerifiableRow[] = [
      vrow({ page: 1, phase_type: "adaptive", dimmer_model_norm: "A1" }),
      vrow({ page: 1, phase_type: "elv", section_header: "Reverse Phase Dimmers (ELV)", dimmer_model_norm: "E1" }),
      vrow({ page: 1, phase_type: "triac", section_header: "Forward Phase Dimmers (TRIAC)", dimmer_model_norm: "T1" }),
      vrow({ page: 2, phase_type: "triac", section_header: "Forward Phase Dimmers (TRIAC) Cont.", dimmer_model_norm: "T2" }),
      vrow({ page: 2, phase_type: "zero_to_ten_v", section_header: "0-10V Dimmers", dimmer_model_norm: "Z1" }),
    ];
    const sections = pickVerificationSamples(rows);
    expect(sections).toHaveLength(5);
    expect(sections.every((s) => s.sample !== null)).toBe(true);
    // Page-2 sections present.
    expect(sections.filter((s) => s.page === 2)).toHaveLength(2);
  });

  it("skips duplicate (model, voltage) keys unless the qualifier disambiguates", () => {
    const rows: VerifiableRow[] = [
      // The 2018-layout coin-flip: same model + voltage, differing only by qualifier.
      vrow({ dimmer_model_norm: "ADTH700RMTUM1", mode_qualifier: "elv", low_end_pct: 9 }),
      vrow({ dimmer_model_norm: "ADTH700RMTUM1", mode_qualifier: "triac", low_end_pct: 18 }),
      // A genuinely ambiguous duplicate (no qualifier at all) — never sampled.
      vrow({ dimmer_model_norm: "DUP-1" }),
      vrow({ dimmer_model_norm: "DUP-1", low_end_pct: 7 }),
    ];
    const [section] = pickVerificationSamples(rows);
    expect(section!.sample).not.toBeNull();
    // The sample must be one of the qualifier-disambiguated rows, never DUP-1.
    expect(section!.sample!.dimmer_model_norm).toBe("ADTH700RMTUM1");
    expect(section!.sample!.mode_qualifier).not.toBeNull();
  });

  it("returns a null sample when every row in a section is ambiguous", () => {
    const rows: VerifiableRow[] = [vrow({ dimmer_model_norm: "DUP" }), vrow({ dimmer_model_norm: "DUP" })];
    const [section] = pickVerificationSamples(rows);
    expect(section!.sample).toBeNull();
    expect(section!.rowCount).toBe(2);
  });
});

// --- verification comparison -------------------------------------------------

describe("verifyExtraction", () => {
  const rows: VerifiableRow[] = [
    vrow({ dimmer_model_norm: "A1", low_end_pct: 9, comments: "Flicker below 9%" }),
  ];
  const sections = pickVerificationSamples(rows);
  const counts = [{ page: 1, section_header: "Adaptive Phase Dimmers", row_count: 1 }];

  it("passes on matching answers (loose comment compare)", () => {
    const v = verifyExtraction(
      sections,
      [{ index: 0, low_end_pct: 9.0, comments: "flicker below 9%", section_header: "Adaptive Phase Dimmers" }],
      counts,
    );
    expect(v.ok).toBe(true);
  });

  it("flags a low-end mismatch", () => {
    const v = verifyExtraction(
      sections,
      [{ index: 0, low_end_pct: 19, comments: "Flicker below 9%", section_header: "Adaptive Phase Dimmers" }],
      counts,
    );
    expect(v.ok).toBe(false);
    expect(v.mismatches.join(" ")).toMatch(/low-end/);
  });

  it("flags SECTION MEMBERSHIP disagreement (the catastrophic failure mode)", () => {
    const v = verifyExtraction(
      sections,
      [
        {
          index: 0,
          low_end_pct: 9,
          comments: "Flicker below 9%",
          section_header: "Forward Phase Dimmers (TRIAC)",
        },
      ],
      counts,
    );
    expect(v.ok).toBe(false);
    expect(v.mismatches.join(" ")).toMatch(/section/);
  });

  it("flags a per-section row-count mismatch", () => {
    const v = verifyExtraction(
      sections,
      [{ index: 0, low_end_pct: 9, comments: "Flicker below 9%", section_header: "Adaptive Phase Dimmers" }],
      [{ page: 1, section_header: "Adaptive Phase Dimmers", row_count: 3 }],
    );
    expect(v.ok).toBe(false);
    expect(v.mismatches.join(" ")).toMatch(/row count/);
  });

  it("commentsMatch treats blank forms as equal", () => {
    expect(commentsMatch("", "none")).toBe(true);
    expect(commentsMatch("N/A", "")).toBe(true);
    expect(commentsMatch("Flicker below 9%", "totally different")).toBe(false);
  });
});
