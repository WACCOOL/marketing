import { describe, expect, it } from "vitest";
import { parseProjectFocus, projectFocusToValue, buildProjectFocusPrompt } from "./projectFocus.js";

describe("parseProjectFocus", () => {
  it("parses a residential-only answer", () => {
    expect(parseProjectFocus('{"focus":["Residential"],"confidence":0.9}')).toMatchObject({
      focus: ["Residential"],
      confidence: 0.9,
    });
  });

  it("parses both, deduped and validated", () => {
    expect(
      parseProjectFocus('{"focus":["Commercial","Residential","commercial","Bogus"],"confidence":1.4}'),
    ).toMatchObject({ focus: ["Commercial", "Residential"], confidence: 1 });
  });

  it("tolerates code fences and key variants", () => {
    expect(parseProjectFocus('```json\n{"project_focus":"Commercial","confidence":0.5}\n```')).toMatchObject({
      focus: ["Commercial"],
    });
  });

  it("returns null when nothing valid (caller defaults to Residential)", () => {
    expect(parseProjectFocus('{"focus":[],"confidence":0.2}')).toBeNull();
    expect(parseProjectFocus("not json")).toBeNull();
    expect(parseProjectFocus("")).toBeNull();
  });
});

describe("projectFocusToValue", () => {
  it("joins with ; and orders Residential first; defaults to Residential", () => {
    expect(projectFocusToValue(["Commercial", "Residential"])).toBe("Residential;Commercial");
    expect(projectFocusToValue(["Commercial"])).toBe("Commercial");
    expect(projectFocusToValue([])).toBe("Residential");
  });
});

describe("buildProjectFocusPrompt", () => {
  it("includes company fields and website excerpt", () => {
    const { system, prompt } = buildProjectFocusPrompt({
      company: { name: "Frost Designs", website: "frost.com", description: "luxury homes" },
      websiteText: "We design beautiful residences.",
    });
    expect(system).toContain("Commercial");
    expect(prompt).toContain("Frost Designs");
    expect(prompt).toContain("WEBSITE TEXT");
  });
});
