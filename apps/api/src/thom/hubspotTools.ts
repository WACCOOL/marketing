// =============================================================================
// INTERNAL SURFACE ONLY — never include HUBSPOT_TOOLS on the public Thom tool
// set. These tools read live HubSpot CRM data (companies, deals/quotes, open
// orders, invoice/turnover history, rep codes) and must only ever be offered to
// authenticated internal/admin users. agent.ts composes them onto the tool list
// solely when HUBSPOT_READ_TOKEN is configured; prompts.ts advertises them only
// inside internalSystem().
// =============================================================================

/**
 * Thom's read-only HubSpot CRM tools.
 *
 * Everything here is READ-ONLY: the only credential used is
 * env.HUBSPOT_READ_TOKEN, a deliberately write-incapable private app (see
 * env.ts). The @wac/shared read helpers (searchAll / getById / batchRead /
 * existingProperties) all opt into retryTransient, so no write path is
 * reachable from this module no matter what a bug or an injected instruction
 * asks for.
 *
 * Schema is the one discovered by the sync apps (apps/turnover-sync,
 * apps/open-orders-sync) and @wac/shared/hubspot: companies key on the
 * account_number_ property (stored padded OR stripped — always query every
 * accountForms() variant); deals live in object 0-3 / the Universal Pipeline
 * and link to a company only by association; open orders + invoiced/turnover
 * orders share the `orders` object, discriminated by hs_pipeline (open) vs a
 * populated billing_document (invoiced); rep codes are custom object
 * 2-41537429 keyed on rep_code.
 *
 * Output is text-only (no cards/citations) and row-capped so a broad account
 * never dumps thousands of rows into the model.
 */

import {
  accountForms,
  batchRead,
  existingProperties,
  getById,
  searchAll,
  type HsObject,
  type HsSearchFilter,
  DEAL_STAGE_IDS,
  STAGE_LABELS,
  REP_CODE_OBJECT,
} from "@wac/shared";
import type { ClaudeTool } from "../anthropic.js";
import type { ToolContext, ToolOutput } from "./types.js";

// --- object types / pipelines -----------------------------------------------

const DEAL_OBJECT = "0-3";
const ORDER_OBJECT = "orders";
const OPEN_ORDERS_PIPELINE = "909519998";

// Closed stages exclude a deal from an "open only" view.
const CLOSED_STAGES = new Set<string>([DEAL_STAGE_IDS.closedWon, DEAL_STAGE_IDS.closedLost]);

// --- property lists ----------------------------------------------------------

const COMPANY_PROPS = [
  "name",
  "account_number_",
  "product_brand",
  "ytd_sales",
  "previous_year_sales",
  "prior_ytd_sales",
  "ytd_sales_yoy_pct",
  "ytd_won_deals",
] as const;

const DEAL_PROPS = [
  "dealname",
  "sap_quote_number",
  "sales_group",
  "amount",
  "dealstage",
  "pipeline",
  "stage_of_project",
  "closedate",
  "createdate",
] as const;

const OPEN_ORDER_PROPS = [
  "sales_order_id",
  "po_number",
  "po_date",
  "customer_account",
  "customer_name",
  "amt_rep",
  "sales_group",
  "sales_territory",
  "channel",
  "hs_total_price",
  "hs_pipeline",
  "risk_code",
  "credit_status",
  "delivery_number",
  "date_of_delivery",
] as const;

const INVOICE_PROPS = [
  "billing_document",
  "billing_date",
  "brand",
  "quotation_ref",
  "rep_codes",
  "customer_account",
  "customer_name",
  "hs_total_price",
  "sales_group",
  "channel",
  "hs_currency_code",
] as const;

// rep_code/account/channel/region/hubspot_owner_id are known-stable; the
// label-resolved ones (agency/city/brands/state/status) may or may not exist on
// the object — existingProperties() intersects them before we ask.
const REP_PROPS = [
  "rep_code",
  "account",
  "channel",
  "region",
  "hubspot_owner_id",
  "agency",
  "city",
  "brands",
  "state",
  "status",
] as const;

