/**
 * Quote Desk — pure logic shared by the API Worker and the HubSpot UI-extension
 * card (apps/quote-desk): the per-request-type field contract (which deal
 * properties a quote request must carry), the ticket-lifecycle decision that
 * encodes the quoting team's rules, and the fake-email guard for Zendesk
 * requesters.
 *
 * Replaces the long prefilled HubSpot form + make.com scenario: the card
 * renders these fields from live deal properties and blocks submit until the
 * required set is complete; the Worker re-validates with the same spec (the
 * endpoint is also the future OA/international entry point, so the card can't
 * be the only guard).
 */

/** The card's request types. All land in Zendesk in v1; custom/schonbek/
 *  international will grow their own back-ends (OA) behind the same type. */
export type QuoteRequestType =
  | "new"
  | "revision"
  | "followup_change"
  | "custom"
  | "schonbek"
  | "international";

export const QUOTE_REQUEST_TYPES: QuoteRequestType[] = [
  "new",
  "revision",
  "followup_change",
  "custom",
  "schonbek",
  "international",
];

export interface QuoteRequestFieldSpec {
  /** HubSpot deal property name — also the submit-payload key. */
  name: string;
  label: string;
  kind: "text" | "textarea" | "date" | "select" | "checkbox";
  /** Select options (value = HubSpot property option value). */
  options?: string[];
  /** PATCH the value back onto the deal on submit (deal = source of truth). */
  writeBack?: boolean;
}

/**
 * Every field the card can render, keyed by deal property name. Mirrors the
 * retired form/make.com field set. Option lists intentionally short — the card
 * pulls live options from the deal property definition where it can; these are
 * fallbacks.
 */
export const QUOTE_REQUEST_FIELDS: Record<string, QuoteRequestFieldSpec> = {
  subject: { name: "subject", label: "Subject", kind: "text" },
  account_number: {
    name: "account_number",
    label: "Account Number",
    kind: "text",
    writeBack: true,
  },
  how_can_we_help: {
    name: "how_can_we_help",
    label: "How can we help?",
    kind: "select",
    // Maps to Zendesk "(Quotes) Task Type(s)". Values must match the deal
    // property's options — confirm the canonical list with quoting (SOP).
    options: [],
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
    kind: "text",
  },
  so_number: { name: "so_number", label: "SO Number", kind: "text" },
  po_number: { name: "po_number", label: "PO Number", kind: "text" },
  discount_request: {
    name: "discount_request",
    label: "Discount request",
    kind: "text",
    writeBack: true,
  },
  air_freight_pricing: {
    name: "air_freight_pricing",
    label: "Air freight pricing",
    kind: "checkbox",
    writeBack: true,
  },
  do_you_need_submittal_layout_support: {
    name: "do_you_need_submittal_layout_support",
    label: "Submittal / layout support",
    kind: "checkbox",
    writeBack: true,
  },
  project_location: {
    name: "project_location",
    label: "Project location",
    kind: "text",
    writeBack: true,
  },
  estimated_onsite_date: {
    name: "estimated_onsite_date",
    label: "Estimated on-site date",
    kind: "date",
    writeBack: true,
  },
  hs_priority: { name: "hs_priority", label: "Priority", kind: "select", options: [] },
};

/**
 * Required/optional field names per request type. The required split is the
 * validation contract on BOTH sides (card blocks submit; Worker returns 422
 * with the missing list). Pending Janelle's SOP review — deliberately lean:
 * every required field here is one her team currently rejects tickets over.
 */
export const QUOTE_REQUEST_TYPE_SPECS: Record<
  QuoteRequestType,
  { label: string; required: string[]; optional: string[] }
> = {
  new: {
    label: "New quote",
    required: ["subject", "account_number", "how_can_we_help", "quote_request_notes", "quote_needed_by"],
    optional: [
      "discount_request",
      "air_freight_pricing",
      "do_you_need_submittal_layout_support",
      "project_location",
      "estimated_onsite_date",
      "hs_priority",
      "so_number",
      "po_number",
    ],
  },
  revision: {
    label: "Quote revision",
    required: ["subject", "account_number", "sap_quote_number", "quote_request_notes"],
    optional: [
      "quote_needed_by",
      "discount_request",
      "air_freight_pricing",
      "do_you_need_submittal_layout_support",
      "so_number",
      "po_number",
    ],
  },
  followup_change: {
    label: "Follow-up / small change",
    // The "extend my expiration date" path — intentionally minimal.
    required: ["account_number", "sap_quote_number", "quote_request_notes"],
    optional: ["quote_needed_by"],
  },
  custom: {
    label: "Custom quote",
    required: ["subject", "account_number", "quote_request_notes", "quote_needed_by"],
    optional: ["project_location", "estimated_onsite_date", "hs_priority"],
  },
  schonbek: {
    label: "Schonbek quote",
    required: ["subject", "account_number", "quote_request_notes", "quote_needed_by"],
    optional: ["project_location", "estimated_onsite_date", "hs_priority"],
  },
  international: {
    label: "International quote",
    required: ["subject", "account_number", "quote_request_notes", "quote_needed_by"],
    optional: ["project_location", "estimated_onsite_date", "hs_priority"],
  },
};

/** Missing required fields for a submission (empty array = valid). */
export function missingQuoteRequestFields(
  type: QuoteRequestType,
  values: Record<string, unknown>,
): string[] {
  const spec = QUOTE_REQUEST_TYPE_SPECS[type];
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
 *       revision / follow-up change      → comment (reopens — same task)
 *       anything else (a NEW quote ask)  → fresh ticket ("solved means done")
 *   - newest ticket is closed:
 *       revision / follow-up change      → new ticket linked via
 *                                          via_followup_source_id
 *       anything else                    → fresh unlinked ticket
 *   - no prior ticket                    → fresh ticket
 */
export function decideTicketAction(
  existing: { id: number; status: ZendeskStatus }[],
  requestType: QuoteRequestType,
): TicketAction {
  const newestFirst = [...existing].sort((a, b) => b.id - a.id);
  const active = newestFirst.find((t) => ACTIVE_STATUSES.includes(t.status));
  if (active) return { kind: "comment", ticketId: active.id };

  const isContinuation = requestType === "revision" || requestType === "followup_change";
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
