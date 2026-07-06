import {
  DEAL_ROLLUP_PROPS,
  DEAL_STAGE_IDS,
  UNIVERSAL_PIPELINE_ID,
  aggregateDealRollups,
  buildRollupWrites,
  dealRollupWindows,
  pickRollupCompanyId,
  toEpochMs,
  type DealCompanyAssoc,
  type RollupDeal,
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

/** Page qualifying closed-won deals, GT-windowing on hs_object_id (no 10k cap). */
async function* iterQualifyingDeals(
  token: string,
  minClosedateMs: number,
): AsyncGenerator<{ id: string; properties: Record<string, string | null> }> {
  let lastId = "0";
  while (true) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: "pipeline", operator: "EQ", value: UNIVERSAL_PIPELINE_ID },
            { propertyName: "dealstage", operator: "EQ", value: DEAL_STAGE_IDS.closedWon },
            { propertyName: "sap_quote_number", operator: "HAS_PROPERTY" },
            { propertyName: "closedate", operator: "GTE", value: String(minClosedateMs) },
            { propertyName: "hs_object_id", operator: "GT", value: lastId },
          ],
        },
      ],
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      properties: ["amount", "closedate"],
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

/** Ids of companies that already carry any of the rollup properties. */
async function companiesWithRollupValues(token: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let lastId = "0";
  while (true) {
    const body = {
      filterGroups: DEAL_ROLLUP_PROPS.map((p) => ({
        filters: [
          { propertyName: p.name, operator: "HAS_PROPERTY" },
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

  // 1. Sweep qualifying deals.
  const deals: { id: string; amount: string | null; closedateMs: number | null }[] = [];
  for await (const d of iterQualifyingDeals(token, windows.priorStartMs)) {
    deals.push({ id: d.id, amount: d.properties.amount ?? null, closedateMs: toEpochMs(d.properties.closedate) });
    if (limit && deals.length >= limit) break;
  }

  // 2. Attribute each deal to its primary company.
  const assocsByDeal = await fetchCompanyAssocsByDeal(token, deals.map((d) => d.id));
  const rows: RollupDeal[] = [];
  let skippedNoCompany = 0;
  for (const d of deals) {
    const companyId = pickRollupCompanyId(assocsByDeal.get(d.id) ?? []);
    if (!companyId) {
      skippedNoCompany++;
      continue;
    }
    rows.push({ companyId, closedateMs: d.closedateMs, amount: d.amount });
  }

  // 3. Aggregate into the three buckets.
  const fresh = aggregateDealRollups(rows, windows);

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
