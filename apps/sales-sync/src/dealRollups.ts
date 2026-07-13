import {
  DEAL_ROLLUP_PROPS,
  DEAL_STAGE_IDS,
  UNIVERSAL_PIPELINE_ID,
  adjustedValueHitRate,
  aggregateExtendedRollups,
  buildRollupWrites,
  creationSeasonality,
  dealRollupWindows,
  pipelineInYearYield,
  expectedFutureCreationWins,
  lostValue,
  pickRollupCompanyId,
  toEpochMs,
  type DealCompanyAssoc,
} from "@wac/shared";
import { ensureProperties, existingCompanyProperties, hs, sleep, updateCompanies } from "./hubspot.js";

/**
 * --deal-rollups — roll closed-won deal value up onto Companies as
 * "YTD Won Deals" / "YTD Prior Year Deals" / "Prior Year Deals".
 *
 * Scope: Universal Pipeline, Closed Won, deal has sap_quote_number. Each deal
 * is credited to its PRIMARY company only (Specifier associations must not be
 * credited). Companies that held a value last run but dropped out of the
 * aggregate are zeroed, so Jan-1 rollover and deal edits self-correct.
 * Bucketing logic lives in @wac/shared (dealRollups.ts) with tests.
 */

const SEARCH_PAGE = 200; // HubSpot search max page size
const ASSOC_BATCH = 500;
const INTER_BATCH_MS = 250;

interface SearchPage {
  results: { id: string; properties: Record<string, string | null> }[];
}

type SearchFilter = { propertyName: string; operator: string; value?: string; values?: string[] };

/** Page SAP deals in the Universal Pipeline matching extra filters,
 * GT-windowing on hs_object_id (no 10k cap). */
async function* iterDeals(
  token: string,
  extraFilters: SearchFilter[],
  properties: string[],
): AsyncGenerator<{ id: string; properties: Record<string, string | null> }> {
  let lastId = "0";
  while (true) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: "pipeline", operator: "EQ", value: UNIVERSAL_PIPELINE_ID },
            { propertyName: "sap_quote_number", operator: "HAS_PROPERTY" },
            ...extraFilters,
            { propertyName: "hs_object_id", operator: "GT", value: lastId },
          ],
        },
      ],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      properties,
      limit: SEARCH_PAGE,
    };
    const data = await hs<SearchPage>(token, "/crm/v3/objects/deals/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!data.results.length) break;
    for (const d of data.results) yield d;
    lastId = data.results[data.results.length - 1]!.id;
    if (data.results.length < SEARCH_PAGE) break;
    await sleep(INTER_BATCH_MS);
  }
}

/** Global Σ of a numeric company property (Power BI-fed sales props). */
async function sumGlobalCompanyProp(token: string, prop: string): Promise<number> {
  let sum = 0;
  let lastId = "0";
  while (true) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: prop, operator: "GT", value: "0" },
            { propertyName: "hs_object_id", operator: "GT", value: lastId },
          ],
        },
      ],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      properties: [prop],
      limit: SEARCH_PAGE,
    };
    const data = await hs<SearchPage>(token, "/crm/v3/objects/companies/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!data.results.length) break;
    for (const c of data.results) sum += Number(c.properties[prop]) || 0;
    lastId = data.results[data.results.length - 1]!.id;
    if (data.results.length < SEARCH_PAGE) break;
    await sleep(INTER_BATCH_MS);
  }
  return sum;
}

const sumGlobalYtdSales = (token: string) => sumGlobalCompanyProp(token, "ytd_sales");

interface AssocReadResult {
  results?: {
    from?: { id?: string | number };
    to?: { toObjectId?: string | number; associationTypes?: { typeId?: number }[] }[];
    paging?: { next?: { after?: string } };
  }[];
}

