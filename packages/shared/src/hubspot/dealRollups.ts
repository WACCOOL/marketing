/**
 * Company deal-rollup properties — "YTD Won Deals", "YTD Prior Year Deals",
 * "Prior Year Deals": closed-won deal value rolled up onto the Company. The
 * deal-based counterpart of the workbook-driven ytd_sales family that
 * sales-sync already maintains; refreshed by its --deal-rollups mode.
 *
 * Scope: Universal Pipeline, Closed Won stage, deal has an SAP quote number.
 * Buckets key on closedate, which this pipeline stamps at midnight UTC
 * (toHubspotDate) — so all window math here is UTC. "YTD Prior Year" cuts off
 * at today's month/day one year ago (whole day inclusive) so it compares
 * apples-to-apples with the current YTD; Feb 29 rolls to Mar 1 via Date.UTC.
 *
 * Each deal is attributed to exactly ONE company — its primary association
 * (deals also carry Specifier company associations that must not be credited).
 *
 * Pure: no I/O. sales-sync feeds it HubSpot search/association results.
 */

export const ROLLUP_PROP_YTD = "ytd_won_deals";
export const ROLLUP_PROP_PRIOR_YTD = "ytd_prior_year_won_deals";
export const ROLLUP_PROP_PRIOR_YEAR = "prior_year_won_deals";

export const DEAL_ROLLUP_PROPS: { name: string; label: string }[] = [
  { name: ROLLUP_PROP_YTD, label: "YTD Won Deals" },
  { name: ROLLUP_PROP_PRIOR_YTD, label: "YTD Prior Year Deals" },
  { name: ROLLUP_PROP_PRIOR_YEAR, label: "Prior Year Deals" },
];

/** HUBSPOT_DEFINED deal→company primary association type. */
export const DEAL_TO_COMPANY_PRIMARY_TYPE_ID = 5;

export interface DealRollupWindows {
  nowMs: number;
  /** Jan 1 of the current year (UTC). YTD = [ytdStartMs, nowMs]. */
  ytdStartMs: number;
  /** Jan 1 of the prior year (UTC) — also the sweep's minimum closedate. */
  priorStartMs: number;
  /** Exclusive end of prior-year YTD: the day after (today minus one year). */
  priorYtdEndMs: number;
  /** Exclusive end of the full prior year (= Jan 1 current year). */
  priorYearEndMs: number;
}

const DAY_MS = 86_400_000;

export function dealRollupWindows(nowMs: number): DealRollupWindows {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const janCurrent = Date.UTC(y, 0, 1);
  return {
    nowMs,
    ytdStartMs: janCurrent,
    priorStartMs: Date.UTC(y - 1, 0, 1),
    priorYtdEndMs: Date.UTC(y - 1, d.getUTCMonth(), d.getUTCDate()) + DAY_MS,
    priorYearEndMs: janCurrent,
  };
}

export interface DealCompanyAssoc {
  companyId: string;
  typeIds: number[];
}

/**
 * The one company a deal's value is credited to: the primary association;
 * fallback to the sole associated company; null (skip + count) when several
 * companies and none primary.
 */
export function pickRollupCompanyId(assocs: DealCompanyAssoc[]): string | null {
  const primary = [
    ...new Set(
      assocs.filter((a) => a.typeIds.includes(DEAL_TO_COMPANY_PRIMARY_TYPE_ID)).map((a) => a.companyId),
    ),
  ];
  if (primary.length === 1) return primary[0]!;
  if (primary.length > 1) return null;
  const distinct = [...new Set(assocs.map((a) => a.companyId))];
  return distinct.length === 1 ? distinct[0]! : null;
}

export interface RollupDeal {
  companyId: string;
  /** Parse the HubSpot closedate via toEpochMs before passing. */
  closedateMs: number | null;
  /** Raw HubSpot amount value; blank/NaN deals are skipped. */
  amount: unknown;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Sum qualifying deals into the three buckets per company. Every company that
 * had at least one summable deal appears with ALL THREE properties (0-filled),
 * so a write can never leave a property partially stale.
 */
export function aggregateDealRollups(
  deals: RollupDeal[],
  w: DealRollupWindows,
): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const d of deals) {
    if (d.closedateMs === null) continue;
    if (d.amount === null || d.amount === undefined || d.amount === "") continue;
    const amt = Number(d.amount);
    if (!Number.isFinite(amt)) continue;
    let props = out.get(d.companyId);
    if (!props) {
      props = { [ROLLUP_PROP_YTD]: 0, [ROLLUP_PROP_PRIOR_YTD]: 0, [ROLLUP_PROP_PRIOR_YEAR]: 0 };
      out.set(d.companyId, props);
    }
    const t = d.closedateMs;
    if (t >= w.ytdStartMs && t <= w.nowMs) props[ROLLUP_PROP_YTD]! += amt;
    if (t >= w.priorStartMs && t < w.priorYtdEndMs) props[ROLLUP_PROP_PRIOR_YTD]! += amt;
    if (t >= w.priorStartMs && t < w.priorYearEndMs) props[ROLLUP_PROP_PRIOR_YEAR]! += amt;
  }
  for (const props of out.values()) {
    for (const k of Object.keys(props)) props[k] = round2(props[k]!);
  }
  return out;
}

/**
 * Final write set: the fresh aggregate as-is, plus all-zero writes for
 * companies that carry a value from a previous run but dropped out of the
 * aggregate (Jan-1 rollover, amount edits, deal deletion/de-association).
 */
export function buildRollupWrites(
  fresh: Map<string, Record<string, number>>,
  existingIds: Iterable<string>,
): Map<string, Record<string, number>> {
  const writes = new Map(fresh);
  for (const id of existingIds) {
    if (!writes.has(id)) {
      writes.set(id, { [ROLLUP_PROP_YTD]: 0, [ROLLUP_PROP_PRIOR_YTD]: 0, [ROLLUP_PROP_PRIOR_YEAR]: 0 });
    }
  }
  return writes;
}
