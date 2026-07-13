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
// 2026-07-13 additions (Davis): lost value ALWAYS measured by max_amount
// (SAP zeroes rejected lines so a lost deal's amount decays — the peak is what
// was lost; fallback to amount when max_amount is blank); pipeline/projection
// derive from the daily global rates — see aggregateExtendedRollups.
export const ROLLUP_PROP_YTD_LOST = "ytd_lost_deals";
export const ROLLUP_PROP_PIPELINE = "future_pipeline_value";
export const ROLLUP_PROP_CREATION = "future_creation_value";
export const ROLLUP_PROP_PROJECTED = "projected_sales_quote_visibility";

export const DEAL_ROLLUP_PROPS: { name: string; label: string }[] = [
  { name: ROLLUP_PROP_YTD, label: "YTD Won Deals" },
  { name: ROLLUP_PROP_PRIOR_YTD, label: "YTD Prior Year Deals" },
  { name: ROLLUP_PROP_PRIOR_YEAR, label: "Prior Year Deals" },
  { name: ROLLUP_PROP_YTD_LOST, label: "YTD Lost Deals (Max Amount)" },
  { name: ROLLUP_PROP_PIPELINE, label: "Current Year Future Value of Pipeline" },
  { name: ROLLUP_PROP_CREATION, label: "Current Year Expected New-Deal Wins" },
  { name: ROLLUP_PROP_PROJECTED, label: "Projected Sales (Quote Visibility)" },
];

/** All-zero write for one company — derived from DEAL_ROLLUP_PROPS so the
 * stale-zeroing path can never miss a newly added rollup property. */
export function zeroRollupProps(): Record<string, number> {
  return Object.fromEntries(DEAL_ROLLUP_PROPS.map((p) => [p.name, 0]));
}

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
  /** Pipeline createdate ceiling: Nov 1 of the current year (deals created
   * later can't realistically convert in-year — median win cycle 32 days). */
  pipelineCreateCeilingMs: number;
  /** Pipeline freshness floor: now − 180 days (85.6% of wins land within 180
   * days of quote creation; older open deals are overwhelmingly slow losses). */
  pipelineFreshFloorMs: number;
}

const DAY_MS = 86_400_000;
export const PIPELINE_FRESH_DAYS = 180;

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
    pipelineCreateCeilingMs: Date.UTC(y, 10, 1),
    pipelineFreshFloorMs: nowMs - PIPELINE_FRESH_DAYS * DAY_MS,
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
    if (!writes.has(id)) writes.set(id, zeroRollupProps());
  }
  return writes;
}

// --- extended rollups (lost / pipeline / projection) -------------------------

export interface LostRollupDeal {
  companyId: string;
  closedateMs: number | null;
  /** Lost value = max_amount (Davis convention), falling back to amount. */
  maxAmount: unknown;
  amount: unknown;
  createdateMs: number | null;
}

export interface OpenRollupDeal {
  companyId: string;
  createdateMs: number | null;
  amount: unknown;
}

