import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIDDLE_SHAPE,
  PROB_CEIL,
  PROB_FLOOR,
  solveStageProbabilities,
  weightedAverageProbability,
  type StageOpenCounts,
} from "./stageprob.js";

// Live open-pipeline snapshot used in the plan (Universal Pipeline).
const LIVE_COUNTS: StageOpenCounts = {
  prequal: 237,
  planning: 790,
  db: 7952,
  bidding: 4910,
  awarded: 299,
};

// Observed end-stage rates: Pre-Qualified 1/872 → 0% (floors to 1%), Awarded 4480/4483 → 100% (ceils to 99%).
const LIVE = { winRate: 0.367, openCounts: LIVE_COUNTS, prequalProb: 0.0, awardedProb: 1.0 };

describe("solveStageProbabilities", () => {
  it("calibrates the open-weighted average to the win rate", () => {
    const probs = solveStageProbabilities(LIVE)!;
    expect(probs).not.toBeNull();
    // Average lands on W (small slack for 2-dp rounding + end-stage banding).
    expect(weightedAverageProbability(probs, LIVE_COUNTS)).toBeCloseTo(0.367, 2);
  });

  it("produces the expected monotonic ramp for the live snapshot", () => {
    const probs = solveStageProbabilities(LIVE)!;
    expect(probs.prequal).toBe(0.01); // floored
    expect(probs.planning).toBeCloseTo(0.12, 2);
    expect(probs.db).toBeCloseTo(0.32, 2);
    expect(probs.bidding).toBeCloseTo(0.47, 2);
    expect(probs.awarded).toBe(0.99); // ceiled
  });

  it("always returns a non-decreasing ramp within the [1%,99%] band", () => {
    for (const winRate of [0.1, 0.25, 0.37, 0.5, 0.8]) {
      const probs = solveStageProbabilities({ ...LIVE, winRate })!;
      expect(probs.prequal).toBeLessThanOrEqual(probs.planning);
      expect(probs.planning).toBeLessThanOrEqual(probs.db);
      expect(probs.db).toBeLessThanOrEqual(probs.bidding);
      expect(probs.bidding).toBeLessThanOrEqual(probs.awarded);
      for (const p of Object.values(probs)) {
        expect(p).toBeGreaterThanOrEqual(PROB_FLOOR);
        expect(p).toBeLessThanOrEqual(PROB_CEIL);
      }
    }
  });

  it("scales the middle ramp up as the live win rate rises (dynamic)", () => {
    const low = solveStageProbabilities({ ...LIVE, winRate: 0.3 })!;
    const high = solveStageProbabilities({ ...LIVE, winRate: 0.45 })!;
    expect(high.planning).toBeGreaterThan(low.planning);
    expect(high.db).toBeGreaterThan(low.db);
    expect(high.bidding).toBeGreaterThan(low.bidding);
  });

  it("floors Pre-Qualified at 1% and ceils Awarded at 99% (HubSpot reserves 0/100)", () => {
    const probs = solveStageProbabilities({ ...LIVE, prequalProb: 0.0011, awardedProb: 0.999 })!;
    expect(probs.prequal).toBe(0.01); // 0.11% → floored to 1%
    expect(probs.awarded).toBe(0.99); // 99.9% → ceiled to 99%
  });

  it("lets Pre-Qualified rise above the floor when its observed rate clears 1%", () => {
    const probs = solveStageProbabilities({ ...LIVE, prequalProb: 0.04 })!;
    expect(probs.prequal).toBe(0.04); // 4% → stays 4%
    expect(probs.prequal).toBeLessThanOrEqual(probs.planning);
  });

  it("clamps a runaway win rate into the band (no probability above the ceiling)", () => {
    const probs = solveStageProbabilities({ ...LIVE, winRate: 5 })!;
    expect(probs.bidding).toBeLessThanOrEqual(PROB_CEIL);
    expect(probs.planning).toBeGreaterThanOrEqual(PROB_FLOOR);
  });

  it("never emits negative or sub-floor probabilities when the end pins dominate", () => {
    const probs = solveStageProbabilities({
      winRate: 0.05,
      openCounts: { prequal: 0, planning: 10, db: 10, bidding: 10, awarded: 5000 },
      prequalProb: 0,
      awardedProb: 1.0,
    })!;
    expect(probs.planning).toBeGreaterThanOrEqual(PROB_FLOOR);
    expect(probs.db).toBeGreaterThanOrEqual(PROB_FLOOR);
    expect(probs.bidding).toBeGreaterThanOrEqual(PROB_FLOOR);
  });

  it("returns null when there are no open deals in any middle stage", () => {
    expect(
      solveStageProbabilities({
        winRate: 0.37,
        openCounts: { prequal: 5, planning: 0, db: 0, bidding: 0, awarded: 9 },
        prequalProb: 0,
        awardedProb: 1.0,
      }),
    ).toBeNull();
  });

  it("returns null when the pipeline is empty", () => {
    expect(
      solveStageProbabilities({
        winRate: 0.37,
        openCounts: { prequal: 0, planning: 0, db: 0, bidding: 0, awarded: 0 },
        prequalProb: 0,
        awardedProb: 1.0,
      }),
    ).toBeNull();
  });

  it("honors a custom middle shape", () => {
    const probs = solveStageProbabilities({ ...LIVE, shape: { planning: 0.1, db: 0.5, bidding: 1.0 } })!;
    // Wider spread than the default shape between Planning and Bidding.
    expect(probs.bidding - probs.planning).toBeGreaterThan(0.3);
    expect(weightedAverageProbability(probs, LIVE_COUNTS)).toBeCloseTo(0.367, 2);
  });

  it("DEFAULT_MIDDLE_SHAPE is monotonic increasing", () => {
    expect(DEFAULT_MIDDLE_SHAPE.planning).toBeLessThan(DEFAULT_MIDDLE_SHAPE.db);
    expect(DEFAULT_MIDDLE_SHAPE.db).toBeLessThan(DEFAULT_MIDDLE_SHAPE.bidding);
  });
});
