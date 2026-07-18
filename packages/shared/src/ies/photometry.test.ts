import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIES } from "./ies-parser.js";
import {
  beamAngles,
  computeBUG,
  computeUGR,
  efficacy,
  metricsAvailable,
  spacingCriterion,
  totalLuminaireLumens,
  zonalSummary,
} from "./photometry.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}

const downlight = parseIES(fixture("R2RAT-FTWA-WT.IES"), "R2RAT-FTWA-WT.IES"); // 181x17
const track = parseIES(fixture("AELS410-78MT130BK.IES"), "AELS410-78MT130BK.IES"); // 181x1

describe("beamAngles", () => {
  it("beam angle is narrower than field angle (50% inside 10%)", () => {
    const ba = beamAngles(downlight);
    expect(ba.beamC0).not.toBeNull();
    expect(ba.fieldC0).not.toBeNull();
    expect(ba.beamC0!).toBeLessThanOrEqual(ba.fieldC0!);
    expect(ba.maxCandela).toBeGreaterThan(0);
  });
});

describe("spacingCriterion", () => {
  it("returns a finite average S/MH ratio", () => {
    const sc = spacingCriterion(downlight);
    expect(sc.average).not.toBeNull();
    expect(sc.average!).toBeGreaterThan(0);
  });
});

describe("zonalSummary / totalLuminaireLumens", () => {
  it("zonal total matches the integrated luminaire lumens", () => {
    const zs = zonalSummary(downlight);
    const total = totalLuminaireLumens(downlight);
    expect(zs.total).toBeGreaterThan(0);
    // Same integral, computed two ways — allow tiny FP drift.
    expect(Math.abs(zs.total - total)).toBeLessThan(1e-6 + total * 1e-9);
    expect(zs.downward + zs.upward).toBeCloseTo(zs.total, 6);
  });
});

describe("efficacy", () => {
  it("equals total lumens divided by input watts", () => {
    const eff = efficacy(downlight);
    const expected = totalLuminaireLumens(downlight) / downlight.inputWatts;
    expect(eff).toBeCloseTo(expected, 6);
  });
});

describe("computeBUG", () => {
  it("produces a B/U/G rating string for multi-plane Type C", () => {
    const bug = computeBUG(downlight);
    expect(bug.rating).toMatch(/^B\d U\d G\d$/);
  });
});

describe("metricsAvailable", () => {
  it("is true for the multi-plane downlight", () => {
    const m = metricsAvailable(downlight);
    expect(m.bug).toBe(true);
    expect(m.ugr).toBe(true);
  });

  it("is false for the rotationally symmetric track file (numH === 1)", () => {
    const m = metricsAvailable(track);
    expect(m.bug).toBe(false);
    expect(m.ugr).toBe(false);
  });
});

describe("computeUGR default room", () => {
  it("returns a finite UGR value flagged as default", () => {
    const ugr = computeUGR(downlight);
    expect(Number.isFinite(ugr.value)).toBe(true);
    expect(ugr.isDefault).toBe(true);
  });
});
