/**
 * OA (international ERP) -> HubSpot mapping (pure data + helpers).
 *
 * OA is the proprietary ERP for international (non-China-destination) business
 * at oa.waclighting.com.cn; apps/oa-sync polls its REST API and pushes to the
 * same HubSpot portal as the SAP sync. Everything here is pure and unit-tested;
 * all I/O lives in the app.
 *
 * Collision safety vs the SAP sync: OA records upsert ONLY on OA-owned unique
 * keys (deal oa_quote_number, company oa_account_number, order oa_order_id,
 * line item oa_line_key) and never read or write the SAP-owned keys
 * (sap_quote_number / account_number_ / sales_order_id / quote_product_name).
 * Builders skip null/blank values (mapFields convention) so an absent OA field
 * never clears a HubSpot property.
 *
 * Only the order list/detail payloads are documented; the quotes / projects /
 * customers endpoints (added 2026-07-14) are introspected via `oa-sync
 * --sample`. Types are deliberately loose and builders tolerant: unknown
 * fields are ignored, missing ones skipped.
 */

import { toNumber } from "./mapping.js";

// ---------------------------------------------------------------------------
// Payload types (loose — the API is young; every field may be absent).
// ---------------------------------------------------------------------------

export interface OaProject {
  name?: string | null;
  location?: string | null;
  country?: string | null;
  finishedDate?: string | null;
  productType?: string | null;
  status?: string | null;
  id?: string | number | null;
  [k: string]: unknown;
}

export interface OaCustomer {
  code?: string | null;
  name?: string | null;
  coefficient?: string | number | null;
  contacts?: string | null;
  [k: string]: unknown;
}

export interface OaProduct {
  material?: string | null;
  description?: string | null;
  quantity?: string | number | null;
  quotePrice?: string | number | null;
  customiseRemark?: string | null;
  lampPosition?: string | null;
  [k: string]: unknown;
}

export interface OaQuotation {
  id?: string | null; // e.g. "QT2025120014" — the deal key
  quotationNo?: string | null;
  title?: string | null;
  project?: OaProject | null;
  customer?: OaCustomer | null;
  productList?: OaProduct[] | null;
  requestDate?: string | null;
  estimatedOrderDate?: string | null;
  currency?: string | null;
  discount?: string | number | null;
  prepayment?: string | number | null;
  prepaymentPercentage?: string | number | null;
  balancePayment?: string | number | null;
  paymentTerms?: string | null;
  shipmentTerms?: string | null;
  leadtime?: string | null;
  totalAmount?: string | number | null;
  discountTotalAmount?: string | number | null;
  remarks?: string | null;
  status?: string | null;
  [k: string]: unknown;
}

export interface OaOrderSummary {
  id?: string | number | null;
  orderNumber?: string | null; // the SAP sales-order number
  createDate?: string | null;
  updateDate?: string | null;
  expectedDeliveryDate?: string | null;
  orderRemark?: string | null;
  remarks?: string | null;
  quotation?: { id?: string | null; title?: string | null; quotationNo?: string | null } | null;
  [k: string]: unknown;
}

