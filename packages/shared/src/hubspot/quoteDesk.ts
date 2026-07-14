/**
 * Quote Desk — pure logic shared by the API Worker and the HubSpot UI-extension
 * card (apps/quote-desk): quoting teams, the per-request-type field contract
 * (which deal properties a quote request must carry), the ticket-lifecycle
 * decision that encodes the quoting team's rules, and the fake-email guard for
 * Zendesk requesters.
 *
 * Model (per Davis, 2026-07-14): the requester first picks the QUOTING TEAM
 * (WAC is live; Schonbek and Custom/International are greyed-out placeholders
 * until their back-ends exist), then the REQUEST TYPE — which mirrors the
 * Zendesk "(Quotes) Task Type(s)" options exactly, because the deal property
 * how_can_we_help shares its internal values with that Zendesk field (the
 * retired form passed them straight through). Whether a request is a
 * continuation of an existing quote is a property of the request type
 * (Revise…) — not a separate question.
 *
 * The Worker re-validates with this same spec (served to the card via
 * GET /api/quote-desk/spec) — the card can't be the only guard.
 */

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export type QuoteTeam = "wac" | "schonbek" | "custom_international";

export interface QuoteTeamSpec {
  id: QuoteTeam;
  label: string;
  /** false = shown greyed-out in the card; the Worker rejects submissions. */
  enabled: boolean;
}

export const QUOTE_TEAMS: QuoteTeamSpec[] = [
  { id: "wac", label: "WAC Architectural / WAC Lighting / Modern Forms", enabled: true },
  { id: "schonbek", label: "Schonbek (coming soon)", enabled: false },
  { id: "custom_international", label: "Custom / International (coming soon)", enabled: false },
];

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export interface QuoteRequestFieldSpec {
  /** HubSpot deal property name — also the submit-payload key. */
  name: string;
  label: string;
  kind: "text" | "textarea" | "date" | "select" | "number";
  /** Select options — internal property values (they match the live deal
   *  property definitions, verified against the portal 2026-07-14). */
  options?: { value: string; label: string }[];
  /** PATCH the value back onto the deal on submit (deal = source of truth). */
  writeBack?: boolean;
}

export const QUOTE_REQUEST_FIELDS: Record<string, QuoteRequestFieldSpec> = {
  subject: { name: "subject", label: "Subject", kind: "text" },
  account_number: {
    name: "account_number",
    label: "Account Number",
    kind: "text",
    writeBack: true,
  },
  // Rep code — the SAP sync derives sales_group from the deal's rep-code
  // association, so the card only reads/collects it (no write-back that the
  // next SAP push would fight).
  sales_group: {
    name: "sales_group",
    label: "Rep Code",
    kind: "text",
  },
  quote_request_notes: {
    name: "quote_request_notes",
    label: "Request notes",
    kind: "textarea",
  },
  quote_needed_by: {
    name: "quote_needed_by",
    label: "Quote needed by",
    kind: "date",
    writeBack: true,
  },
  sap_quote_number: {
    name: "sap_quote_number",
    label: "SAP Quote Number",
    kind: "number",
  },
  so_number: { name: "so_number", label: "SO Number", kind: "text" },
  po_number: { name: "po_number", label: "PO Number", kind: "text" },
  discount_request: {
    name: "discount_request",
    label: "Discount request",
    kind: "select",
    options: [
      { value: "quotes_discount_yes", label: "Yes" },
      { value: "quotes_discount_no", label: "No" },
    ],
    writeBack: true,
  },
  air_freight_pricing: {
    name: "air_freight_pricing",
    label: "Air freight pricing",
    kind: "select",
    options: [
      { value: "air_freight_pricing_yes", label: "Yes" },
      { value: "air_freight_pricing_no", label: "No" },
    ],
    writeBack: true,
  },
  do_you_need_submittal_layout_support: {
    name: "do_you_need_submittal_layout_support",
    label: "Submittal / layout support",
    kind: "select",
    options: [
      { value: "q_backlighting_layout", label: "Backlighting Layout" },
      { value: "q_colorscaping_layout", label: "Colorscaping Layout" },
      { value: "q_downlight_layout", label: "Downlight Layout" },
      { value: "q_landscape_layout", label: "Landscape Layout" },
      { value: "q_multi-type_build_layout", label: "Multi-Type Build Layout" },
      { value: "q_track_layout", label: "Track Layout" },
      { value: "q_undercabinet-cove_layout", label: "Undercabinet/Cove Layout" },
      { value: "q_ventrix_layout", label: "Ventrix Layout" },
    ],
    writeBack: true,
  },
  project_location: {
    name: "project_location",
    label: "Project location",
    kind: "textarea",
    writeBack: true,
  },
  estimated_onsite_date: {
    name: "estimated_onsite_date",
    label: "Estimated on-site date",
    kind: "date",
    writeBack: true,
  },
  hs_priority: {
    name: "hs_priority",
    label: "Priority",
    kind: "select",
    options: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
  },
};

// ---------------------------------------------------------------------------
// Request types (WAC team) — mirror the Zendesk "(Quotes) Task Type(s)" options
// ---------------------------------------------------------------------------