/** Company associations per deal (v4 batch read + per-deal paging). */
async function fetchCompanyAssocsByDeal(token: string, dealIds: string[]): Promise<Map<string, DealCompanyAssoc[]>> {
  const byDeal = new Map<string, DealCompanyAssoc[]>();
  for (let i = 0; i < dealIds.length; i += ASSOC_BATCH) {
    const chunk = dealIds.slice(i, i + ASSOC_BATCH);
    const res = await hs<AssocReadResult>(token, "/crm/v4/associations/deals/companies/batch/read", {
      method: "POST",
      body: JSON.stringify({ inputs: chunk.map((id) => ({ id })) }),
    });
    for (const r of res.results ?? []) {
      const dealId = String(r.from?.id ?? "");
      if (!dealId) continue;
      const assocs = byDeal.get(dealId) ?? [];
      const push = (to: { toObjectId?: string | number; associationTypes?: { typeId?: number }[] }) => {
        if (to.toObjectId == null) return;
        assocs.push({
          companyId: String(to.toObjectId),
          typeIds: (to.associationTypes ?? []).map((t) => Number(t.typeId)).filter((n) => Number.isFinite(n)),
        });
      };
      for (const t of r.to ?? []) push(t);
      byDeal.set(dealId, assocs);
      // >500-company deals are unheard of, but follow the cursor anyway.
      let after = r.paging?.next?.after;
      while (after) {
        const page = await hs<{ results?: any[]; paging?: { next?: { after?: string } } }>(
          token,
          `/crm/v4/objects/deals/${dealId}/associations/companies?limit=500&after=${encodeURIComponent(after)}`,
        );
        for (const t of page.results ?? []) push(t);
        after = page.paging?.next?.after;
      }
    }
    if (i + ASSOC_BATCH < dealIds.length) await sleep(INTER_BATCH_MS);
  }
  return byDeal;
}

/** Ids of companies carrying a NONZERO rollup value. GT 0, not HAS_PROPERTY:
 * already-zeroed companies would otherwise count as "stale" and be rewritten
 * 0 on every run (amounts are never negative, so GT 0 loses nothing). */
async function companiesWithRollupValues(token: string): Promise<Set<string>> {
  const ids = new Set<string>();
  // HubSpot search caps filterGroups at 5 — chunk the per-property OR groups.
  for (let g = 0; g < DEAL_ROLLUP_PROPS.length; g += 5) {
    const propChunk = DEAL_ROLLUP_PROPS.slice(g, g + 5);
    let lastId = "0";
    while (true) {
      const body = {
        filterGroups: propChunk.map((p) => ({
          filters: [
            { propertyName: p.name, operator: "GT", value: "0" },
            { propertyName: "hs_object_id", operator: "GT", value: lastId },
          ],
        })),
        sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
        properties: ["hs_object_id"],
        limit: SEARCH_PAGE,
      };
      const data = await hs<SearchPage>(token, "/crm/v3/objects/companies/search", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!data.results.length) break;
      for (const c of data.results) ids.add(c.id);
      lastId = data.results[data.results.length - 1]!.id;
      if (data.results.length < SEARCH_PAGE) break;
      await sleep(INTER_BATCH_MS);
    }
  }
  return ids;
}

export interface DealRollupOptions {
  token: string;
  dryRun: boolean;
  /** Cap on deals scanned (sampling); omit for the full sweep. */
  limit?: number;
}

