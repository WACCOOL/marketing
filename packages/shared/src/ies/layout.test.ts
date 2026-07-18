import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIES } from "./ies-parser.js";
import { pickGridShape, placeFixtures, solveLayout } from "./layout.js";
import type { EstimatorInputs } from "./types.js";

/** Behavior-preserving anchor for the WIES layout solver port. The
 *  numbers below are this port's output against R2SD2T-WTWA-WT (a Volta
 *  2" narrow optic, ~589 delivered lm) — the closest fixture on hand to
 *  the WIES solveLayout docstring benchmark (a ~651 lm Volta narrow
 *  optic → 8 / 15 / 30 fixtures for 10×10 / 13×13 / 20×20 ft @ 30 fc).
 *  The 13×13 → 15 result matches the WIES benchmark exactly; 10×10 and
 *  20×20 land one/five over because our IES file delivers slightly fewer
 *  lumens. Locked here so an accidental algorithm change is caught. */

const M_PER_FT = 0.3048;

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}

const volta = parseIES(fixture("R2SD2T-WTWA-WT.IES"), "R2SD2T-WTWA-WT.IES");

function office(roomFt: number, ceilFt: number): EstimatorInputs {
  return {
    mounting: "ceiling",
    aim: "down",
    target: { kind: "horizontal", heightAboveFloor: 0.76 }, // 30" WP
    roomLength: roomFt * M_PER_FT,
    roomWidth: roomFt * M_PER_FT,
    ceilingHeight: ceilFt * M_PER_FT,
    reflectances: { ceiling: 0.8, wall: 0.5, floor: 0.2 },
    targetFc: 30,
    taskKey: "office-general",
    llf: 0.85,
    unit: "fc",
    system: "imperial",
  };
}

describe("solveLayout — benchmark rooms (WIES parity anchor)", () => {
  it("10×10×9 ft @ 30 fc → 9 heads on a clean grid meeting target", () => {
    const r = solveLayout(volta, office(10, 9));
    expect(r.count).toBe(9);
    expect(r.rows * r.cols).toBe(r.count); // uniform rectangle
    expect(r.actualFc).toBeGreaterThanOrEqual(30);
  });

  it("13×13×9 ft @ 30 fc → 15 heads (exact WIES benchmark)", () => {
    const r = solveLayout(volta, office(13, 9));
    expect(r.count).toBe(15);
    expect(r.actualFc).toBeGreaterThanOrEqual(30);
  });

  it("20×20×10 ft @ 30 fc → 35 heads on a clean grid", () => {
    const r = solveLayout(volta, office(20, 10));
    expect(r.count).toBe(35);
    expect(r.rows * r.cols).toBe(r.count);
    expect(r.actualFc).toBeGreaterThanOrEqual(30);
  });

  it("head count grows monotonically with room size", () => {
    const a = solveLayout(volta, office(10, 9)).count;
    const b = solveLayout(volta, office(13, 9)).count;
    const c = solveLayout(volta, office(20, 10)).count;
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});

describe("pickGridShape — deterministic square-room orientation", () => {
  it("N=14 in a square room picks 3×5 cols×rows (smaller cols wins the tie)", () => {
    const g = pickGridShape(14, 10, 10);
    expect(g.cols).toBe(3);
    expect(g.rows).toBe(5);
    expect(g.count).toBe(15);
  });

  it("degenerate N handled", () => {
    expect(pickGridShape(1, 10, 10)).toEqual({ rows: 1, cols: 1, count: 1 });
    expect(pickGridShape(0, 10, 10)).toEqual({ rows: 0, cols: 0, count: 0 });
  });
});

describe("placeFixtures — full rectangle when a grid shape is supplied", () => {
  it("emits exactly rows×cols fixtures inside the room footprint", () => {
    const inputs = office(20, 10);
    const fx = placeFixtures(inputs, 6, { rows: 2, cols: 3 });
    expect(fx).toHaveLength(6);
    for (const f of fx) {
      expect(f.x).toBeGreaterThan(0);
      expect(f.x).toBeLessThan(inputs.roomWidth);
      expect(f.y).toBeGreaterThan(0);
      expect(f.y).toBeLessThan(inputs.roomLength);
      expect(f.z).toBeCloseTo(inputs.ceilingHeight, 6);
    }
  });
});