export interface OaOrderDetail extends OaOrderSummary {
  quotationId?: string | null;
  quotation?: OaQuotation | null;
  orderDiscount?: string | number | null;
  receivedPrepayment?: boolean | null;
  receivedPrepaymentAmount?: string | number | null;
  receivedBalancePayment?: boolean | null;
  receivedBalancePaymentAmount?: string | number | null;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Value written to erp_source on create (never overwritten). */
export const OA_ERP_SOURCE = "OA";

/** Deal pipeline label for international deals (discovered/created by label). */
export const OA_DEAL_PIPELINE_LABEL = "International";

/** Orders-object pipeline label for OA orders. */
export const OA_ORDERS_PIPELINE_LABEL = "International Orders";

/**
 * Mirrored stage labels — MUST match the domestic Universal pipeline's CURRENT
 * labels (verified against the live portal 2026-07-17: Pre-Qualified /
 * Planning / Spec / Bid / Commit / Buy / Lost) so shared projects can move
 * between pipelines without stage-vocabulary drift. The International pipeline
 * is created by cloning Universal's stages (+ probabilities) at runtime, so
 * creation self-updates on renames — but the LOOKUPS below go by these labels,
 * so a future Universal rename must be mirrored here.
 */
export const OA_STAGE_LABELS = {
  prequal: "Pre-Qualified",
  planning: "Planning",
  spec: "Spec",
  bid: "Bid",
  commit: "Commit",
  buy: "Buy",
  lost: "Lost",
} as const;

export type OaStageLabel = (typeof OA_STAGE_LABELS)[keyof typeof OA_STAGE_LABELS];

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const OA_TZ_OFFSET_MS = 8 * 3_600_000; // OA timestamps are China time (UTC+8)
const DAY_MS = 86_400_000;
const NOON_MS = DAY_MS / 2;

/** Parse OA "yyyy-MM-dd[ HH:mm:ss]" into its date/time parts, or null. */
function parseOaDate(v: unknown): {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
} | null {
  if (v === null || v === undefined || v === "") return null;
  const m = String(v)
    .trim()
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990) return null; // 0000-00-00 sentinels
  return { y, mo, d, h: Number(m[4] ?? 0), mi: Number(m[5] ?? 0), s: Number(m[6] ?? 0) };
}

/** OA datetime string (China time) -> epoch ms instant, or null. */
export function oaDateTimeToMs(v: unknown): number | null {
  const p = parseOaDate(v);
  if (!p) return null;
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - OA_TZ_OFFSET_MS;
}

/**
 * OA date/datetime -> HubSpot date-property value: NOON UTC on the China-local
 * calendar day. Noon, not midnight — midnight-UTC values render as the
 * previous day in US timezones on datetime-typed properties (the closedate
 * lesson), and noon displays identically on true date-typed properties.
 */