// Row caps — a broad account can carry thousands of orders; never dump them all.
const CAP_COMPANIES = 5;
const CAP_DEALS = 20;
const CAP_ORDERS = 25;

// --- tool schemas ------------------------------------------------------------

export const HUBSPOT_TOOLS: ClaudeTool[] = [
  {
    name: "crm_search_companies",
    description:
      "Internal CRM data (read-only): find a customer COMPANY/account in HubSpot by name or SAP account number. Returns matching companies with their account number, brand, and id. Use this FIRST to resolve which account the user means, then call the other crm_* tools with that account number or company id.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Company name (or part of it) to search for." },
        account_number: { type: "string", description: "SAP account number (padded or stripped both work)." },
        limit: { type: "integer", description: `Max results (default ${CAP_COMPANIES}).` },
      },
    },
  },
  {
    name: "crm_get_company",
    description:
      "Internal CRM data (read-only): full detail + sales rollups for ONE company/account — YTD sales, prior-year sales, YoY %, and won-deal totals. Identify it by account_number or company_id (get the id from crm_search_companies).",
    input_schema: {
      type: "object",
      properties: {
        account_number: { type: "string", description: "SAP account number." },
        company_id: { type: "string", description: "HubSpot company record id." },
      },
    },
  },
  {
    name: "crm_search_deals",
    description:
      "Internal CRM data (read-only): deals / quotes (SAP quote numbers) for a company or rep code. Give account_number OR company_id to list a company's deals (via its associations), or rep_code to list deals for that rep/sales group. Set open_only to exclude Closed Won / Closed Lost. Returns deal name, quote #, stage, amount, and dates.",
    input_schema: {
      type: "object",
      properties: {
        account_number: { type: "string", description: "SAP account number of the company." },
        company_id: { type: "string", description: "HubSpot company record id." },
        rep_code: { type: "string", description: "Rep code / sales group to list deals for." },
        open_only: { type: "boolean", description: "Exclude Closed Won / Closed Lost deals." },
        limit: { type: "integer", description: `Max results (default ${CAP_DEALS}).` },
      },
    },
  },
  {
    name: "crm_get_open_orders",
    description:
      "Internal CRM data (read-only): OPEN orders (unshipped/in-progress sales orders) for a customer account — SO #, PO, amount, delivery, risk/credit status. Requires the SAP account_number.",
    input_schema: {
      type: "object",
      properties: {
        account_number: { type: "string", description: "SAP account number (required)." },
        limit: { type: "integer", description: `Max results (default ${CAP_ORDERS}).` },
      },
      required: ["account_number"],
    },
  },
  {
    name: "crm_get_invoice_history",
    description:
      "Internal CRM data (read-only): invoice / turnover history (shipped & billed orders) for a customer account — invoice #, billing date, brand, amount, quote ref. Requires the SAP account_number; optional `since` (YYYY-MM-DD) limits to invoices on/after that date.",
    input_schema: {
      type: "object",
      properties: {
        account_number: { type: "string", description: "SAP account number (required)." },
        since: { type: "string", description: "Only invoices billed on/after this date (YYYY-MM-DD)." },
        limit: { type: "integer", description: `Max results (default ${CAP_ORDERS}).` },
      },
      required: ["account_number"],
    },
  },
  {
    name: "crm_get_rep_code",
    description:
      "Internal CRM data (read-only): the rep code record — agency, region, channel, owner — for a rep code, or the rep code(s) tied to a customer account. Give rep_code OR account_number.",
    input_schema: {
      type: "object",
      properties: {
        rep_code: { type: "string", description: "The rep code / sales group." },
        account_number: { type: "string", description: "SAP account number to find the rep code(s) for." },
      },
    },
  },
];

// =============================================================================
// Pure helpers (unit-tested against mock HsObjects in hubspotTools.test.ts).
// =============================================================================

function prop(o: HsObject, name: string): string | null {
  const v = o.properties?.[name];
  return v != null && String(v).trim() !== "" ? String(v).trim() : null;
}

