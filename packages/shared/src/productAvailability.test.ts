import { describe, it, expect } from "vitest";
import {
  variantAvailability,
  availabilityLabel,
  isHiddenVariant,
  AVAILABILITY_LABEL,
} from "./productAvailability.js";

const base = { hasCategory: true, isPpid: false, plantStatus: "" };

describe("variantAvailability — Rule 3 (N/P hidden)", () => {
  it("hides zusage N and P regardless of other signals", () => {
    for (const z of ["N", "P", "n", "p"]) {
      expect(variantAvailability({ ...base, zusage: z })).toBe("hidden");
    }
  });
  it("N/P stays hidden even with a category, PPID, and any plant status", () => {
    expect(
      variantAvailability({ zusage: "P", hasCategory: true, isPpid: true, plantStatus: "DW" }),
    ).toBe("hidden");
    expect(
      variantAvailability({ zusage: "N", hasCategory: false, isPpid: false, plantStatus: "UR" }),
    ).toBe("hidden");
  });
});

describe("variantAvailability — Rule 2 (active, no label)", () => {
  it("A/B/W with blank plant status shows with no label", () => {
    for (const z of ["A", "B", "W"]) {
      expect(variantAvailability({ ...base, zusage: z })).toBe("normal");
    }
  });
  it("A/B/W at non-retired plant statuses (UR/EX/T1) shows with no label", () => {
    for (const p of ["UR", "EX", "T1"]) {
      expect(variantAvailability({ ...base, zusage: "B", plantStatus: p })).toBe("normal");
    }
  });
  it("today's live state: A/B/W + blank plant + no PPID => normal (only N/P hidden)", () => {
    expect(variantAvailability({ zusage: "B", hasCategory: true, isPpid: false, plantStatus: "" })).toBe("normal");
    expect(variantAvailability({ zusage: "W", hasCategory: true, isPpid: false, plantStatus: "" })).toBe("normal");
    expect(variantAvailability({ zusage: "A", hasCategory: true, isPpid: false, plantStatus: "" })).toBe("normal");
  });
});

describe("variantAvailability — Rule 1 (Retired label)", () => {
  it("L2/L3 + A/B/W + retired plant => retired", () => {
    for (const p of ["DW", "DV", "IW", "IV", "IG", "PW", "PV"]) {
      expect(variantAvailability({ ...base, zusage: "A", plantStatus: p })).toBe("retired");
    }
  });
  it("zusage A at a retired plant is retired even with a PPID (A is not W/B, so not limited)", () => {
    expect(variantAvailability({ zusage: "A", hasCategory: true, isPpid: true, plantStatus: "DW" })).toBe("retired");
  });
});

describe("variantAvailability — Rule 4 (Limited Availability label)", () => {
  it("PPID + L2/L3 + W/B + retired plant => limited (wins over Rule 1)", () => {
    for (const z of ["W", "B"]) {
      expect(
        variantAvailability({ zusage: z, hasCategory: true, isPpid: true, plantStatus: "PV" }),
      ).toBe("limited");
    }
  });
  it("without a PPID the same W/B + retired plant falls back to retired (Rule 1)", () => {
    expect(variantAvailability({ zusage: "W", hasCategory: true, isPpid: false, plantStatus: "PV" })).toBe("retired");
  });
});

describe("variantAvailability — no category => retired", () => {
  it("a product without a category reference is retired (active zusage)", () => {
    expect(variantAvailability({ zusage: "B", hasCategory: false, isPpid: false, plantStatus: "" })).toBe("retired");
  });
  it("but N/P without a category is still hidden, not retired", () => {
    expect(variantAvailability({ zusage: "N", hasCategory: false })).toBe("hidden");
  });
});

describe("variantAvailability — edge cases", () => {
  it("blank/unknown zusage defaults to normal (does not hide on surprise)", () => {
    expect(variantAvailability({ ...base, zusage: "" })).toBe("normal");
    expect(variantAvailability({ ...base, zusage: null })).toBe("normal");
    expect(variantAvailability({ ...base, zusage: "X" })).toBe("normal");
  });
  it("normalizes case and whitespace on zusage and plant status", () => {
    expect(variantAvailability({ ...base, zusage: " b ", plantStatus: " dw " })).toBe("retired");
  });
  it("an unrecognized plant status is treated as active (not retired)", () => {
    expect(variantAvailability({ ...base, zusage: "B", plantStatus: "ZZ" })).toBe("normal");
  });
});

describe("labels", () => {
  it("maps states to customer-facing labels", () => {
    expect(availabilityLabel("retired")).toBe("Retired");
    expect(availabilityLabel("limited")).toBe("Limited Availability, Consult Factory");
    expect(availabilityLabel("hidden")).toBe("");
    expect(availabilityLabel("normal")).toBe("");
  });
  it("AVAILABILITY_LABEL covers every state", () => {
    expect(Object.keys(AVAILABILITY_LABEL).sort()).toEqual(["hidden", "limited", "normal", "retired"]);
  });
});

describe("isHiddenVariant", () => {
  it("true only for N/P", () => {
    expect(isHiddenVariant({ ...base, zusage: "N" })).toBe(true);
    expect(isHiddenVariant({ ...base, zusage: "P" })).toBe(true);
    expect(isHiddenVariant({ ...base, zusage: "B" })).toBe(false);
    expect(isHiddenVariant({ zusage: "B", hasCategory: false })).toBe(false); // retired, not hidden
  });
});
