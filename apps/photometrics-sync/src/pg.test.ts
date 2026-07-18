import { describe, expect, it } from "vitest";
import { stripNul } from "./pg.js";

const NUL = String.fromCharCode(0);

describe("stripNul", () => {
  it("removes U+0000 from a plain string", () => {
    expect(stripNul(`a${NUL}b${NUL}`)).toBe("ab");
  });

  it("returns strings without NUL unchanged (same reference)", () => {
    const s = "clean";
    expect(stripNul(s)).toBe(s);
  });

  it("recurses through nested objects and arrays", () => {
    const input = {
      inner_filename: `R2RAT${NUL}.IES`,
      warnings: [
        { code: "W_PHOT_TYPE", message: `bad${NUL} type` },
        { code: "I_SYMMETRIC", message: "ok" },
      ],
      metrics: { format: `LM-63${NUL}`, lumens: 442.46, bug: null },
    };
    expect(stripNul(input)).toEqual({
      inner_filename: "R2RAT.IES",
      warnings: [
        { code: "W_PHOT_TYPE", message: "bad type" },
        { code: "I_SYMMETRIC", message: "ok" },
      ],
      metrics: { format: "LM-63", lumens: 442.46, bug: null },
    });
  });

  it("leaves numbers, null, and booleans intact", () => {
    expect(stripNul(42)).toBe(42);
    expect(stripNul(null)).toBe(null);
    expect(stripNul(false)).toBe(false);
  });

  it("produces JSON with no NUL escape (Postgres-safe)", () => {
    const out = stripNul({ a: `x${NUL}y`, b: [`${NUL}z`] });
    expect(JSON.stringify(out)).not.toContain("\\u0000");
  });
});