export interface WonRollupDeal extends RollupDeal {
  createdateMs: number | null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const lostValue = (d: { maxAmount: unknown; amount: unknown }): number | null =>
  num(d.maxAmount) ?? num(d.amount);

const sameUtcDay = (a: number | null, b: number | null): boolean =>
  a !== null && b !== null && Math.floor(a / DAY_MS) === Math.floor(b / DAY_MS);

/**
 * Same-day-adjusted YTD value hit rate: won / (won + lost), current-year
 * closes only, EXCLUDING deals closed the same UTC day they were created
 * (retroactive quote entries — the order existed before the quote, so they
 * carry no pipeline-conversion information). Lost valued at max_amount.
 * null when there's no resolved value to rate against.
 */
export function adjustedValueHitRate(
  won: WonRollupDeal[],
  lost: LostRollupDeal[],
  w: DealRollupWindows,
): number | null {
  let wonSum = 0;
  let lostSum = 0;
  for (const d of won) {
    if (d.closedateMs === null || d.closedateMs < w.ytdStartMs || d.closedateMs > w.nowMs) continue;
    if (sameUtcDay(d.closedateMs, d.createdateMs)) continue;
    wonSum += num(d.amount) ?? 0;
  }
  for (const d of lost) {
    if (d.closedateMs === null || d.closedateMs < w.ytdStartMs || d.closedateMs > w.nowMs) continue;
    if (sameUtcDay(d.closedateMs, d.createdateMs)) continue;
    lostSum += lostValue(d) ?? 0;
  }
  const denom = wonSum + lostSum;
  return denom > 0 ? wonSum / denom : null;
}

// --- future deal creation (seasonality-weighted) ------------------------------

export interface CreationCohortDeal {
  createdateMs: number | null;
  closedateMs: number | null;
  won: boolean;
  /** Current stage is Pre-Qualified (excluded from pipeline-yield bases). */
  preQualified?: boolean;
  amount: unknown;
  /** Creation value = max_amount fallback amount (amount decays on lost deals). */
  maxAmount: unknown;
}

/**
 * In-year pipeline yield, measured on the snapshot exactly one year back
 * (rolling, day-anchored — per Davis 2026-07-13: freshest measurable data,
 * seasonality built in because the reference always has the same remaining
 * runway): of the fresh open pipeline at `snapshotMs` (created within the
 * fresh window, not closed before the snapshot, not Pre-Qualified now), the
 * fraction (by value) won before `yearEndMs`. Base valued at max_amount∥amount;
 * wins at amount. null when the base is empty.
 */
export function pipelineInYearYield(
  cohort: CreationCohortDeal[],
  snapshotMs: number,
  yearEndMs: number,
): { base: number; wins: number; yield: number | null } {
  const freshFloor = snapshotMs - PIPELINE_FRESH_DAYS * DAY_MS;
  let base = 0;
  let wins = 0;
  for (const d of cohort) {
    if (d.createdateMs === null || d.createdateMs < freshFloor || d.createdateMs >= snapshotMs) continue;
    if (d.closedateMs !== null && d.closedateMs < snapshotMs) continue;
    if (d.preQualified) continue;
    base += lostValue({ maxAmount: d.maxAmount, amount: d.amount }) ?? 0;
    if (d.won && d.closedateMs !== null && d.closedateMs < yearEndMs) wins += num(d.amount) ?? 0;
  }
  return { base, wins, yield: base > 0 ? wins / base : null };
}

export interface CreationSeasonality {
  /** Value WON in-year from deals CREATED in each calendar month (index 0-11).
   * Encodes both the seasonal creation pattern (a slow month creates little)
   * and the shrinking runway (a December deal rarely closes by New Year's). */
  winsByCreationMonth: number[];
  /** Creation value (max_amount∥amount) per creation month — the YoY basis. */
  creationValueByMonth: number[];
}

/** Build the prior-year cohort curve: deals created in `year`, their creation
 * value by month, and the value they won within that same calendar year. */
export function creationSeasonality(deals: CreationCohortDeal[], year: number): CreationSeasonality {
  const winsByCreationMonth = Array(12).fill(0) as number[];
  const creationValueByMonth = Array(12).fill(0) as number[];
  const yearStart = Date.UTC(year, 0, 1);
  const yearEnd = Date.UTC(year + 1, 0, 1);
  for (const d of deals) {
    if (d.createdateMs === null || d.createdateMs < yearStart || d.createdateMs >= yearEnd) continue;
    const m = new Date(d.createdateMs).getUTCMonth();
    creationValueByMonth[m]! += lostValue({ maxAmount: d.maxAmount, amount: d.amount }) ?? 0;
    if (d.won && d.closedateMs !== null && d.closedateMs < yearEnd) {
      winsByCreationMonth[m]! += num(d.amount) ?? 0;
    }
  }
  return { winsByCreationMonth, creationValueByMonth };
}

/** Creation value (max_amount∥amount) of deals created in [startMs, endMs). */
export function creationValueInWindow(
  deals: { createdateMs: number | null; amount: unknown; maxAmount: unknown }[],
  startMs: number,
  endMs: number,
): number {
  let sum = 0;
  for (const d of deals) {
    if (d.createdateMs === null || d.createdateMs < startMs || d.createdateMs >= endMs) continue;
    sum += lostValue({ maxAmount: d.maxAmount, amount: d.amount }) ?? 0;
  }
  return sum;
}

/**
 * Expected in-year wins from deals NOT YET CREATED: the prior-year curve's
 * remaining months (current month prorated by days left), scaled by this
 * year's creation pace vs the same window last year. No hit-rate multiply —
 * the curve is realized wins, its own conversion already baked in.
 */
export function expectedFutureCreationWins(
  s: CreationSeasonality,
  nowMs: number,
  yoyFactor: number,
): number {
  const d = new Date(nowMs);
  const m = d.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), m + 1, 0)).getUTCDate();
  const fracRemaining = (daysInMonth - d.getUTCDate()) / daysInMonth;
  let sum = s.winsByCreationMonth[m]! * fracRemaining;
  for (let k = m + 1; k < 12; k++) sum += s.winsByCreationMonth[k]!;
  return sum * yoyFactor;
}

