/**
 * Deal-stage probability solver for the HubSpot weighted pipeline.
 *
 * HubSpot multiplies each deal's amount by its stage "Deal probability" to get the
 * weighted/forecast amount. Rather than trust raw per-stage win rates for the middle
 * stages — which are badly right-censored while stage history is only ~6 months old
 * (winners are still in-flight, losers have already closed) — we CALIBRATE: pick
 * probabilities so the open-deal-count-weighted average equals the realized overall
 * win rate `W`.
 *
 * The two END stages are pinned to their OWN observed win rates (passed in): Pre-Qualified
 * and Awarded both resolve toward a near-deterministic value, so their actual rate is
 * usable directly. The three middle stages (Planning, Design & Budgeting, Bidding &
 * Negotiating) follow a fixed monotonic SHAPE whose single scale `s` is solved so the
 * weighted average lands on `W`. All outputs are rounded to the nearest whole percent and
 * clamped to the open-stage band [1%, 99%] (see {@link PROB_FLOOR}/{@link PROB_CEIL}) —
 * so Pre-Qualified floors at 1% and Awarded ceils at 99%.
 * Everything is recomputed on a schedule, so the levels track the live win rate and live
 * pipeline mix. Once a middle stage's cohort matures, its shape weight can be replaced
 * with its real observed rate (still rescaled here to stay calibrated).
 *
 * Pure + deterministic — the HTTP/orchestration lives in apps/api.
 */

/** Open-deal counts per stage (the deals being forecast). */
export interface StageOpenCounts {
  prequal: number;
  planning: number;
  db: number;
  bidding: number;
  awarded: number;
}

/** Relative monotonic weights for the three censored middle stages. */
export interface MiddleShape {
  planning: number;
  db: number;
  bidding: number;
}

/** Solved probabilities for the five stages (Pre-Qualified & Awarded pinned to observed). */
export interface StageProbabilities {
  prequal: number;
  planning: number;
  db: number;
  bidding: number;
  awarded: number;
}

export interface SolveStageInput {
  /** Realized overall win rate W = won / (won + lost), 0..1. The calibration target. */
  winRate: number;
  /** Current open-deal counts per stage. */
  openCounts: StageOpenCounts;
  /** Pinned Pre-Qualified probability (its own observed win rate), 0..1. Rounds to ~0%. */
  prequalProb: number;
  /** Pinned Awarded probability (its own observed win rate), 0..1. Rounds to ~100%. */
  awardedProb: number;
  /** Relative shape for the middle stages. Defaults to {@link DEFAULT_MIDDLE_SHAPE}. */
  shape?: MiddleShape;
}

/**
 * Default relative shape for Planning : D&B : Bidding. Monotonic increasing; only the
 * ratios matter (the absolute level is solved). Today this yields ≈12% / 32% / 47% at
 * W=0.37 against the live pipeline mix. Tunable; replace a weight with a real observed
 * rate once that stage's cohort is mature.
 */
export const DEFAULT_MIDDLE_SHAPE: MiddleShape = { planning: 0.25, db: 0.68, bidding: 1.0 };

/**
 * Valid probability band for OPEN stages. HubSpot treats exactly 0% as Closed Lost and
 * 100% as Closed Won, so every open stage is clamped to [1%, 99%]: Pre-Qualified floors
 * at 1% (instead of its ~0% observed) and Awarded ceils at 99% (instead of its ~100%).
 */
export const PROB_FLOOR = 0.01;
export const PROB_CEIL = 0.99;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const clamp01 = (x: number): number => clamp(Number.isFinite(x) ? x : 0, 0, 1);
const nonNeg = (x: number): number => (Number.isFinite(x) && x > 0 ? x : 0);
const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Solve the four managed stage probabilities so the open-count-weighted average over
 * all open stages (Pre-Qualified pinned at 0, Awarded pinned at `awardedProb`) equals
 * `winRate`. Returns `null` when it can't calibrate (no open deals, or no open deals in
 * any middle stage) — the caller should then skip writing and keep the current values.
 *
 * Results are clamped to [0, awardedProb] (so Bidding never exceeds Awarded) and rounded
 * to 2 dp. Edge case: if the Awarded mass alone already exceeds the target, the middle
 * stages clamp to 0 and the weighted average sits slightly above `winRate` — the caller
 * logs the achieved average so this is visible.
 */
export function solveStageProbabilities(input: SolveStageInput): StageProbabilities | null {
  const shape = input.shape ?? DEFAULT_MIDDLE_SHAPE;
  const W = clamp01(input.winRate);
  // End stages: round to whole percent, then clamp into the open-stage band [1%, 99%].
  const prequal = clamp(round2(clamp01(input.prequalProb)), PROB_FLOOR, PROB_CEIL);
  const awarded = clamp(round2(clamp01(input.awardedProb)), PROB_FLOOR, PROB_CEIL);
  const c: StageOpenCounts = {
    prequal: nonNeg(input.openCounts.prequal),
    planning: nonNeg(input.openCounts.planning),
    db: nonNeg(input.openCounts.db),
    bidding: nonNeg(input.openCounts.bidding),
    awarded: nonNeg(input.openCounts.awarded),
  };

  const total = c.prequal + c.planning + c.db + c.bidding + c.awarded;
  const middleWeight = c.planning * shape.planning + c.db * shape.db + c.bidding * shape.bidding;
  if (total <= 0 || middleWeight <= 0) return null;

  // Σ(count·p) = W·total, with both ends pinned to their (banded) observed rate. One scale `s`.
  const target = W * total - c.prequal * prequal - c.awarded * awarded;
  const s = target / middleWeight;

  // Middle stages: round to whole percent, clamp into [1%, awarded] (keeps Bidding ≤ Awarded).
  const mid = (w: number): number => clamp(round2(clamp(s * w, 0, awarded)), PROB_FLOOR, awarded);
  return {
    prequal,
    planning: mid(shape.planning),
    db: mid(shape.db),
    bidding: mid(shape.bidding),
    awarded,
  };
}

/**
 * The open-count-weighted average win probability actually achieved by a solved set,
 * across all five stages. Handy for logging/asserting the calibration landed on `winRate`.
 */
export function weightedAverageProbability(
  probs: StageProbabilities,
  openCounts: StageOpenCounts,
): number {
  const c = openCounts;
  const total = nonNeg(c.prequal) + nonNeg(c.planning) + nonNeg(c.db) + nonNeg(c.bidding) + nonNeg(c.awarded);
  if (total <= 0) return 0;
  const sum =
    nonNeg(c.prequal) * probs.prequal +
    nonNeg(c.planning) * probs.planning +
    nonNeg(c.db) * probs.db +
    nonNeg(c.bidding) * probs.bidding +
    nonNeg(c.awarded) * probs.awarded;
  return sum / total;
}