export function oaDateToHubspotDate(v: unknown): number | null {
  const p = parseOaDate(v);
  if (!p) return null;
  return Date.UTC(p.y, p.mo - 1, p.d) + NOON_MS;
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

const OA_CURRENCY_ALIASES: Record<string, string> = {
  RMB: "CNY", // OA says RMB; HubSpot multicurrency wants ISO 4217
  CNY: "CNY",
  USD: "USD",
  EUR: "EUR",
  CAD: "CAD",
};

/** Normalize an OA currency to ISO 4217, or null (caller skips the property). */
export function oaCurrency(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toUpperCase();
  return OA_CURRENCY_ALIASES[s] ?? null;
}

// ---------------------------------------------------------------------------
// Destination gate — only records shipping OUTSIDE mainland China are pushed.
// ---------------------------------------------------------------------------

export type OaDestination = "china" | "international" | "unknown";

/**
 * Hong Kong / Macau / Taiwan are handled as international markets here, and
 * are checked BEFORE the China patterns so "Taiwan, China" style strings
 * classify as international.
 */
const NON_MAINLAND = /\b(hong\s*kong|hongkong|hk|macau|macao|taiwan|taipei|tw)\b|香港|澳门|澳門|台湾|臺灣/i;

const CHINA_WORDS =
  /\b(china|prc|cn|chn)\b|中国|中华|中國/i;

// Province-level names + major cities that show up as bare locations.
const CHINA_PLACES =
  /\b(beijing|shanghai|guangzhou|shenzhen|tianjin|chongqing|chengdu|wuhan|hangzhou|nanjing|suzhou|dongguan|foshan|ningbo|qingdao|shenyang|dalian|zhengzhou|changsha|kunming|xiamen|hefei|fuzhou|harbin|jinan|xi'?an|guangdong|zhejiang|jiangsu|shandong|sichuan|hubei|hunan|henan|fujian|anhui|hebei|shanxi|shaanxi|liaoning|jilin|heilongjiang|yunnan|guizhou|guangxi|jiangxi|gansu|hainan|qinghai|ningxia|xinjiang|tibet|inner\s*mongolia)\b/i;

/**
 * Classify a record's ship-to destination from the best available fields
 * (explicit country first, free-text location as fallback). Blank/unmatched
 * input is "unknown" — the sync FAILS CLOSED and skips unknowns, so nothing
 * Chinese can leak into HubSpot via a blank field; the run summary surfaces
 * skip counts so over-filtering is visible.
 */
export function oaDestination(fields: {
  country?: string | null;
  location?: string | null;
}): OaDestination {
  const country = String(fields.country ?? "").trim();
  const location = String(fields.location ?? "").trim();
  const all = [country, location].filter(Boolean);
  const isChina = (s: string) => CHINA_WORDS.test(s) || CHINA_PLACES.test(s);
  // Non-mainland markers win over China matches ACROSS fields, not just within
  // one: OA records Hong Kong projects as country "China" + location "HK"
  // (seen live 2026-07-17), and per the business rule HK/Macau/Taiwan ship
  // international.
  if (all.some((s) => NON_MAINLAND.test(s))) return "international";
  if (all.some(isChina)) {
    // Conflicting fields (seen live: country "China" + location "Pakistan"/
    // "Korea") mean OA's country field can't be trusted for this record —
    // plausibly a real international shipment. Fail closed as UNKNOWN (still
    // skipped, but surfaced for review) rather than mislabeling it domestic.
    if (all.some((s) => !isChina(s))) return "unknown";
    return "china";
  }
  // An explicit non-China country is decisive even if we can't recognize the
  // free-text location; a bare unrecognized location is NOT (could be a
  // Chinese city we don't list).
  if (country) return "international";
  return "unknown";
}

/**
 * Candidate project names for a quote title, most-specific first. Quote titles
 * are typically the project name plus a quotation suffix ("projectA-1",
 * "Qatar_QT1", "萬豪酒店——QT1" — live-verified 2026-07-17), so the join tries
 * the exact title, then progressively strips trailing "QT/Q + digits" (or
 * bare-digit) segments, then the last dash-delimited segment.
 */
export function oaProjectNameCandidates(title: unknown): string[] {
  const t = String(title ?? "").trim();
  if (!t) return [];
  const out = [t];
  let s = t;
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/[\s_\-–—]+(?:qt|q)?\s*\d*$/i, "").trim();
    if (next && next !== s) {
      out.push(next);
      s = next;
    } else break;
  }
  const lastDash = t.replace(/[-–—][^-–—]*$/, "").trim();
  if (lastDash && !out.includes(lastDash)) out.push(lastDash);
  return out;
}

/** Convenience: extract destination fields from a quotation/order payload. */
export function oaDestinationOf(q: OaQuotation | null | undefined): OaDestination {
  return oaDestination({
    country: (q?.project?.country as string | null | undefined) ?? null,
    location: (q?.project?.location as string | null | undefined) ?? null,
  });
}

// ---------------------------------------------------------------------------
// OA project status -> mirrored stage label (deal CREATE only; the granular
// status always lands in the oa_project_status property).
// ---------------------------------------------------------------------------

// NOTE (2026-07-17 live sample): the /quotes endpoint returns NUMERIC status
// codes ("2","6","9","12","14","22"), not the labels below — the code→label
// vocabulary is an open ask to Eason. Unknown statuses fall back to Bid, and
// the raw code is preserved in oa_project_status either way; add numeric keys
// here once the vocabulary lands.
const STATUS_TO_STAGE: Record<string, OaStageLabel> = {
  "new lead": OA_STAGE_LABELS.prequal,
  tba: OA_STAGE_LABELS.prequal,

  design: OA_STAGE_LABELS.spec,
  "re-design": OA_STAGE_LABELS.spec,
  redesign: OA_STAGE_LABELS.spec,
  "submit specification": OA_STAGE_LABELS.spec,
  "submit lighting calculation": OA_STAGE_LABELS.spec,

  "waiting tender": OA_STAGE_LABELS.bid,
  "re-tender": OA_STAGE_LABELS.bid,
  retender: OA_STAGE_LABELS.bid,
  offer: OA_STAGE_LABELS.bid,
  "price negotiation": OA_STAGE_LABELS.bid,
  "post tender-negotiation": OA_STAGE_LABELS.bid,
  "post tender-review sample": OA_STAGE_LABELS.bid,
  "follow up": OA_STAGE_LABELS.bid,
  pending: OA_STAGE_LABELS.bid,
  "on hold": OA_STAGE_LABELS.bid,
  delay: OA_STAGE_LABELS.bid,

  // Commit = "order promised but PO not yet received" (Davis 2026-07-17).
  // Davis's call: Tender and Construction land here; once a PO exists OA has
  // an order record and the order-exists override moves the deal to Buy.
  tender: OA_STAGE_LABELS.commit,
  construction: OA_STAGE_LABELS.commit,

  complete: OA_STAGE_LABELS.buy,

  cancellation: OA_STAGE_LABELS.lost,
  cancelled: OA_STAGE_LABELS.lost,
  canceled: OA_STAGE_LABELS.lost,
};

