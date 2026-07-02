/**
 * SAP -> HubSpot field mapping (pure data + helpers).
 *
 * Mirrors the two AWS Lambdas that push SAP data to HubSpot today:
 *   - Deals/Quotes Lambda: a Deal (object 0-3) keyed by sap_quote_number, plus
 *     Line Items (line_items) keyed by quote_product_name.
 *   - Companies Lambda: a Company keyed by account_number_.
 *
 * In Phase 1 only the *known-key sets* are used (to flag genuinely unexpected
 * incoming fields in the capture endpoint); the Phase-2 Worker push consumes the
 * same maps so mapping logic lives in exactly one place. The maps are copied
 * verbatim from the Lambdas, INCLUDING their real-world quirks (the
 * `oppourtunity_type` misspelling alias, the `unit_of_measurment` typo target,
 * `material__ -> hs_sku`, `project_name_customer_po__ -> dealname`).
 */

export type HubspotObjectType = "deals" | "companies";

/** Deal property map — SAP field -> HubSpot Deal (object 0-3) property. */
export const DEAL_FIELD_MAP: Record<string, string> = {
  quotation_number: "sap_quote_number",
  account_number: "account_number",
  project_type: "project_type",
  sales_group: "sales_group",
  sales_group_name: "sales_group_name",
  quoted_by: "quoted_by",

  opportunity_type: "opportunity_type",
  oppourtunity_type: "opportunity_type", // support misspelling

  internal_note: "internal_note",
  original_estimated_decision_date: "original_estimated_decision_date",
  original_estimated_onsite_date: "estimated_onsite_date",
  valid_to: "valid_to",
  quote_type: "quote_type",
  stage_of_project: "stage_of_project",
  quote_creation_date: "quote_creation_date",
  price_list: "price_list",
  project_name_customer_po__: "dealname",
  status_of_quote: "status_of_quote",
  doc__currency: "doc__currency",

  specifier_type_1: "specifier_type_1",
  specifier_type_category_1: "specifier_type_category_1",
  specifier_account_number_1: "specifier_account_number_1",
  specifier_type_2: "specifier_type_2",
  specifier_type_category_2: "specifier_type_category_2",
  specifier_account_number_2: "specifier_account_number_2",
  specifier_type_3: "specifier_type_3",
  specifier_type_category_3: "specifier_type_category_3",
  specifier_account_number_3: "specifier_account_number_3",
  specifier_type_4: "specifier_type_4",
  specifier_type_category_4: "specifier_type_category_4",
  specifier_account_number_4: "specifier_account_number_4",
  specifier_type_5: "specifier_type_5",
  specifier_type_category_5: "specifier_type_category_5",
  specifier_account_number_5: "specifier_account_number_5",

  quote_net_value: "amount",
  conversion_rate: "conversion_rate",
  quote_last_changed_date: "quote_last_changed_date",

  sales_rep_1: "sales_rep_1",
  sales_rep_2: "sales_rep_2",
  sales_rep_3: "sales_rep_3",
  sales_rep_1_commission__: "sales_rep_1_commission__",
  sales_rep_2_commission__: "sales_rep_2_commission__",
  sales_rep_3_commission__: "sales_rep_3_commission__",

  tax: "tax",
  requested_by: "requested_by",
  outside_quote_recipient: "outside_quote_recipient",
  project_location: "project_location",
  customization: "customization",
  technical_type: "technical_type",
  technical_type_desc: "technical_type_desc",
  state: "state",
  oasis_quote_id: "oasis_quote_id",
  submittal_agent: "submittal_agent",
  submittal_agent_desc: "submittal_agent_desc",

  construct_connect_id: "construct_connect_deal_id",
  construct_connect_deal_id: "construct_connect_deal_id",

  onsite_estimate_variance_gap: "onsite_estimate_variance_gap",
  rep_code_for_permissions: "rep_code_for_permissions",
  quote_follow_up_1: "quote_follow_up_1",
  quote_follow_up_2: "quote_follow_up_2",
  quote_follow_up_3: "quote_follow_up_3",
  closed_lost_category: "closed_lost_category",

  completed_quote_follow_up_1: "completed_quote_follow_up_1",
  completed_quote_follow_up_2: "completed_quote_follow_up_2",
  completed_quote_follow_up_3: "completed_quote_follow_up_3",
  completed_quote_follow_up_by_1: "completed_quote_follow_up_by_1",
  completed_quote_follow_up_by_2: "completed_quote_follow_up_by_2",
  completed_quote_follow_up_by_3: "completed_quote_follow_up_by_3",
  valid_to_date_is_greater_than_quote_creation_date___365__cloned_:
    "valid_to_date_is_greater_than_quote_creation_date___365__cloned_",

  // Added 2026-06-24: SAP fields with no prior HubSpot property (now created).
  // Present in the CSV export; the live real-time payload does not send these.
  register: "register",
  external_quote_note: "external_quote_note",
};

