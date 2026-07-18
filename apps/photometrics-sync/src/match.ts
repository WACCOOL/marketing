/**
 * Filename-token matcher — picks which inner IES file inside a family bundle is
 * the "representative" photometry for a given SKU.
 *
 * WAC IES bundles ship one .ies per optic / CCT / wattage variant (e.g.
 * `R2RAT-FTWA-WT(15W at 4000K).IES`). A product SKU maps to one family bundle;
 * we want to flag exactly one inner file as the canonical distribution for that
 * SKU (the closest filename match), while still recording every optic as a
 * selectable row.
 *
 * The scorer is a pure uppercase-alphanumeric TOKEN OVERLAP: normalize the SKU
 * and the inner filename into token sets, score by how much of the SKU's tokens
 * the filename covers (with a small bonus for how tightly the filename matches
 * back). Deterministic, dependency-free, and unit-tested.
 */

/** Split a string into whole uppercase alphanumeric tokens (split only on
 *  non-alphanumeric boundaries). Family/optic/wattage codes stay intact —
 *  "R2RAT", "FTWA", "15W" — which keeps the overlap precise; splitting alpha
 *  from digit runs would mint noisy single-char tokens ("R","2") that create
 *  spurious matches. */
export function tokenize(s: string): string[] {
  return s
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** Match score in [0, 1] for how well `filename` represents `sku`.
 *
 *  Base = fraction of the SKU's DISTINCT tokens that appear in the filename
 *  (SKU coverage — the thing we care about most). A small precision bonus
 *  rewards filenames that don't drown the SKU in unrelated tokens, so a tight
 *  match beats a sprawling one when SKU coverage ties. */
export function matchScore(sku: string, filename: string): number {
  // Strip an extension off the filename before tokenizing.
  const base = filename.replace(/\.[a-z0-9]+$/i, "");
  const skuTokens = new Set(tokenize(sku));
  const fileTokens = new Set(tokenize(base));
  if (skuTokens.size === 0 || fileTokens.size === 0) return 0;

  let overlap = 0;
  for (const t of skuTokens) if (fileTokens.has(t)) overlap++;
  if (overlap === 0) return 0;

  const coverage = overlap / skuTokens.size; // how much of the SKU is present
  const precision = overlap / fileTokens.size; // how tightly the file matches
  // Coverage dominates; precision is a light tiebreaker.
  return Number((coverage * 0.85 + precision * 0.15).toFixed(6));
}

export interface RepresentativePick {
  /** Index into the input `filenames` array of the chosen representative. */
  index: number;
  /** Match confidence in [0, 1] for the chosen file (0 = pure fallback). */
  confidence: number;
  /** Per-file confidence, aligned to the input `filenames` order. */
  scores: number[];
}

/** Choose exactly ONE representative inner file for a SKU. Returns the index of
 *  the best filename-token match; ties resolve to the earliest file; when
 *  nothing matches at all (all scores 0) it falls back to the first file with
 *  confidence 0. Pure — the caller owns the DB writes. */
export function pickRepresentative(sku: string, filenames: string[]): RepresentativePick {
  const scores = filenames.map((f) => matchScore(sku, f));
  let bestIdx = 0;
  let best = -1;
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]!;
    if (s > best) {
      best = s;
      bestIdx = i;
    }
  }
  return {
    index: filenames.length ? bestIdx : -1,
    confidence: best > 0 ? best : 0,
    scores,
  };
}
