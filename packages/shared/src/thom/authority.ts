/**
 * Authority bias — the TS spec-mirror of the band-gated additive bias inside
 * migration 0054's kb_search, plus the canonical authority-tier values the
 * crawl stamps onto kb_documents.
 *
 * The SQL is the runtime; this mirror exists so the ranking math has unit
 * tests (the DB function can't run under vitest) and so the crawl and any
 * future tuning share one definition of the tiers. If 0054's expression
 * changes, this MUST change with it — the tests encode the invariants the
 * ratified plan calls a launch gate (bias is a TIEBREAK, never a re-rank).
 */

/** Default lambda the tool layer passes for company/ambiguous-intent queries.
 *  Product/SKU-shaped queries pass 0 (authority OFF). */
export const AUTHORITY_WEIGHT_DEFAULT = 0.004;

/** Band gate: bias applies only to results within this fraction of the pool's
 *  top fused score. */
export const AUTHORITY_BAND_DEFAULT = 0.85;

/**
 * Canonical authority tiers (value stored on kb_documents.authority).
 * WAC Group corporate outranks main-brand corporate outranks aiSpire
 * (group-affiliated, one level below the 4 main brands — Davis 2026-07-20),
 * with 1.0 as the marketing/spec-sheet baseline and nav/resource lowest.
 */
export const AUTHORITY_TIERS = {
  wacGroupCorporate: 1.5,
  brandCorporate: 1.2, // WAC Architectural, WAC Lighting, Modern Forms, Schonbek
  aispireCorporate: 1.1,
  marketingBaseline: 1.0,
  news: 0.9,
  webProduct: 0.8,
  resourceNav: 0.7,
} as const;

/**
 * The additive bias a chunk receives, mirroring 0054 exactly:
 *   0 when lambda <= 0 (authority OFF — the rollout default and the
 *     product-intent path), or when the fused score is below band * poolMax;
 *   otherwise lambda * clamp(authority - 1.0, min -0.3).
 */
export function authorityBias(
  fusedScore: number,
  poolMaxScore: number,
  authority: number,
  weight: number = AUTHORITY_WEIGHT_DEFAULT,
  band: number = AUTHORITY_BAND_DEFAULT,
): number {
  if (weight <= 0) return 0;
  if (fusedScore < band * poolMaxScore) return 0;
  return weight * Math.max(authority - 1.0, -0.3);
}

/** Final ranking score under the 0054 model. */
export function rankedScore(
  fusedScore: number,
  poolMaxScore: number,
  authority: number,
  weight?: number,
  band?: number,
): number {
  return fusedScore + authorityBias(fusedScore, poolMaxScore, authority, weight, band);
}