/** Line Item property map — SAP line field -> HubSpot Line Item property. */
export const LINE_ITEM_FIELD_MAP: Record<string, string> = {
  quote_line: "quote_line",
  quote_product_name: "quote_product_name",
  fixture_production_time: "fixture_production_time",
  plant: "plant",

  item_quantity: "quantity",
  doc__currency: "doc__currency",
  commission: "commission",

  rejection_code: "rejection_code",
  rejection_date: "rejection_date",
  rejection_reason: "rejection_reason",

  customer_material_number: "customer_material_number",
  business_unit: "business_unit",
  product_group_description: "product_group_description",
  product_line_description: "product_line_description",

  unit_price: "unit_price",
  discount_percentage: "hs_discount_percentage",
  zprc: "zprc",

  material__: "hs_sku",
  material_description: "material_description",
  unit_of_measurement: "unit_of_measurment", // typo is the real internal name

  total_commission_per_line_item: "total_commission_per_line_item",
  quote_conversion_date: "quote_conversion_date",
  material_output: "material_output",

  customization_level: "customization_level",
  sales_order_date: "sales_order_date",
};

/** Company property map — SAP field -> HubSpot Company property. */
export const COMPANY_FIELD_MAP: Record<string, string> = {
  account_number_: "account_number_",
  name: "sap_company_name",
  // SAP "domain" carries a full web address with a path (e.g.
  // "advanceelectriclighting.com/brand-wac-us-modern-fo"), which HubSpot's
  // `domain` property rejects (it wants a bare host) → it was being dropped. Route
  // it to HubSpot's free-text `website` property instead. Company upserts dedupe by
  // `account_number_`, not domain, so nothing downstream relies on `domain`.
  domain: "website",
  phone: "phone",
  fax_number: "fax_number",
  parent_customer: "parent_customer",
  company_type: "company_type",
  company_sub_type: "company_sub_type",
  email: "email",
  e_order_confirmation: "e_order_confirmation",
  e_rga_confirmation: "e_rga_confirmation",
  e_statement: "e_statement",
  e_invoice: "e_invoice",
  rep_quote_report_contact: "rep_quote_report_contact",
  sales_rep_code: "sales_rep_code",
  rep_business_name: "rep_business_name",
  sales_manager: "sales_manager",
  rep_email: "rep_email",
  rep_mobile_phone_number: "rep_mobile_phone_number",
  rep_office_phone_number: "rep_office_phone_number",
  rep_office_fax_number: "rep_office_fax_number",
  price_list: "price_list",
  risk_category: "risk_category",
  terms_of_payment_code: "terms_of_payment_code",
  product_brand: "product_brand",
  lifecyclestage: "lifecyclestage",
  company_score: "company_score",
  address: "address",
  city: "city",
  state: "state",
  zip: "zip",
  country: "country",
  corporate_group: "corporate_group",
  location_code: "location_code",
  industry_key: "industry_key",
  price_group: "price_group",
  buying_group: "buying_group",
  inside_sales_rep: "inside_sales_rep",
  freight_allowed: "freight_allowed",
  freight_policy: "freight_policy",
  sales_org: "sales_org",
  sales_office: "sales_office",

  // Added 2026-06-23: previously-unmapped SAP fields surfaced by the dashboard.
  // All map 1:1 to existing HubSpot company properties (rep contact name, the
  // terms/program codes' siblings, and the *_description label companions to
  // codes already mapped above).
  sales_rep_: "sales_rep_", // "Sales Rep. Contact Name" (distinct from sales_rep_code / rep_business_name)
  terms_of_payment: "terms_of_payment", // label sibling of terms_of_payment_code
  program_level: "program_level",
  price_list_description: "price_list_description",
  risk_category_description: "risk_category_description",
  price_group_description: "price_group_description",
  buying_group_description: "buying_group_description",
  inside_sales_rep_description: "inside_sales_rep_description", // "Inside Sales Rep Name"
  freight_allowed_description: "freight_allowed_description",
  freight_policy_description: "freight_policy_description",
};

