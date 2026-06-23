import { describe, expect, it } from "vitest";
import {
  canonicalize,
  extractInvalidPropertyItems,
  healProperties,
  isValidationError,
  parseAllowedOptionsFromMessage,
  smartMatchToAllowedOptions,
} from "./heal.js";

describe("canonicalize", () => {
  it("strips case, spacing, and punctuation", () => {
    expect(canonicalize("  Closed - Won ")).toBe("CLOSEDWON");
    expect(canonicalize("Commercial / Retail")).toBe("COMMERCIALRETAIL");
  });
});

describe("smartMatchToAllowedOptions", () => {
  const opts = ["Closed Won", "Closed Lost", "Commercial - Retail"];
  it("matches exact (case/space/punct-insensitive)", () => {
    expect(smartMatchToAllowedOptions("closed-won", opts)).toBe("Closed Won");
    expect(smartMatchToAllowedOptions("COMMERCIAL / RETAIL", opts)).toBe("Commercial - Retail");
  });
  it("matches a unique prefix (handles truncation)", () => {
    expect(smartMatchToAllowedOptions("Commerc", opts)).toBe("Commercial - Retail");
  });
  it("matches a unique reverse-prefix", () => {
    expect(smartMatchToAllowedOptions("Closed Won Extra", ["Closed Won"])).toBe("Closed Won");
  });
  it("returns null when ambiguous", () => {
    expect(smartMatchToAllowedOptions("Closed", opts)).toBeNull();
  });
  it("returns null when nothing matches", () => {
    expect(smartMatchToAllowedOptions("Nope", opts)).toBeNull();
  });
  it("applies the C0MMERCIAL - MILITARY (zero-for-O) seed fixup", () => {
    expect(smartMatchToAllowedOptions("Commercial - Military", ["C0MMERCIAL - MILITARY"])).toBe(
      "C0MMERCIAL - MILITARY",
    );
  });
});

describe("parseAllowedOptionsFromMessage", () => {
  it("extracts the bracketed option list", () => {
    expect(parseAllowedOptionsFromMessage("bad value; allowed options: [A, B, C]")).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
  it("returns null when there is no list", () => {
    expect(parseAllowedOptionsFromMessage("some other error")).toBeNull();
  });
});

describe("extractInvalidPropertyItems", () => {
  it("parses the 'Property values were not valid: [...]' JSON shape", () => {
    const data = {
      category: "VALIDATION_ERROR",
      message:
        'Property values were not valid: [{"isValid":false,"name":"project_type","localizedErrorMessage":"x allowed options: [Comm, Resi]"}]',
    };
    const items = extractInvalidPropertyItems(data);
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe("project_type");
    expect(items[0]!.allowedOptions).toEqual(["Comm", "Resi"]);
  });
});

describe("isValidationError", () => {
  it("recognizes validation + duplicate-id errors", () => {
    expect(isValidationError({ category: "VALIDATION_ERROR" })).toBe(true);
    expect(isValidationError({ message: "Property values were not valid: [...]" })).toBe(true);
    expect(isValidationError({ message: "Duplicate IDs found in batch input" })).toBe(true);
    expect(isValidationError({ message: "rate limited" })).toBe(false);
  });
});

describe("healProperties", () => {
  const errorFor = (name: string, allowed: string[]) => ({
    category: "VALIDATION_ERROR",
    message: `Property values were not valid: [{"isValid":false,"name":"${name}","localizedErrorMessage":"bad; allowed options: [${allowed.join(", ")}]"}]`,
  });

  it("normalizes a near-miss value to the allowed option without mutating the input", () => {
    const input = { project_type: "Commerc", dealname: "X" }; // unique prefix of the option
    const res = healProperties(input, errorFor("project_type", ["Commercial - Retail"]));
    expect(res.properties.project_type).toBe("Commercial - Retail");
    expect(res.actions).toEqual([
      { property: "project_type", from: "Commerc", to: "Commercial - Retail", action: "normalized" },
    ]);
    expect(res.changed).toBe(true);
    expect(input.project_type).toBe("Commerc"); // original untouched
  });

  it("drops an unmatchable value", () => {
    const res = healProperties({ project_type: "Wat" }, errorFor("project_type", ["A", "B"]));
    expect("project_type" in res.properties).toBe(false);
    expect(res.actions[0]).toMatchObject({ property: "project_type", action: "dropped" });
  });

  it("no-ops when the invalid property isn't in the bag", () => {
    const res = healProperties({ dealname: "X" }, errorFor("project_type", ["A"]));
    expect(res.changed).toBe(false);
    expect(res.actions).toEqual([]);
  });
});