export async function runDealRollups({ token, dryRun, limit }: DealRollupOptions): Promise<void> {
  const windows = dealRollupWindows(Date.now());
  const tag = dryRun ? " DRY RUN" : "";

  // 1. Three sweeps: won (prior-year window for the YoY buckets), lost
  //    (current-year closes, valued at max_amount), open pipeline (stage not
  //    won/lost/pre-qualified, created within the winnable window).
  const won: { id: string; amount: string | null; closedateMs: number | null; createdateMs: number | null }[] = [];
  for await (const d of iterDeals(
    token,
    [
      { propertyName: "dealstage", operator: "EQ", value: DEAL_STAGE_IDS.closedWon },
      { propertyName: "closedate", operator: "GTE", value: String(windows.priorStartMs) },
    ],
    ["amount", "closedate", "createdate"],
  )) {
    won.push({ id: d.id, amount: d.properties.amount ?? null, closedateMs: toEpochMs(d.properties.closedate), createdateMs: toEpochMs(d.properties.createdate) });
    if (limit && won.length >= limit) break;
  }
  const lost: { id: string; amount: string | null; maxAmount: string | null; closedateMs: number | null; createdateMs: number | null }[] = [];
  for await (const d of iterDeals(
    token,
    [
      { propertyName: "dealstage", operator: "EQ", value: DEAL_STAGE_IDS.closedLost },
      // Trailing 12 months (not just YTD): the TTM hit rate needs last
      // year's closes; the YTD-lost bucket still windows on ytdStartMs.
      { propertyName: "closedate", operator: "GTE", value: String(windows.nowMs - 365 * 86_400_000) },
    ],
    ["amount", "max_amount", "closedate", "createdate"],
  )) {
    lost.push({ id: d.id, amount: d.properties.amount ?? null, maxAmount: d.properties["max_amount"] ?? null, closedateMs: toEpochMs(d.properties.closedate), createdateMs: toEpochMs(d.properties.createdate) });
    if (limit && lost.length >= limit) break;
  }
  const open: { id: string; amount: string | null; createdateMs: number | null }[] = [];
  for await (const d of iterDeals(
    token,
    [
      {
        propertyName: "dealstage",
        operator: "NOT_IN",
        values: [DEAL_STAGE_IDS.closedWon, DEAL_STAGE_IDS.closedLost, DEAL_STAGE_IDS.prequal],
      },
      { propertyName: "createdate", operator: "GTE", value: String(windows.pipelineFreshFloorMs) },
      { propertyName: "createdate", operator: "LT", value: String(windows.pipelineCreateCeilingMs) },
    ],
    ["amount", "createdate"],
  )) {
    open.push({ id: d.id, amount: d.properties.amount ?? null, createdateMs: toEpochMs(d.properties.createdate) });
    if (limit && open.length >= limit) break;
  }

  // 1b. Creation cohorts for the future-creation component: last year's full
  //     cohort (the seasonality curve) and this year's creations (YoY pace +
  //     per-company distribution of the expected future wins).
  const priorYear = new Date(windows.nowMs).getUTCFullYear() - 1;
  // Two years back: the rolling year-ago pipeline snapshot's 180-day fresh
  // window reaches into the year before last on early-calendar runs.
  const twoYearsBackMs = Date.UTC(priorYear - 1, 0, 1);
  const priorCohort: { createdateMs: number | null; closedateMs: number | null; won: boolean; preQualified: boolean; amount: string | null; maxAmount: string | null }[] = [];
  for await (const d of iterDeals(
    token,
    [
      { propertyName: "createdate", operator: "GTE", value: String(twoYearsBackMs) },
      { propertyName: "createdate", operator: "LT", value: String(windows.ytdStartMs) },
    ],
    ["createdate", "closedate", "dealstage", "amount", "max_amount"],
  )) {
    priorCohort.push({
      createdateMs: toEpochMs(d.properties.createdate),
      closedateMs: toEpochMs(d.properties.closedate),
      won: d.properties.dealstage === DEAL_STAGE_IDS.closedWon,
      preQualified: d.properties.dealstage === DEAL_STAGE_IDS.prequal,
      amount: d.properties.amount ?? null,
      maxAmount: d.properties["max_amount"] ?? null,
    });
    if (limit && priorCohort.length >= limit) break;
  }
  const thisCohort: { id: string; createdateMs: number | null; amount: string | null; maxAmount: string | null }[] = [];
  for await (const d of iterDeals(
    token,
    [{ propertyName: "createdate", operator: "GTE", value: String(windows.ytdStartMs) }],
    ["createdate", "amount", "max_amount"],
  )) {
    thisCohort.push({
      id: d.id,
      createdateMs: toEpochMs(d.properties.createdate),
      amount: d.properties.amount ?? null,
      maxAmount: d.properties["max_amount"] ?? null,
    });
    if (limit && thisCohort.length >= limit) break;
  }

  // 2. Attribute each deal to its primary company.
  const allIds = [...new Set([...won, ...lost, ...open, ...thisCohort].map((d) => d.id))];
  const assocsByDeal = await fetchCompanyAssocsByDeal(token, allIds);
  let skippedNoCompany = 0;
  const attribute = <T extends { id: string }>(ds: T[]): (T & { companyId: string })[] => {
    const out: (T & { companyId: string })[] = [];
    for (const d of ds) {
      const companyId = pickRollupCompanyId(assocsByDeal.get(d.id) ?? []);
      if (!companyId) {
        skippedNoCompany++;
        continue;
      }
      out.push({ ...d, companyId });
    }
    return out;
  };
  const wonRows = attribute(won);
  const lostRows = attribute(lost);
  const openRows = attribute(open);
  const creationRows = attribute(thisCohort);

  // 3. Daily global rates + future-creation expectation, then aggregate.
  const ttmStartMs = windows.nowMs - 365 * 86_400_000;
  const hitRate = adjustedValueHitRate(wonRows, lostRows, ttmStartMs, windows.nowMs);
  const ytdSales = await sumGlobalYtdSales(token);
  const ytdWonGlobal = wonRows.reduce(
    (s, d) => s + (d.closedateMs !== null && d.closedateMs >= windows.ytdStartMs ? Number(d.amount) || 0 : 0),
    0,
  );

  // Rolling year-back pipeline snapshot (same day-of-year, completed year)
  // supplies the in-year TIMING factor; the fresh TTM hit rate supplies the
  // win propensity. Effective pipeline yield = hitRate(TTM) × timing.
  const snapshotMs = windows.priorYtdEndMs - 86_400_000;
  const yieldRes = pipelineInYearYield(priorCohort, snapshotMs, windows.priorYearEndMs);
  const pipelineYield =
    hitRate !== null && yieldRes.timing !== null ? hitRate * yieldRes.timing : yieldRes.yield;

  // Visibility on the prior FULL-YEAR basis: FY quote wins / FY sales
  // (previous_year_sales is the Power BI-fed company property).
  const priorFyWins = wonRows.reduce(
    (s, d) => s + (d.closedateMs !== null && d.closedateMs >= windows.priorStartMs && d.closedateMs < windows.priorYearEndMs ? Number(d.amount) || 0 : 0),
    0,
  );
  const priorFySales = await sumGlobalCompanyProp(token, "previous_year_sales");
  const visibilityRate = priorFySales > 0 && priorFyWins > 0 ? priorFyWins / priorFySales : null;

  // YoY creation pace by COUNT of deals created (value ratios are poisoned by
  // valuation asymmetry: recent deals carry rich max_amount while older
  // cohorts' amounts have decayed — observed 2026-07-13 as a spurious x4).
  const seasonality = creationSeasonality(priorCohort, priorYear);
  const thisYtdCount = thisCohort.filter((d) => d.createdateMs !== null && d.createdateMs >= windows.ytdStartMs && d.createdateMs <= windows.nowMs).length;
  const priorSameWindowCount = priorCohort.filter((d) => d.createdateMs !== null && d.createdateMs >= windows.priorStartMs && d.createdateMs < windows.priorYtdEndMs).length;
  const yoyFactor = priorSameWindowCount > 0 && thisYtdCount > 0 ? thisYtdCount / priorSameWindowCount : 1;
  const futureCreationGlobal = expectedFutureCreationWins(seasonality, windows.nowMs, yoyFactor);

  // Distribute the global expectation by each company's YTD creation share.
  const creationByCompanyValue = new Map<string, number>();
  let creationTotal = 0;
  for (const d of creationRows) {
    const v = lostValue({ maxAmount: d.maxAmount, amount: d.amount }) ?? 0;
    if (v <= 0) continue;
    creationByCompanyValue.set(d.companyId, (creationByCompanyValue.get(d.companyId) ?? 0) + v);
    creationTotal += v;
  }
  const creationByCompany = new Map<string, number>();
  if (creationTotal > 0 && futureCreationGlobal > 0) {
    for (const [companyId, v] of creationByCompanyValue) {
      creationByCompany.set(companyId, (v / creationTotal) * futureCreationGlobal);
    }
  }

  console.log(
    `[sales-sync] deal-rollups${tag}: pipeline yield = ${pipelineYield === null ? "n/a" : (pipelineYield * 100).toFixed(2) + "%"} ` +
      `= TTM hit rate ${hitRate === null ? "n/a" : (hitRate * 100).toFixed(2) + "%"} × in-year timing ${yieldRes.timing === null ? "n/a" : (yieldRes.timing * 100).toFixed(2) + "%"} ` +
      `(year-back snapshot: base $${Math.round(yieldRes.base).toLocaleString("en-US")}, in-year wins $${Math.round(yieldRes.wins).toLocaleString("en-US")}, eventual $${Math.round(yieldRes.eventualWins).toLocaleString("en-US")}) | ` +
      `visibility (prior FY) = ${visibilityRate === null ? "n/a" : (visibilityRate * 100).toFixed(2) + "%"} ($${Math.round(priorFyWins).toLocaleString("en-US")} / $${Math.round(priorFySales).toLocaleString("en-US")}) | ` +
      `YTD won $${Math.round(ytdWonGlobal).toLocaleString("en-US")} / YTD sales $${Math.round(ytdSales).toLocaleString("en-US")}`,
  );
  console.log(
    `[sales-sync] deal-rollups${tag}: future creation = $${Math.round(futureCreationGlobal).toLocaleString("en-US")} ` +
      `(YoY creation pace ×${yoyFactor.toFixed(3)} by count: YTD ${thisYtdCount} vs prior-YTD ${priorSameWindowCount}; ` +
      `${priorYear} cohort in-year wins $${Math.round(seasonality.winsByCreationMonth.reduce((a, b) => a + b, 0)).toLocaleString("en-US")})`,
  );
  const fresh = aggregateExtendedRollups({ won: wonRows, lost: lostRows, open: openRows, creationByCompany }, windows, { pipelineYield, visibilityRate });
  const deals = { length: won.length + lost.length + open.length + priorCohort.length + thisCohort.length };
  const rows = { length: wonRows.length + lostRows.length + openRows.length + creationRows.length };

  // 4/5. Ensure properties, zero out companies that dropped out, write.
  // In dry-run the stale scan still runs when the properties already exist,
  // so the would-zero count is accurate; on a true first run there is nothing
  // to scan (searching an unknown property would 400).
  const have = await existingCompanyProperties(token);
  const propsExist = DEAL_ROLLUP_PROPS.every((p) => have.has(p.name));
  if (!dryRun && !propsExist) await ensureProperties(token, DEAL_ROLLUP_PROPS);
  const existingIds = propsExist ? await companiesWithRollupValues(token) : new Set<string>();
  const writes = buildRollupWrites(fresh, existingIds);
  const zeroed = writes.size - fresh.size;

  console.log(
    `[sales-sync] deal-rollups${tag}: scanned ${deals.length} deals, attributed ${rows.length} ` +
      `(skipped ${skippedNoCompany} without a single/primary company), ` +
      `${fresh.size} companies with totals, ${zeroed} stale to zero.`,
  );
  if (dryRun) {
    console.log(`[sales-sync] deal-rollups DRY RUN sample:`, [...fresh.entries()].slice(0, 5));
    return;
  }
  const updated = await updateCompanies(token, writes);
  console.log(`[sales-sync] deal-rollups: updated ${updated} companies (${DEAL_ROLLUP_PROPS.map((p) => p.name).join(", ")}).`);
}