export interface ExtendedRollupRates {
  /** In-year pipeline yield (pipelineInYearYield, rolling year-back snapshot);
   * null → pipeline writes 0. */
  pipelineYield: number | null;
  /** Global quote visibility — prior FULL YEAR basis (FY quote wins / FY
   * sales), which backtests exactly where the YTD basis under-projects;
   * null → projection writes 0. */
  visibilityRate: number | null;
}

/**
 * All rollup properties per company. Won buckets keep their original
 * semantics (every win counts — only the RATES exclude same-day closes).
 * Pipeline: open deals (already stage-filtered by the caller) created within
 * [freshFloor, createCeiling], valued at amount × hitRate. Creation: the
 * caller-distributed share of expected in-year wins from not-yet-created
 * deals (seasonality curve × YoY pace). Projection:
 * (YTD won + pipeline + creation) / visibilityRate — the quote channel's
 * implied sales. Every touched company gets ALL properties (0-filled) so
 * writes never leave a property partially stale.
 */
export function aggregateExtendedRollups(
  input: {
    won: WonRollupDeal[];
    lost: LostRollupDeal[];
    open: OpenRollupDeal[];
    /** companyId → its share of expectedFutureCreationWins (pre-distributed). */
    creationByCompany?: Map<string, number>;
  },
  w: DealRollupWindows,
  rates: ExtendedRollupRates,
): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  const props = (companyId: string): Record<string, number> => {
    let p = out.get(companyId);
    if (!p) {
      p = zeroRollupProps();
      out.set(companyId, p);
    }
    return p;
  };
  for (const d of input.won) {
    if (d.closedateMs === null) continue;
    const amt = num(d.amount);
    if (amt === null) continue;
    const p = props(d.companyId);
    const t = d.closedateMs;
    if (t >= w.ytdStartMs && t <= w.nowMs) p[ROLLUP_PROP_YTD]! += amt;
    if (t >= w.priorStartMs && t < w.priorYtdEndMs) p[ROLLUP_PROP_PRIOR_YTD]! += amt;
    if (t >= w.priorStartMs && t < w.priorYearEndMs) p[ROLLUP_PROP_PRIOR_YEAR]! += amt;
  }
  for (const d of input.lost) {
    if (d.closedateMs === null || d.closedateMs < w.ytdStartMs || d.closedateMs > w.nowMs) continue;
    const v = lostValue(d);
    if (v === null) continue;
    props(d.companyId)[ROLLUP_PROP_YTD_LOST]! += v;
  }
  for (const d of input.open) {
    if (d.createdateMs === null) continue;
    if (d.createdateMs < w.pipelineFreshFloorMs || d.createdateMs >= w.pipelineCreateCeilingMs) continue;
    const amt = num(d.amount);
    if (amt === null) continue;
    props(d.companyId)[ROLLUP_PROP_PIPELINE]! += amt * (rates.pipelineYield ?? 0);
  }
  for (const [companyId, share] of input.creationByCompany ?? []) {
    if (share > 0) props(companyId)[ROLLUP_PROP_CREATION]! += share;
  }
  for (const p of out.values()) {
    p[ROLLUP_PROP_PROJECTED] = rates.visibilityRate
      ? (p[ROLLUP_PROP_YTD]! + p[ROLLUP_PROP_PIPELINE]! + p[ROLLUP_PROP_CREATION]!) / rates.visibilityRate
      : 0;
    for (const k of Object.keys(p)) p[k] = round2(p[k]!);
  }
  return out;
}
