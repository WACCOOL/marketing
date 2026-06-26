import { describe, expect, it } from "vitest";
import {
  buildSubTypePrompt,
  deriveSubTypeCandidates,
  hasClassifiableSignal,
  isJunkSubType,
  parseClassification,
  stripHtmlToText,
  validateSubType,
  type SubTypeCandidate,
  type SubTypeOption,
} from "./companySubType.js";

describe("isJunkSubType", () => {
  it("drops UNNEEDED / Not Use / Do not use options", () => {
    expect(isJunkSubType({ value: "9", label: "9—UNNEEDED" })).toBe(true);
    expect(isJunkSubType({ value: "Contractor", label: "Contractor (Not Use)" })).toBe(true);
    expect(isJunkSubType({ value: "Sub-Rep (Do not use)", label: "Sub-Rep (Do not use)" })).toBe(true);
  });
  it("drops denylisted typo-dupes and blanks", () => {
    expect(isJunkSubType({ value: "Destributor", label: "Destributor" })).toBe(true);
    expect(isJunkSubType({ value: "Contractor.", label: "Contractor" })).toBe(true);
    expect(isJunkSubType({ value: "  ", label: "" })).toBe(true);
  });
  it("keeps clean options", () => {
    expect(isJunkSubType({ value: "Distributor", label: "Distributor" })).toBe(false);
    expect(isJunkSubType({ value: "Lighting Showroom", label: "Lighting Showroom" })).toBe(false);
  });
});

describe("deriveSubTypeCandidates", () => {
  const options: SubTypeOption[] = [
    { value: "Distributor", label: "Distributor" },
    { value: "Destributor", label: "Destributor" },
    { value: "Lighting Showroom", label: "Lighting Showroom" },
    { value: "Contractor", label: "Contractor (Not Use)" },
    { value: "Interior Designer", label: "Interior Designer" },
  ];

  it("keeps used, real, non-junk options sorted by frequency", () => {
    const tallies = new Map<string, number>([
      ["Lighting Showroom", 50],
      ["Distributor", 120],
      ["Interior Designer", 10],
    ]);
    const out = deriveSubTypeCandidates(tallies, options);
    expect(out.map((c) => c.value)).toEqual([
      "Distributor",
      "Lighting Showroom",
      "Interior Designer",
    ]);
  });

  it("excludes junk options even when used", () => {
    const tallies = new Map<string, number>([
      ["Contractor", 99], // label is "(Not Use)"
      ["Destributor", 40], // denylisted typo
      ["Distributor", 5],
    ]);
    const out = deriveSubTypeCandidates(tallies, options);
    expect(out.map((c) => c.value)).toEqual(["Distributor"]);
  });

  it("excludes used values that are no longer real options", () => {
    const tallies = new Map<string, number>([["Some Legacy Value", 1000]]);
    expect(deriveSubTypeCandidates(tallies, options)).toEqual([]);
  });

  it("honors minCount", () => {
    const tallies = new Map<string, number>([
      ["Distributor", 1],
      ["Lighting Showroom", 5],
    ]);
    const out = deriveSubTypeCandidates(tallies, options, { minCount: 3 });
    expect(out.map((c) => c.value)).toEqual(["Lighting Showroom"]);
  });
});

describe("parseClassification", () => {
  it("parses a clean JSON answer", () => {
    expect(parseClassification('{"sub_type":"Distributor","confidence":0.82,"reasoning":"x"}')).toEqual({
      subType: "Distributor",
      confidence: 0.82,
      reasoning: "x",
    });
  });
  it("treats null / empty / \"null\" as no choice", () => {
    expect(parseClassification('{"sub_type":null,"confidence":0.1}')?.subType).toBeNull();
    expect(parseClassification('{"sub_type":"","confidence":0.1}')?.subType).toBeNull();
    expect(parseClassification('{"sub_type":"null","confidence":0.1}')?.subType).toBeNull();
  });
  it("tolerates code fences / surrounding prose", () => {
    const raw = 'Here:\n```json\n{"sub_type":"Architect","confidence":0.7}\n```';
    expect(parseClassification(raw)?.subType).toBe("Architect");
  });
  it("clamps confidence and defaults non-numeric to 0", () => {
    expect(parseClassification('{"sub_type":"X","confidence":5}')?.confidence).toBe(1);
    expect(parseClassification('{"sub_type":"X","confidence":"high"}')?.confidence).toBe(0);
  });
  it("returns null for unparseable input", () => {
    expect(parseClassification("not json at all")).toBeNull();
  });
});

describe("validateSubType", () => {
  const candidates: SubTypeCandidate[] = [
    { value: "Lighting Showroom", label: "Lighting Showroom", count: 3 },
    { value: "Distributor", label: "Distributor", count: 9 },
  ];
  it("matches by value or label, case/space-insensitively, returning canonical value", () => {
    expect(validateSubType("lighting   showroom", candidates)).toBe("Lighting Showroom");
    expect(validateSubType("DISTRIBUTOR", candidates)).toBe("Distributor");
  });
  it("rejects values not in the candidate set", () => {
    expect(validateSubType("Distributer", candidates)).toBeNull();
    expect(validateSubType(null, candidates)).toBeNull();
    expect(validateSubType("null", candidates)).toBeNull();
  });
});

describe("stripHtmlToText", () => {
  it("removes scripts/styles/tags and collapses whitespace", () => {
    const html =
      "<html><head><style>.a{}</style><script>x()</script></head><body><h1>Acme</h1>  <p>Lighting &amp; design</p></body></html>";
    expect(stripHtmlToText(html)).toBe("Acme Lighting & design");
  });
  it("bounds the output length", () => {
    expect(stripHtmlToText("<p>" + "a".repeat(10000) + "</p>", 100).length).toBe(100);
  });
});

describe("buildSubTypePrompt + hasClassifiableSignal", () => {
  it("lists allowed values and includes provided fields", () => {
    const { system, prompt } = buildSubTypePrompt({
      company: { name: "Bright Lights Showroom", industry: "Retail" },
      candidates: [
        { value: "Lighting Showroom", label: "Lighting Showroom", count: 5 },
        { value: "Distributor", label: "Distributor", count: 2 },
      ],
    });
    expect(system).toContain("STRICT JSON");
    expect(prompt).toContain("Bright Lights Showroom");
    expect(prompt).toContain("- Lighting Showroom");
    expect(prompt).toContain("- Distributor");
  });
  it("hasClassifiableSignal needs a name, description, or industry", () => {
    expect(hasClassifiableSignal({ name: "X" })).toBe(true);
    expect(hasClassifiableSignal({ description: "we sell lights" })).toBe(true);
    expect(hasClassifiableSignal({ domain: "x.com" })).toBe(false);
    expect(hasClassifiableSignal({})).toBe(false);
  });
});