/**
 * Map an OA project status to the mirrored stage label for a NEW deal, or
 * null when unknown (caller falls back to Bid for open quotes). Order
 * existence overrides this entirely (=> Buy, the closed-won stage).
 */
export function oaStageForStatus(status: unknown): OaStageLabel | null {
  if (status === null || status === undefined) return null;
  const s = String(status).trim().toLowerCase().replace(/\s+/g, " ");
  return STATUS_TO_STAGE[s] ?? null;
}

// ---------------------------------------------------------------------------
// Prop builders. All skip null/blank so nothing is ever cleared in HubSpot.
// ---------------------------------------------------------------------------

type Props = Record<string, string | number>;

function put(out: Props, prop: string, v: unknown, kind: "string" | "number" | "date" = "string") {
  if (v === null || v === undefined || v === "") return;
  if (kind === "date") {
    const d = oaDateToHubspotDate(v);
    if (d !== null) out[prop] = d;
    return;
  }
  if (kind === "number") {
    const n = toNumber(v);
    if (typeof n === "number") out[prop] = n;
    return;
  }
  const s = String(v).trim();
  if (s) out[prop] = s;
}

/**
 * Quote -> Deal properties (upsert bag; pipeline/dealstage/closedate/
 * erp_source are handled by the app because they are CREATE-only).
 */
export function oaDealProps(q: OaQuotation): Props {
  const out: Props = {};
  put(out, "oa_quote_number", q.id);
  put(out, "dealname", q.project?.name ?? q.title);
  put(out, "project_location", q.project?.location);
  put(out, "project_country", q.project?.country);
  put(out, "oa_project_finished_date", q.project?.finishedDate, "date");
  put(out, "oa_project_status", q.status ?? q.project?.status);
  put(out, "quote_creation_date", q.requestDate, "date");
  put(out, "original_estimated_decision_date", q.estimatedOrderDate, "date");
  put(out, "subtotal", q.totalAmount, "number");
  put(out, "amount", q.discountTotalAmount, "number");
  put(out, "discount", q.discount, "number");
  put(out, "oa_prepayment", q.prepayment, "number");
  put(out, "oa_prepayment_percentage", q.prepaymentPercentage, "number");
  put(out, "oa_balance_payment", q.balancePayment, "number");
  put(out, "oa_payment_terms", q.paymentTerms);
  put(out, "oa_shipment_terms", q.shipmentTerms);
  put(out, "oa_leadtime", q.leadtime);
  put(out, "oa_quote_remarks", q.remarks);
  put(out, "customer_name", q.customer?.name);
  put(out, "oa_account_number", q.customer?.code);
  put(out, "customer_coefficient", q.customer?.coefficient, "number");
  put(out, "requested_by", q.customer?.contacts);
  const cur = oaCurrency(q.currency);
  if (cur) out.deal_currency_code = cur;
  return out;
}