/** Currency-format a HubSpot money value ("1234.5" | 1234.5) → "$1,234.50". */
export function money(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,]/g, ""));
  if (!Number.isFinite(n)) return String(v);
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** HubSpot date value (ms-epoch string, or ISO datetime) → YYYY-MM-DD. */
export function day(v: string | null | undefined): string {
  if (!v) return "—";
  const s = String(v).trim();
  if (!s) return "—";
  const ms = /^-?\d+$/.test(s) ? Number(s) : Date.parse(s);
  if (!Number.isFinite(ms)) return s;
  return new Date(ms).toISOString().slice(0, 10);
}

/** ms-epoch for a YYYY-MM-DD `since` bound, or null if unparseable. */
export function sinceMs(since: string | null | undefined): number | null {
  if (!since) return null;
  const ms = Date.parse(`${String(since).trim()}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Deal stage id → human label, falling back to the raw id when unknown. */
export function dealStageLabel(id: string | null | undefined): string {
  if (!id) return "—";
  return STAGE_LABELS[id] ?? id;
}

/** A deal is "open" when it isn't in a closed (won/lost) stage. */
export function isOpenDeal(o: HsObject): boolean {
  const stage = prop(o, "dealstage");
  return stage === null || !CLOSED_STAGES.has(stage);
}

/** Cap rows and describe the overflow: "…and N more" when truncated. */
export function capRows<T>(rows: T[], cap: number): { shown: T[]; moreNote: string } {
  if (rows.length <= cap) return { shown: rows, moreNote: "" };
  return { shown: rows.slice(0, cap), moreNote: `\n…and ${rows.length - cap} more (narrow the search to see them).` };
}

export function formatCompanyLine(o: HsObject): string {
  const name = prop(o, "name") ?? "(unnamed)";
  const acct = prop(o, "account_number_");
  const brand = prop(o, "product_brand");
  const bits = [acct && `acct ${acct}`, brand && brand, `id ${o.id}`].filter(Boolean);
  return `- ${name} — ${bits.join(", ")}`;
}

export function formatCompanyDetail(o: HsObject): string {
  const name = prop(o, "name") ?? "(unnamed)";
  const acct = prop(o, "account_number_");
  const lines = [
    `${name} (id ${o.id}${acct ? `, account ${acct}` : ""})`,
    prop(o, "product_brand") && `Brand: ${prop(o, "product_brand")}`,
    `YTD sales: ${money(prop(o, "ytd_sales"))}`,
    `Prior-year YTD sales: ${money(prop(o, "prior_ytd_sales"))}`,
    `Previous full-year sales: ${money(prop(o, "previous_year_sales"))}`,
    prop(o, "ytd_sales_yoy_pct") && `YoY change: ${prop(o, "ytd_sales_yoy_pct")}%`,
    prop(o, "ytd_won_deals") && `YTD won deals: ${money(prop(o, "ytd_won_deals"))}`,
  ].filter(Boolean);
  return lines.join("\n");
}

export function formatDealRow(o: HsObject): string {
  const name = prop(o, "dealname") ?? "(unnamed deal)";
  const quote = prop(o, "sap_quote_number");
  const stage = dealStageLabel(prop(o, "dealstage"));
  const amount = money(prop(o, "amount"));
  const parts = [
    quote && `quote ${quote}`,
    `stage ${stage}`,
    `amount ${amount}`,
    prop(o, "sales_group") && `rep ${prop(o, "sales_group")}`,
    prop(o, "closedate") && `close ${day(prop(o, "closedate"))}`,
  ].filter(Boolean);
  return `- ${name} — ${parts.join(", ")}`;
}

export function formatOpenOrderRow(o: HsObject): string {
  const so = prop(o, "sales_order_id") ?? "(no SO#)";
  const parts = [
    prop(o, "po_number") && `PO ${prop(o, "po_number")}`,
    prop(o, "po_date") && `PO date ${day(prop(o, "po_date"))}`,
    `total ${money(prop(o, "hs_total_price"))}`,
    prop(o, "date_of_delivery") && `delivery ${day(prop(o, "date_of_delivery"))}`,
    prop(o, "credit_status") && `credit ${prop(o, "credit_status")}`,
    prop(o, "risk_code") && `risk ${prop(o, "risk_code")}`,
    prop(o, "sales_group") && `rep ${prop(o, "sales_group")}`,
  ].filter(Boolean);
  return `- SO ${so} — ${parts.join(", ")}`;
}

export function formatInvoiceRow(o: HsObject): string {
  const inv = prop(o, "billing_document") ?? "(no invoice#)";
  const parts = [
    prop(o, "billing_date") && `billed ${day(prop(o, "billing_date"))}`,
    `total ${money(prop(o, "hs_total_price"))}`,
    prop(o, "brand") && prop(o, "brand"),
    prop(o, "quotation_ref") && `quote ${prop(o, "quotation_ref")}`,
    prop(o, "sales_group") && `rep ${prop(o, "sales_group")}`,
  ].filter(Boolean);
  return `- Invoice ${inv} — ${parts.join(", ")}`;
}

/** Sum hs_total_price across invoice rows. */
export function invoiceTotal(rows: HsObject[]): number {
  let sum = 0;
  for (const r of rows) {
    const n = Number(String(r.properties?.hs_total_price ?? "").replace(/[$,]/g, ""));
    if (Number.isFinite(n)) sum += n;
  }
  return Math.round(sum * 100) / 100;
}

/** Keep invoice rows on/after `sinceMs` (rows with no billing date are dropped
 *  when a bound is given; kept when it isn't). */
export function filterInvoicesSince(rows: HsObject[], boundMs: number | null): HsObject[] {
  if (boundMs === null) return rows;
  return rows.filter((r) => {
    const raw = r.properties?.billing_date;
    if (raw == null || String(raw).trim() === "") return false;
    const s = String(raw).trim();
    const ms = /^-?\d+$/.test(s) ? Number(s) : Date.parse(s);
    return Number.isFinite(ms) && ms >= boundMs;
  });
}

export function assembleRepCode(o: HsObject): string {
  const code = prop(o, "rep_code") ?? "(unknown)";
  const lines = [
    `Rep code ${code}${prop(o, "agency") ? ` — ${prop(o, "agency")}` : ""}`,
    prop(o, "account") && `Agency account: ${prop(o, "account")}`,
    prop(o, "channel") && `Channel: ${prop(o, "channel")}`,
    prop(o, "region") && `Region: ${prop(o, "region")}`,
    prop(o, "city") && `City: ${prop(o, "city")}`,
    prop(o, "state") && `State: ${prop(o, "state")}`,
    prop(o, "brands") && `Brands: ${prop(o, "brands")}`,
    prop(o, "status") && `Status: ${prop(o, "status")}`,
    prop(o, "hubspot_owner_id") && `Owner (HubSpot user id): ${prop(o, "hubspot_owner_id")}`,
  ].filter(Boolean);
  return lines.join("\n");
}

// =============================================================================
// Tool implementations (I/O). Each reads via @wac/shared helpers only.
// =============================================================================

const NOT_CONFIGURED: ToolOutput = { content: "CRM tools are not configured.", cards: [], citations: [] };
const text = (content: string): ToolOutput => ({ content, cards: [], citations: [] });

function accountFilter(propName: string, account: string): HsSearchFilter {
  return { propertyName: propName, operator: "IN", values: accountForms(account) };
}

/** Resolve a company by account_number (any form) or explicit id. */
async function resolveCompany(
  token: string,
  props: readonly string[],
  input: { account_number?: string; company_id?: string },
  associations?: string[],
): Promise<HsObject | null> {
  const companyId = String(input.company_id ?? "").trim();
  if (companyId) {
    return getById(token, "companies", companyId, [...props], associations ? { associations } : undefined);
  }
  const account = String(input.account_number ?? "").trim();
  if (!account) return null;
  for await (const c of searchAll(token, "companies", [accountFilter("account_number_", account)], [...props], {
    maxResults: 1,
  })) {
    // Re-fetch by id when associations are needed (search can't return them).
    return associations ? getById(token, "companies", c.id, [...props], { associations }) : c;
  }
  return null;
}

/** existingProperties-gated prop list: keep only props the object actually has,
 *  so a missing custom prop warns-and-skips instead of erroring the request. */
async function presentProps(
  token: string,
  objectType: string,
  wanted: readonly string[],
): Promise<string[]> {
  try {
    const present = await existingProperties(token, objectType);
    const kept = wanted.filter((p) => present.has(p));
    return kept.length ? kept : [...wanted];
  } catch {
    // Schema fetch failed — fall back to the full list; a bad prop just yields nulls.
    return [...wanted];
  }
}

async function searchCompanies(token: string, input: Record<string, unknown>): Promise<ToolOutput> {
  const query = String(input.query ?? "").trim();
  const account = String(input.account_number ?? "").trim();
  const limit = Math.min(Number(input.limit) || CAP_COMPANIES, CAP_COMPANIES);
  if (!query && !account) return text("crm_search_companies: provide a query or account_number.");

  const filters: HsSearchFilter[] = account
    ? [accountFilter("account_number_", account)]
    : [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: query }];

  const rows: HsObject[] = [];
  for await (const c of searchAll(token, "companies", filters, [...COMPANY_PROPS], { maxResults: limit + 1 })) {
    rows.push(c);
  }
  if (!rows.length) return text("No matching companies.");
  const { shown, moreNote } = capRows(rows, limit);
  return text(shown.map(formatCompanyLine).join("\n") + moreNote);
}

async function getCompany(token: string, input: Record<string, unknown>): Promise<ToolOutput> {
  if (!String(input.account_number ?? "").trim() && !String(input.company_id ?? "").trim()) {
    return text("crm_get_company: provide account_number or company_id.");
  }
  const props = await presentProps(token, "companies", COMPANY_PROPS);
  const company = await resolveCompany(token, props, input);
  if (!company) return text("No matching company.");
  return text(formatCompanyDetail(company));
}

async function searchDeals(token: string, input: Record<string, unknown>): Promise<ToolOutput> {
  const openOnly = input.open_only === true;
  const limit = Math.min(Number(input.limit) || CAP_DEALS, CAP_DEALS);
  const repCode = String(input.rep_code ?? "").trim();
  const hasCompany = !!String(input.account_number ?? "").trim() || !!String(input.company_id ?? "").trim();

  let rows: HsObject[] = [];

  if (hasCompany) {
    // Deals carry no account property — reach them through the company's
    // associations, then batch-read the deal records.
    const company = await resolveCompany(token, ["name"], input, ["deals"]);
    if (!company) return text("No matching company.");
    const assoc = (company as { associations?: { deals?: { results?: { id: string }[] } } }).associations;
    const dealIds = (assoc?.deals?.results ?? []).map((r) => r.id);
    if (!dealIds.length) return text("No deals associated with that company.");
    const byId = await batchRead(token, DEAL_OBJECT, dealIds, [...DEAL_PROPS]);
    rows = [...byId.values()];
  } else if (repCode) {
    for await (const d of searchAll(
      token,
      DEAL_OBJECT,
      [{ propertyName: "sales_group", operator: "EQ", value: repCode }],
      [...DEAL_PROPS],
      { maxResults: 500 },
    )) {
      rows.push(d);
    }
  } else {
    return text("crm_search_deals: provide account_number, company_id, or rep_code.");
  }

  if (openOnly) rows = rows.filter(isOpenDeal);
  if (!rows.length) return text(openOnly ? "No open deals found." : "No deals found.");
  // Newest first by createdate when present.
  rows.sort((a, b) => Number(b.properties?.createdate ?? 0) - Number(a.properties?.createdate ?? 0));
  const { shown, moreNote } = capRows(rows, limit);
  const header = `${rows.length} deal(s)${openOnly ? " (open only)" : ""}:`;
  return text(`${header}\n${shown.map(formatDealRow).join("\n")}${moreNote}`);
}

async function getOpenOrders(token: string, input: Record<string, unknown>): Promise<ToolOutput> {
  const account = String(input.account_number ?? "").trim();
  if (!account) return text("crm_get_open_orders: account_number is required.");
  const limit = Math.min(Number(input.limit) || CAP_ORDERS, CAP_ORDERS);

  const rows: HsObject[] = [];
  for await (const o of searchAll(
    token,
    ORDER_OBJECT,
    [accountFilter("customer_account", account), { propertyName: "hs_pipeline", operator: "EQ", value: OPEN_ORDERS_PIPELINE }],
    [...OPEN_ORDER_PROPS],
    { maxResults: 500 },
  )) {
    rows.push(o);
  }
  if (!rows.length) return text("No open orders for that account.");
  const { shown, moreNote } = capRows(rows, limit);
  return text(`${rows.length} open order(s):\n${shown.map(formatOpenOrderRow).join("\n")}${moreNote}`);
}

async function getInvoiceHistory(token: string, input: Record<string, unknown>): Promise<ToolOutput> {
  const account = String(input.account_number ?? "").trim();
  if (!account) return text("crm_get_invoice_history: account_number is required.");
  const limit = Math.min(Number(input.limit) || CAP_ORDERS, CAP_ORDERS);
  const boundMs = sinceMs(typeof input.since === "string" ? input.since : null);

  const filters: HsSearchFilter[] = [
    accountFilter("customer_account", account),
    { propertyName: "billing_document", operator: "HAS_PROPERTY" },
  ];
  if (boundMs !== null) filters.push({ propertyName: "billing_date", operator: "GTE", value: String(boundMs) });

  let rows: HsObject[] = [];
  for await (const o of searchAll(token, ORDER_OBJECT, filters, [...INVOICE_PROPS], { maxResults: 1000 })) {
    rows.push(o);
  }
  rows = filterInvoicesSince(rows, boundMs);
  if (!rows.length) return text("No invoice history for that account.");
  // Newest first by billing date.
  rows.sort((a, b) => day(b.properties?.billing_date ?? null).localeCompare(day(a.properties?.billing_date ?? null)));
  const total = invoiceTotal(rows);
  const { shown, moreNote } = capRows(rows, limit);
  const header = `${rows.length} invoice(s), total ${money(total)}${boundMs !== null && typeof input.since === "string" ? ` since ${input.since}` : ""}:`;
  return text(`${header}\n${shown.map(formatInvoiceRow).join("\n")}${moreNote}`);
}

async function getRepCode(token: string, input: Record<string, unknown>): Promise<ToolOutput> {
  const repCode = String(input.rep_code ?? "").trim();
  const account = String(input.account_number ?? "").trim();
  if (!repCode && !account) return text("crm_get_rep_code: provide rep_code or account_number.");

  const props = await presentProps(token, REP_CODE_OBJECT, REP_PROPS);

  if (repCode) {
    const byCode = await batchRead(token, REP_CODE_OBJECT, [repCode], props, { idProperty: "rep_code" });
    const rec = byCode.get(repCode);
    if (!rec) return text(`No rep code record for ${repCode}.`);
    return text(assembleRepCode(rec));
  }

  // By account: rep code records carry the agency `account` number.
  const rows: HsObject[] = [];
  for await (const r of searchAll(token, REP_CODE_OBJECT, [accountFilter("account", account)], props, {
    maxResults: CAP_COMPANIES + 1,
  })) {
    rows.push(r);
  }
  if (!rows.length) return text("No rep code tied to that account.");
  const { shown, moreNote } = capRows(rows, CAP_COMPANIES);
  return text(shown.map(assembleRepCode).join("\n\n") + moreNote);
}

// --- dispatch ----------------------------------------------------------------

export async function hubspotDispatch(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutput> {
  const token = ctx.env.HUBSPOT_READ_TOKEN;
  if (!token) return NOT_CONFIGURED;
  switch (name) {
    case "crm_search_companies":
      return searchCompanies(token, input);
    case "crm_get_company":
      return getCompany(token, input);
    case "crm_search_deals":
      return searchDeals(token, input);
    case "crm_get_open_orders":
      return getOpenOrders(token, input);
    case "crm_get_invoice_history":
      return getInvoiceHistory(token, input);
    case "crm_get_rep_code":
      return getRepCode(token, input);
    default:
      return text(`Unknown CRM tool: ${name}`);
  }
}