/**
 * The company `status` value is fully derived from `risk_category_description`,
 * replicating the "Set Company Status to Active or Inactive" HubSpot workflow:
 * `risk_category_description == "Inactive Account"` (case/space-insensitive) →
 * Inactive, anything else → Active. `status` is a boolean-style enum whose values
 * are the strings `"false"` (Inactive) and `"true"` (Active).
 *
 * Returns `null` when there is no risk category to derive from, so the caller
 * leaves `status` untouched rather than clobbering an existing value (a SAP payload
 * that omits the field must NOT flip a company to Active).
 */
export function companyStatusFromRiskCategory(
  riskCategoryDescription: unknown,
): "true" | "false" | null {
  if (riskCategoryDescription === null || riskCategoryDescription === undefined) return null;
  const v = String(riskCategoryDescription).trim();
  if (!v) return null;
  return v.toLowerCase() === "inactive account" ? "false" : "true";
}

/**
 * Keys the Deals payload carries that are NOT Deal properties but are still
 * EXPECTED (consumed elsewhere or structural), so they must not be flagged as
 * unmapped: dedupe/id fallbacks and the nested line-item array.
 */
const DEAL_KNOWN_IGNORED = ["opportunity_id", "oppourtunity_id", "products"];

/** The set of top-level SAP keys we expect on a Deals payload. */
export const DEAL_EXPECTED_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(DEAL_FIELD_MAP),
  ...DEAL_KNOWN_IGNORED,
]);

/** The set of keys we expect on each line item. */
export const LINE_ITEM_EXPECTED_KEYS: ReadonlySet<string> = new Set(
  Object.keys(LINE_ITEM_FIELD_MAP),
);

/** The set of keys we expect on a Companies payload. */
export const COMPANY_EXPECTED_KEYS: ReadonlySet<string> = new Set(
  Object.keys(COMPANY_FIELD_MAP),
);

/** The HubSpot upsert dedupe key for a payload (the SAP-stable id), or null. */
export function dedupKeyFor(
  objectType: HubspotObjectType,
  payload: Record<string, unknown>,
): string | null {
  const raw =
    objectType === "deals" ? payload.quotation_number : payload.account_number_;
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s.length ? s : null;
}

/**
 * The SAP "last changed" timestamp (ISO) for the Phase-2 out-of-order guard, or
 * null. Only Deals carry quote_last_changed_date; Companies have no change-date.
 */