/** Customer -> Company properties. `name` is stripped by the app for EXISTING companies (create-only there). */
export function oaCompanyProps(c: OaCustomer): Props {
  const out: Props = {};
  put(out, "oa_account_number", c.code);
  put(out, "name", c.name);
  put(out, "customer_coefficient", c.coefficient, "number");
  // Fields the customers endpoint is expected to add (mapping workbook);
  // harmless no-ops until the payload carries them. domain -> website on
  // purpose (never the dedup-bearing `domain` property — SAP convention).
  put(out, "website", (c as Record<string, unknown>).domain);
  put(out, "address", (c as Record<string, unknown>).address);
  put(out, "city", (c as Record<string, unknown>).city);
  put(out, "state", (c as Record<string, unknown>).state);
  put(out, "zip", (c as Record<string, unknown>).postalCode ?? (c as Record<string, unknown>).zip);
  put(out, "country", (c as Record<string, unknown>).country);
  put(out, "terms_of_payment", (c as Record<string, unknown>).paymentTerms);
  return out;
}

/** Order -> Orders-object properties. */
export function oaOrderProps(d: OaOrderDetail): Props {
  const out: Props = {};
  const q = d.quotation ?? null;
  put(out, "oa_order_id", d.id);
  put(out, "oa_order_number", d.orderNumber); // SAP SO# — deliberately NOT sales_order_id
  put(out, "hs_order_name", d.orderNumber ?? d.id);
  put(out, "oa_quote_number", q?.id ?? d.quotationId);
  put(out, "customer_account", q?.customer?.code);
  put(out, "customer_name", q?.customer?.name);
  put(out, "expected_delivery_date", d.expectedDeliveryDate, "date");
  put(out, "oa_order_discount", d.orderDiscount, "number");
  put(out, "oa_received_prepayment_amount", d.receivedPrepaymentAmount, "number");
  put(out, "oa_received_balance_payment_amount", d.receivedBalancePaymentAmount, "number");
  if (typeof d.receivedPrepayment === "boolean") {
    out.oa_received_prepayment = String(d.receivedPrepayment);
  }
  if (typeof d.receivedBalancePayment === "boolean") {
    out.oa_received_balance_payment = String(d.receivedBalancePayment);
  }
  put(out, "oa_order_remark", d.orderRemark ?? d.remarks);
  const cur = oaCurrency(q?.currency);
  if (cur) out.hs_currency_code = cur;
  return out;
}

/**
 * Line-item dedup key: quote id + 1-based position + material. Position keeps
 * duplicate materials distinct; a reordered productList rewrites that quote's
 * lines under new keys, which is acceptable at OA volume and can never
 * collide across quotes.
 */
export function oaLineKey(quoteId: string, index: number, material: unknown): string {
  const mat = String(material ?? "")
    .trim()
    .slice(0, 80);
  return `${quoteId}-${String(index + 1).padStart(3, "0")}-${mat}`;
}

/** Quotation productList -> line-item upsert bags (keyed by oa_line_key). */
export function oaLineItems(q: OaQuotation): { key: string; props: Props }[] {
  const quoteId = String(q.id ?? "").trim();
  if (!quoteId || !Array.isArray(q.productList)) return [];
  const out: { key: string; props: Props }[] = [];
  for (let i = 0; i < q.productList.length; i++) {
    const p = q.productList[i] ?? {};
    const key = oaLineKey(quoteId, i, p.material);
    const props: Props = { oa_line_key: key };
    put(props, "name", p.material);
    put(props, "material_description", p.description);
    put(props, "quantity", p.quantity, "number");
    put(props, "oa_customise_remark", p.customiseRemark);
    put(props, "oa_lamp_position", p.lampPosition);
    const price = toNumber(p.quotePrice);
    if (typeof price === "number" && price >= 0) props.price = price; // negatives poison hs_ rollups
    out.push({ key, props });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Change detection — stable stringify + FNV-1a (no crypto dep; collision risk
// irrelevant at this volume, and a false "changed" only costs a re-push).
// ---------------------------------------------------------------------------

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** Stable content hash of any OA payload (hex string). */
export function oaRecordHash(payload: unknown): string {
  const s = stableStringify(payload);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
