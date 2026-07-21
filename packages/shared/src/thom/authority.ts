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

/**
 * Query-shape detection for intent gating (plan D.2; extended for the
 * lighting-expert plan's C.3 education gating). Deliberately cheap and
 * conservative:
 *  - 'product': the query contains a SKU/model-code-shaped token (FR-W1801,
 *    A2RU-447-27, 5401E) — authority must be OFF (λ=0) so corporate pages can
 *    never outrank the best technical answer, and education chunks are
 *    EXCLUDED from search_docs (they structurally cannot displace spec-sheet
 *    chunks on the query class the team has fought contamination on);
 *  - 'education': lighting-fundamentals / energy-code / design-guidance
 *    wording — the admin-uploaded education library is squarely in scope;
 *  - 'company': company/capability-shaped wording — brand-hierarchy queries
 *    where the WAC Group corporate page should win a near-tie;
 *  - 'ambiguous': everything else (λ still applies, but band + cap keep it a
 *    tiebreak; education docs stay retrievable).
 *
 * Order matters: a SKU token wins even when code words are present ("does
 * FR-W1801 meet Title 24") — the product data must stay uncontaminated.
 */
export type DocsQueryIntent = "product" | "company" | "education" | "ambiguous";

const SKU_TOKEN_RE = /\b[A-Za-z][A-Za-z0-9]{0,5}-[A-Za-z0-9][A-Za-z0-9-]{2,}\b|\b\d{3,6}E?\b/;
const COMPANY_RE =
  /\b(who is|about|company|companies|capabilit\w*|sustainab\w*|responsib\w*|history|founded|headquarters|manufactur\w*|brands?|wac group|technolog\w*|light\s*(&|and)\s*health)\b/i;
const EDUCATION_RE =
  /\b(foot-?candles?|illuminance|lux level|light(ing)? levels?|lighting power density|lpd\b|energy codes?|title\s*24|ashrae|iecc|ja8|candela|delivered lumens|source lumens|color rendering|bug rating|dark[- ]?sky|lighting ordinance|ada (protrusion|standard)|what (is|are|does) .*(lumen|watt|efficacy|cct|cri|candela|kelvin|footcandle)|glossary|terminolog\w*)\b/i;

export function detectDocsQueryIntent(query: string): DocsQueryIntent {
  const q = query.trim();
  if (SKU_TOKEN_RE.test(q)) return "product";
  if (EDUCATION_RE.test(q)) return "education";
  if (COMPANY_RE.test(q)) return "company";
  return "ambiguous";
}

/** The authority_weight search_docs should pass for a query, honoring the
 *  enable flag (off ⇒ always 0 ⇒ kb_search ordering identical to pre-0054). */
export function authorityWeightFor(intent: DocsQueryIntent, enabled: boolean): number {
  if (!enabled) return 0;
  return intent === "product" ? 0 : AUTHORITY_WEIGHT_DEFAULT;
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
