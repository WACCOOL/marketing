import { describe, expect, it } from "vitest";
import { generateSlug, isValidVanitySlug } from "./slug.js";

describe("generateSlug", () => {
  it("generates the requested length", () => {
    expect(generateSlug(8)).toHaveLength(8);
  });
  it("avoids lookalike characters 0 O 1 I l", () => {
    for (let i = 0; i < 1000; i++) {
      const s = generateSlug(10);
      expect(s).not.toMatch(/[0OIl1]/);
    }
  });
});

describe("isValidVanitySlug", () => {
  it("accepts simple alphanumeric and hyphen/underscore slugs", () => {
    expect(isValidVanitySlug("hd-expo-2026")).toBe(true);
    expect(isValidVanitySlug("aia_print")).toBe(true);
  });
  it("rejects too-short, too-long, reserved, or invalid slugs", () => {
    expect(isValidVanitySlug("a")).toBe(false);
    expect(isValidVanitySlug("-leading-hyphen")).toBe(false);
    expect(isValidVanitySlug("has space")).toBe(false);
    expect(isValidVanitySlug("api")).toBe(false);
    expect(isValidVanitySlug("a".repeat(80))).toBe(false);
  });
});
