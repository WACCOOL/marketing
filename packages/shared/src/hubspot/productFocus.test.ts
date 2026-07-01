import { describe, expect, it } from "vitest";
import { parseProductFocus, productFocusToValue, buildProductFocusPrompt } from "./productFocus.js";
import { overrideFor, mfAccount } from "./companyClassifyOverrides.js";

describe("parseProductFocus", () => {
  it("parses single + both, deduped/validated", () => {
    expect(parseProductFocus('{"focus":["Decorative"],"confidence":0.9}')).toMatchObject({ focus: ["Decorative"], confidence: 0.9 });
    expect(parseProductFocus('{"focus":["Decorative","Functional","decorative","junk"],"confidence":1.3}')).toMatchObject({
      focus: ["Decorative", "Functional"],
      confidence: 1,
    });
  });
  it("tolerates code fences + key variants; null when empty", () => {
    expect(parseProductFocus('```json\n{"product_focus":"Functional","confidence":0.5}\n```')).toMatchObject({ focus: ["Functional"] });
    expect(parseProductFocus('{"focus":[]}')).toBeNull();
    expect(parseProductFocus("nope")).toBeNull();
  });
});

describe("productFocusToValue", () => {
  it("Functional first; defaults to Functional", () => {
    expect(productFocusToValue(["Decorative", "Functional"])).toBe("Functional;Decorative");
    expect(productFocusToValue(["Decorative"])).toBe("Decorative");
    expect(productFocusToValue([])).toBe("Functional");
  });
});

describe("overrides", () => {
  it("name overrides win", () => {
    expect(overrideFor({ name: "Graybar Electric" })).toBe("Functional");
    expect(overrideFor({ name: "CED Greentech" })).toBe("Functional");
    expect(overrideFor({ name: "Ferguson Bath & Lighting" })).toBe("Decorative");
    expect(overrideFor({ name: "Advanced Lighting" })).toBeNull(); // no false match on 'ced'
  });
  it("MF account → Decorative", () => {
    expect(mfAccount("MF01693")).toBe(true);
    expect(mfAccount("2001693")).toBe(false);
    expect(overrideFor({ name: "Lighting Etc", accountNumber: "MF01693" })).toBe("Decorative");
    expect(overrideFor({ name: "Some Co", accountNumber: "2001693" })).toBeNull();
  });
});

describe("buildProductFocusPrompt", () => {
  it("includes fields + site", () => {
    const { system, prompt } = buildProductFocusPrompt({ company: { name: "CED", description: "electrical supply" }, websiteText: "wholesale electrical" });
    expect(system).toContain("Decorative");
    expect(system).toContain("Functional");
    expect(prompt).toContain("CED");
    expect(prompt).toContain("WEBSITE TEXT");
  });
});
