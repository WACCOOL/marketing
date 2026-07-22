/**
 * Data-source bucketing for the analytics page: maps thom_source_usage's raw
 * keys (citation doc_types + tool names) onto the human buckets Davis asked
 * for — web scrape, PIM, HubSpot, Zendesk, etc. Pure + tested; unknown keys
 * fall into "Other" rather than disappearing.
 */

export interface SourceUsageRow {
  kind: "doc" | "tool";
  key: string;
  hits: number;
}

export interface SourceBucket {
  source: string;
  hits: number;
}

const DOC_BUCKETS: [RegExp, string][] = [
  [/^(spec_sheet|manual)$/, "Spec sheets & manuals (PIM)"],
  [/^marketing$/, "Thom Knowledge (curated)"],
  [/^zendesk_article$/, "Help Center (Zendesk)"],
  [/^zendesk_ticket$/, "Support tickets (Zendesk)"],
  [/^web_/, "Website crawl"],
  // Admin-uploaded education PDFs (lighting-expert plan, Prong C).
  [/^education$/, "Education library (uploads)"],
];

const TOOL_BUCKETS: [RegExp, string][] = [
  [/^(search_products|get_product|get_related_products|get_family|rank_products_by_spec|filter_products)$/, "Product catalog (PIM)"],
  // Category-sales rollups read the Supabase warehouse (turnover/open orders),
  // not HubSpot — bucketed BEFORE the crm_ catch-all so the dashboard doesn't
  // misattribute them (category-sales plan §D, the 0059 A10 lesson).
  [/^crm_sales_by_category$/, "Sales warehouse (category rollups)"],
  [/^crm_/, "HubSpot CRM"],
  [/^(get_photometrics|lighting_requirement)$/, "Photometrics (IES)"],
  [/^plan_layout$/, "Layout planner"],
  [/^web_search$/, "Open web search"],
  // search_docs itself is retrieval plumbing — its RESULTS are already counted
  // through the citation doc_types above, so the call doesn't double-count.
  [/^search_docs$/, ""],
];

/** Roll raw usage rows into ranked, deduplicated source buckets. */
export function bucketSourceUsage(rows: SourceUsageRow[]): SourceBucket[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const table = r.kind === "doc" ? DOC_BUCKETS : TOOL_BUCKETS;
    const match = table.find(([re]) => re.test(r.key));
    const bucket = match ? match[1] : `Other (${r.key})`;
    if (!bucket) continue; // deliberately skipped (search_docs plumbing)
    counts.set(bucket, (counts.get(bucket) ?? 0) + Number(r.hits));
  }
  return [...counts.entries()]
    .map(([source, hits]) => ({ source, hits }))
    .sort((a, b) => b.hits - a.hits || (a.source < b.source ? -1 : 1));
}