export interface QuoteTaskTypeSpec {
  /** Internal value of the deal property how_can_we_help == the value the
   *  Zendesk Task Type(s) field receives (pass-through, as the old form did). */
  value: string;
  label: string;
  /** Continuation of an existing quote: requires the SAP quote number and
   *  drives the ticket lifecycle (comment/reopen/follow-up vs fresh ticket). */
  continuation: boolean;
  required: string[];
  optional: string[];
}

const STANDARD_OPTIONALS = [
  "discount_request",
  "air_freight_pricing",
  "do_you_need_submittal_layout_support",
  "project_location",
  "estimated_onsite_date",
  "hs_priority",
  "so_number",
  "po_number",
];

const REVISION_OPTIONALS = [
  "subject",
  "quote_needed_by",
  "discount_request",
  "air_freight_pricing",
  "do_you_need_submittal_layout_support",
  "so_number",
  "po_number",
];

export const WAC_TASK_TYPES: QuoteTaskTypeSpec[] = [
  {
    value: "new_quote",
    label: "Standard Quotation",
    continuation: false,
    required: ["subject", "account_number", "sales_group", "quote_request_notes", "quote_needed_by"],
    optional: STANDARD_OPTIONALS,
  },
  {
    value: "custom_quotation_review",
    label: "Custom Quotation",
    continuation: false,
    required: ["subject", "account_number", "sales_group", "quote_request_notes", "quote_needed_by"],
    optional: STANDARD_OPTIONALS,
  },
  {
    value: "quote_revision",
    label: "Revise Quotation",
    continuation: true,
    required: ["account_number", "sap_quote_number", "quote_request_notes"],
    optional: ["sales_group", ...REVISION_OPTIONALS],
  },
  {
    value: "custom_quote_revision",
    label: "Revise Custom Quotation",
    continuation: true,
    required: ["account_number", "sap_quote_number", "quote_request_notes"],
    optional: ["sales_group", ...REVISION_OPTIONALS],
  },
  {
    value: "color_chip_request",
    label: "Color Chip Request",
    continuation: false,
    required: ["account_number", "sales_group", "quote_request_notes"],
    optional: ["quote_needed_by", "project_location"],
  },
];

export function taskTypeSpec(value: string): QuoteTaskTypeSpec | undefined {
  return WAC_TASK_TYPES.find((t) => t.value === value);
}

/** Missing required fields for a submission (empty array = valid). */
export function missingQuoteRequestFields(
  taskType: string,
  values: Record<string, unknown>,
): string[] {
  const spec = taskTypeSpec(taskType);
  if (!spec) return ["request_type"];
  return spec.required.filter((name) => {
    const v = values[name];
    return v === null || v === undefined || String(v).trim() === "";
  });
}

// ---------------------------------------------------------------------------
// Ticket lifecycle
// ---------------------------------------------------------------------------

export type ZendeskStatus = "new" | "open" | "pending" | "hold" | "solved" | "closed";

const ACTIVE_STATUSES: ZendeskStatus[] = ["new", "open", "pending", "hold"];

export type TicketAction =
  | { kind: "comment"; ticketId: number }
  | { kind: "followup"; sourceId: number }
  | { kind: "create" };

/**
 * The quoting team's lifecycle rule (Janelle), corrected against Zendesk
 * semantics — solved tickets CAN take a public comment (which reopens them);
 * closed tickets can never be touched and only support follow-up tickets:
 *
 *   - an active ticket exists            → append a comment to the newest one
 *   - newest ticket is solved:
 *       continuation (Revise…)           → comment (reopens — same task)
 *       anything else (a NEW quote ask)  → fresh ticket ("solved means done")
 *   - newest ticket is closed:
 *       continuation                     → new ticket linked via
 *                                          via_followup_source_id
 *       anything else                    → fresh unlinked ticket
 *   - no prior ticket                    → fresh ticket
 */
export function decideTicketAction(
  existing: { id: number; status: ZendeskStatus }[],
  isContinuation: boolean,
): TicketAction {
  const newestFirst = [...existing].sort((a, b) => b.id - a.id);
  const active = newestFirst.find((t) => ACTIVE_STATUSES.includes(t.status));
  if (active) return { kind: "comment", ticketId: active.id };

  const newest = newestFirst[0];
  if (!newest) return { kind: "create" };
  if (newest.status === "solved" && isContinuation) return { kind: "comment", ticketId: newest.id };
  if (newest.status === "closed" && isContinuation) return { kind: "followup", sourceId: newest.id };
  return { kind: "create" };
}

// ---------------------------------------------------------------------------
// Fake-email guard
// ---------------------------------------------------------------------------

/**
 * Zendesk mints placeholder addresses for requesters it has no real email for
 * (channel integrations, agent-created users). Those must never become — or
 * match — HubSpot contacts. Patterns are deliberately broad and get tuned
 * against real traffic during the dark launch (flagged rows carry
 * requester_email_fake, so misses are queryable).
 */
export function isFakeZendeskEmail(email: string | null | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (!e || !e.includes("@")) return true;
  return (
    /\.zendesk\.com$/.test(e) || // user@{subdomain}.zendesk.com placeholders
    /@example\.(com|org|net)$/.test(e) ||
    /\.invalid$/.test(e) ||
    /^(invalid|noemail|no-email|noreply|no-reply|donotreply)@/.test(e) ||
    /@(invalid|noemail|no-email|none|unknown)\./.test(e)
  );
}
