import { describe, expect, it } from "vitest";
import { SHOWROOM_SHEETS } from "./registry.js";

describe("SHOWROOM_SHEETS registry", () => {
  it("has unique agency keys and spreadsheet ids", () => {
    const keys = SHOWROOM_SHEETS.map((s) => s.agencyKey);
    const ids = SHOWROOM_SHEETS.map((s) => s.spreadsheetId);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses key-safe slugs (lowercase alphanumerics/dashes, no colons)", () => {
    for (const s of SHOWROOM_SHEETS) {
      expect(s.agencyKey).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(s.spreadsheetId.length).toBeGreaterThan(20);
    }
  });
});