export function sapChangedAtFor(
  objectType: HubspotObjectType,
  payload: Record<string, unknown>,
): string | null {
  if (objectType !== "deals") return null;
  const raw = payload.quote_last_changed_date;
  if (raw === null || raw === undefined || raw === "") return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Copy mapped fields from a source object into HubSpot property shape, skipping
 * empty/null/undefined values (mirrors the Lambda's mapFields).
 */
export function mapFields(
  source: Record<string, unknown>,
  fieldMap: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [src, tgt] of Object.entries(fieldMap)) {
    const v = source?.[src];
    if (v !== undefined && v !== null && v !== "") out[tgt] = v;
  }
  return out;
}

/**
 * Coerce a value to a number, tolerating SAP strings ("$1,234.50"). Returns the
 * original value unchanged when it isn't numeric (mirrors the Lambda's toNumber).
 */
export function toNumber(v: unknown): unknown {
  if (v === null || v === undefined || v === "") return v;
  const n = Number(String(v).replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : v;
}

/** A percent value -> decimal (commission/discount come from SAP as whole percents). */
export function toDecimalPercent(v: unknown): unknown {
  if (v === null || v === undefined || v === "") return v;
  const n = Number(String(v).replace(/[%,]/g, "").trim());
  return Number.isFinite(n) ? n / 100 : v;
}

/**
 * Convert a SAP date string to the value a HubSpot DATE property accepts: a
 * midnight-UTC UNIX timestamp in milliseconds. The feed has delivered both
 * `MM/DD/YYYY` (through 2026-06-25) and ISO `YYYY-MM-DD` (since 2026-06-26),
 * so both are accepted. SAP's null sentinels `00/00/0000` / `0000-00-00` (and
 * anything unparseable) return null so the caller omits the property.
 * Without this, raw date strings hit the enum self-heal and get dropped as
 * "no allowed option matched" (these properties are date-typed, no options).
 */
export function toHubspotDate(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  let mm: number;
  let dd: number;
  let yyyy: number;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    mm = Number(us[1]);
    dd = Number(us[2]);
    yyyy = Number(us[3]);
  } else {
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!iso) return null;
    yyyy = Number(iso[1]);
    mm = Number(iso[2]);
    dd = Number(iso[3]);
  }
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || yyyy < 1900) return null; // e.g. 00/00/0000
  const ms = Date.UTC(yyyy, mm - 1, dd);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * HubSpot DATE-typed properties (target names) that receive SAP date strings
 * and must be converted via toHubspotDate before push. Their HubSpot type is
 * `date` with no options, so they must NOT go through the enum heal.
 */
export const DEAL_DATE_FIELDS: readonly string[] = [
  "quote_follow_up_1",
  "quote_follow_up_2",
  "quote_follow_up_3",
  "completed_quote_follow_up_1",
  "completed_quote_follow_up_2",
  "completed_quote_follow_up_3",
  "valid_to",
  "quote_creation_date",
  "quote_last_changed_date",
  "estimated_onsite_date",
  "original_estimated_decision_date",
];

export const LINE_ITEM_DATE_FIELDS: readonly string[] = [
  "rejection_date",
  "quote_conversion_date",
  "sales_order_date",
];

/** An incoming key with no mapping/known purpose — surfaced in the dashboard. */
export interface UnmappedField {
  objectType: "deals" | "line_items" | "companies";
  property: string;
}

/**
 * Find incoming keys that aren't mapped and aren't known-ignored — i.e. data
 * SAP is sending that we silently drop today. For Deals this also scans the
 * union of keys across the `products` line items.
 */
export function detectUnmappedFields(
  objectType: HubspotObjectType,
  payload: Record<string, unknown>,
): UnmappedField[] {
  const out: UnmappedField[] = [];

  if (objectType === "companies") {
    for (const key of Object.keys(payload)) {
      if (!COMPANY_EXPECTED_KEYS.has(key)) {
        out.push({ objectType: "companies", property: key });
      }
    }
    return out;
  }

  // deals
  for (const key of Object.keys(payload)) {
    if (!DEAL_EXPECTED_KEYS.has(key)) {
      out.push({ objectType: "deals", property: key });
    }
  }
  const products = payload.products;
  if (Array.isArray(products)) {
    const seen = new Set<string>();
    for (const line of products) {
      if (!line || typeof line !== "object") continue;
      for (const key of Object.keys(line as Record<string, unknown>)) {
        if (!LINE_ITEM_EXPECTED_KEYS.has(key) && !seen.has(key)) {
          seen.add(key);
          out.push({ objectType: "line_items", property: key });
        }
      }
    }
  }
  return out;
}
