import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseIES } from "./ies-parser.js";

const FIX_DIR = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}

const IES_FILES = readdirSync(FIX_DIR).filter((f) => /\.ies$/i.test(f));

describe("parseIES — golden fixtures", () => {
  it("has fixtures to parse", () => {
    expect(IES_FILES.length).toBeGreaterThanOrEqual(4);
  });

  for (const name of IES_FILES) {
    it(`parses ${name}`, () => {
      const res = parseIES(fixture(name), name);
      // All WAC EVERFINE sample files are LM-63-2002 Type C.
      expect(res.format).toBe("LM-63-2002");
      expect(res.photometricType).toBe("C");
      expect(res.tilt).toBe("NONE");
      // Grid dimensions are positive and match the parsed angle arrays.
      expect(res.numV).toBeGreaterThan(0);
      expect(res.numH).toBeGreaterThan(0);
      expect(res.vAngles).toHaveLength(res.numV);
      expect(res.hAngles).toHaveLength(res.numH);
      expect(res.candela).toHaveLength(res.numH);
      expect(res.candela[0]).toHaveLength(res.numV);
      // Post-scale candela sanity: some non-zero light in the file.
      const maxC = Math.max(...res.candela.flat());
      expect(maxC).toBeGreaterThan(0);
      // Scale factors were captured (never NaN).
      expect(Number.isFinite(res.candelaMultiplierApplied)).toBe(true);
      expect(Number.isFinite(res.ballastFactorApplied)).toBe(true);
    });
  }
});

describe("parseIES — specific shapes", () => {
  it("R2RAT downlight is multi-plane Type C (181x17)", () => {
    const res = parseIES(fixture("R2RAT-FTWA-WT.IES"), "R2RAT-FTWA-WT.IES");
    expect(res.numV).toBe(181);
    expect(res.numH).toBe(17);
    expect(res.inputWatts).toBeGreaterThan(0);
    // LM-63-2002 header ⇒ file generation type is NOT decoded (2019-only).
    expect(res.fileGenerationType).toBeUndefined();
  });

  it("AELS4 track file is rotationally symmetric (numH === 1) + absolute", () => {
    const res = parseIES(fixture("AELS410-78MT130BK.IES"), "AELS410-78MT130BK.IES");
    expect(res.numH).toBe(1);
    // lumens-per-lamp = -1 sentinel ⇒ absolute photometry warning.
    expect(res.lumensPerLamp).toBeLessThanOrEqual(0);
    expect(res.warnings.some((w) => w.code === "I_SYMMETRIC")).toBe(true);
  });

  it("TILT=NONE files never emit a TILT-include warning", () => {
    const res = parseIES(fixture("R2RD1T-WTWA-WT.IES"), "R2RD1T-WTWA-WT.IES");
    expect(res.warnings.some((w) => w.code === "W_TILT_INCLUDE")).toBe(false);
  });
});
