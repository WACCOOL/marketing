import { describe, expect, it } from "vitest";
import { parseAuxLengthMm } from "./auxLength.js";

describe("parseAuxLengthMm (Addendum 2 — unit REQUIRED)", () => {
  it("parses every unit shape seen in the connector audit", () => {
    expect(parseAuxLengthMm("6 Feet")).toBe(1828.8);
    expect(parseAuxLengthMm("30 Feet")).toBe(9144);
    expect(parseAuxLengthMm("6ft")).toBe(1828.8);
    expect(parseAuxLengthMm("5'")).toBe(1524);
    expect(parseAuxLengthMm("1 Foot")).toBe(304.8);
    expect(parseAuxLengthMm("72 in")).toBe(1828.8);
    expect(parseAuxLengthMm("96in")).toBe(2438.4);
    expect(parseAuxLengthMm("9 Inches")).toBe(228.6);
    expect(parseAuxLengthMm("1 Inch")).toBe(25.4);
    expect(parseAuxLengthMm('57"')).toBe(1447.8);
    expect(parseAuxLengthMm("12.5 in")).toBe(317.5);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseAuxLengthMm("  6 FEET  ")).toBe(1828.8);
    expect(parseAuxLengthMm("10 FT")).toBe(3048);
  });

  it("returns null for a bare number (ambiguous — the unit is REQUIRED)", () => {
    expect(parseAuxLengthMm("180")).toBeNull();
    expect(parseAuxLengthMm("120")).toBeNull();
    expect(parseAuxLengthMm("47.5")).toBeNull();
  });

  it("returns null for placeholders, prose, and junk", () => {
    expect(parseAuxLengthMm(null)).toBeNull();
    expect(parseAuxLengthMm(undefined)).toBeNull();
    expect(parseAuxLengthMm("")).toBeNull();
    expect(parseAuxLengthMm("N/A")).toBeNull();
    expect(parseAuxLengthMm("#N/A")).toBeNull();
    expect(parseAuxLengthMm("Adjustable")).toBeNull();
    expect(parseAuxLengthMm("6 Feet max per run")).toBeNull(); // trailing prose is not a clean length
    expect(parseAuxLengthMm("0 ft")).toBeNull();
    expect(parseAuxLengthMm("-5 in")).toBeNull();
  });
});
