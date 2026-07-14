import {
  decideTicketAction,
  missingQuoteRequestFields,
  QUOTE_REQUEST_FIELDS,
  QUOTE_REQUEST_TYPE_SPECS,
  type QuoteRequestType,
  type ZendeskStatus,
} from "@wac/shared";
import type { Env } from "./env.js";
import { hs, PATHS } from "./hubspotPush.js";
import { serviceSupabase } from "./supabase.js";
import {
  ZD,
  ZD_FIELDS,
  ZD_QUOTES_GROUP,
  zd,
  zendeskTicketUrl,
} from "./zendesk.js";
import { syncZendeskTicket } from "./zendeskSync.js";

/**
 * Quote Desk orchestration — the card's back end.
 *
 * createQuoteRequest turns a card submission into the right Zendesk action per
 * the quoting team's lifecycle rule (@wac/shared decideTicketAction): comment
 * on an active ticket, reopen a solved one for revisions/follow-ups, linked
 * follow-up ticket for closed ones, fresh ticket otherwise. It also PATCHes
 * the write-back fields onto the deal (the deal is the source of truth — this
 * replaces the prefill-workflow/form round-trip and its race conditions) and
 * mirrors the resulting ticket into HubSpot via syncZendeskTicket.
 *
 * The requester is the SUBMITTING HubSpot user (from HubSpot's server-appended
 * userEmail — see routes/quoteDesk.ts), which fixes the old form's bug of
 * attaching submissions to the quote-recipient contact.
 */

const HS_PORTAL_ID = "46455872";

export interface QuoteRequestPayload {
  requestId: string;
  dealId: string;
  requestType: QuoteRequestType;
  /** Submitting HubSpot user (server-appended by hubspot.fetch, verified). */
  requesterEmail: string;
  requesterName?: string;
  /** Optional deal-associated contact the quote should go to. */
  recipientContactId?: string;
  /** Display name of that contact ("Send quote to" line in the ticket body). */
  recipientName?: string;
  /** Field values keyed by deal property name (see @wac/shared QUOTE_REQUEST_FIELDS). */
  fields: Record<string, string>;
}

export type QuoteRequestResult =
  | { ok: false; status: 400 | 404 | 409 | 422 | 502; error: string; missing?: string[] }
  | {
      ok: true;
      action: "comment" | "followup" | "create" | "duplicate";
      zendeskTicketId: number;
      zendeskUrl: string;
      hubspotTicketId?: string | null;
    };

/**
 * v1 routing: every type lands in the Quotes group. The (Quotes) Category tag
 * stays "quotations" for all types until the real option tags for custom /
 * international are confirmed from the Zendesk field (an unknown tag value
 * fails ticket creation) — the request type is always carried in the subject
 * prefix + body, so the quoting team can still split the work. This table is
 * where the OA/international back-ends will diverge later.
 */
const REQUEST_TYPE_ROUTING: Record<QuoteRequestType, { subjectPrefix: string; category: string }> = {
  new: { subjectPrefix: "Quote Request", category: "quotes_category_quotations" },
  revision: { subjectPrefix: "Quote Revision", category: "quotes_category_quotations" },
  followup_change: { subjectPrefix: "Quote Follow-Up", category: "quotes_category_quotations" },
  custom: { subjectPrefix: "Custom Quote Request", category: "quotes_category_quotations" },
  schonbek: { subjectPrefix: "Schonbek Quote Request", category: "quotes_category_quotations" },
  international: { subjectPrefix: "International Quote Request", category: "quotes_category_quotations" },
};

function dealUrl(dealId: string): string {
  return `https://app.hubspot.com/contacts/${HS_PORTAL_ID}/record/0-3/${dealId}`;
}

/** Compose the ticket/comment body from the submitted fields. */
function requestBody(payload: QuoteRequestPayload, dealName: string | null): string {
  const spec = QUOTE_REQUEST_TYPE_SPECS[payload.requestType];
  const lines: string[] = [
    `${spec.label} — requested by ${payload.requesterName || payload.requesterEmail} via Quote Desk`,
    `Deal: ${dealName ?? payload.dealId} (${dealUrl(payload.dealId)})`,
    `HubSpot ID: ${payload.dealId}`,
  ];
  if (payload.recipientName) lines.push(`Send quote to: ${payload.recipientName}`);
  lines.push("");
  for (const name of [...spec.required, ...spec.optional]) {
    const value = payload.fields[name];
    if (value === undefined || String(value).trim() === "") continue;
    const label = QUOTE_REQUEST_FIELDS[name]?.label ?? name;
    if (name === "quote_request_notes") continue; // notes go last, unlabelled
    lines.push(`${label}: ${String(value).trim()}`);
  }
  const notes = payload.fields.quote_request_notes?.trim();
  if (notes) lines.push("", notes);
  return lines.join("\n");
}

/** Zendesk custom fields for a created ticket, from the submitted fields. */
function zendeskCustomFields(payload: QuoteRequestPayload): { id: number; value: string }[] {
  const f = payload.fields;
  const out: { id: number; value: string }[] = [
    { id: ZD_FIELDS.hubspotDealId, value: payload.dealId },
    { id: ZD_FIELDS.category, value: REQUEST_TYPE_ROUTING[payload.requestType].category },
    { id: ZD_FIELDS.requestor, value: payload.requesterName || payload.requesterEmail },
  ];
  const put = (id: number, v: string | undefined) => {
    if (v && v.trim()) out.push({ id, value: v.trim() });
  };
  put(ZD_FIELDS.quoteNumber, f.sap_quote_number);
  put(ZD_FIELDS.accountNumber, f.account_number);
  put(ZD_FIELDS.taskTypes, f.how_can_we_help);
  put(ZD_FIELDS.needDate, f.quote_needed_by);
  put(ZD_FIELDS.soNumber, f.so_number);
  put(ZD_FIELDS.poNumber, f.po_number);
  put(ZD_FIELDS.specialPricing, f.discount_request);
  put(ZD_FIELDS.airFreight, f.air_freight_pricing);
  put(ZD_FIELDS.submittalNeeded, f.do_you_need_submittal_layout_support);
  put(ZD_FIELDS.projectLocation, f.project_location);
  return out;
}

/** Live statuses for the deal's known quote tickets (mapping ∪ Zendesk truth). */
async function dealQuoteTickets(
  env: Env,
  sb: ReturnType<typeof serviceSupabase>,
  dealId: string,
  signal: AbortSignal,
): Promise<{ id: number; status: ZendeskStatus }[]> {
  const { data: rows } = await sb
    .from("zendesk_tickets")
    .select("zendesk_ticket_id, zd_status, zd_group_id")
    .eq("deal_id", dealId);
  const ids = (rows ?? [])
    .filter((r) => Number(r.zd_group_id) === ZD_QUOTES_GROUP || r.zd_group_id === null)
    .map((r) => Number(r.zendesk_ticket_id));
  if (!ids.length) return [];
  const live = await zd(env, "GET", ZD.ticketsShowMany(ids), undefined, signal);
  if (live.ok) {
    return (live.data.tickets ?? []).map((t: { id: number; status: string }) => ({
      id: t.id,
      status: t.status as ZendeskStatus,
    }));
  }
  // Stale-tolerant fallback: the mapping's last known status.
  return (rows ?? []).map((r) => ({
    id: Number(r.zendesk_ticket_id),
    status: (r.zd_status ?? "open") as ZendeskStatus,
  }));
}

/** PATCH the write-back fields onto the deal (deal = source of truth). */
async function writeBackDealProps(
  env: Env,
  payload: QuoteRequestPayload,
  signal: AbortSignal,
): Promise<void> {
  const properties: Record<string, string> = {};
  for (const [name, value] of Object.entries(payload.fields)) {
    if (!QUOTE_REQUEST_FIELDS[name]?.writeBack) continue;
    if (value === undefined || String(value).trim() === "") continue;
    properties[name] = String(value).trim();
  }
  if (!Object.keys(properties).length) return;
  const res = await hs(
    env.HUBSPOT_TOKEN!,
    "PATCH",
    `/crm/v3/objects/0-3/${payload.dealId}`,
    { properties },
    signal,
  );
  if (!res.ok) {
    // Best-effort: a bad option value on one prop must not block the ticket.
    console.error(`[quote-desk] deal ${payload.dealId} write-back failed:`, res.status, res.data);
  }
}

export async function createQuoteRequest(
  env: Env,
  payload: QuoteRequestPayload,
  signal: AbortSignal,
): Promise<QuoteRequestResult> {
  if (!env.HUBSPOT_TOKEN) return { ok: false, status: 502, error: "HUBSPOT_TOKEN unset" };
  if (!QUOTE_REQUEST_TYPE_SPECS[payload.requestType]) {
    return { ok: false, status: 400, error: `unknown request type ${payload.requestType}` };
  }
  const missing = missingQuoteRequestFields(payload.requestType, payload.fields);
  if (missing.length) {
    return { ok: false, status: 422, error: "missing required fields", missing };
  }

  const sb = serviceSupabase(env);

  // Idempotency: a retried submit (double-click, fetch retry) returns the
  // ticket the first attempt created instead of filing a duplicate.
  const { data: dupe } = await sb
    .from("zendesk_tickets")
    .select("zendesk_ticket_id, hubspot_ticket_id")
    .eq("request_id", payload.requestId)
    .maybeSingle();
  if (dupe) {
    return {
      ok: true,
      action: "duplicate",
      zendeskTicketId: Number(dupe.zendesk_ticket_id),
      zendeskUrl: zendeskTicketUrl(env, Number(dupe.zendesk_ticket_id)),
      hubspotTicketId: dupe.hubspot_ticket_id,
    };
  }

  const dealRes = await hs(
    env.HUBSPOT_TOKEN,
    "GET",
    `/crm/v3/objects/0-3/${payload.dealId}?properties=dealname,sap_quote_number`,
    undefined,
    signal,
  );
  if (!dealRes.ok) return { ok: false, status: 404, error: `deal ${payload.dealId} not found` };
  const dealName: string | null = dealRes.data?.properties?.dealname ?? null;

  const existing = await dealQuoteTickets(env, sb, payload.dealId, signal);
  const action = decideTicketAction(existing, payload.requestType);
  const body = requestBody(payload, dealName);
  const routing = REQUEST_TYPE_ROUTING[payload.requestType];

  let zendeskTicketId: number;

  if (action.kind === "comment") {
    // Append to the live conversation. The API user authors the comment; the
    // body's first line carries who actually asked (agents see the requester).
    const upd = await zd(
      env,
      "PUT",
      ZD.ticket(action.ticketId),
      { ticket: { comment: { body, public: true } } },
      signal,
    );
    if (!upd.ok) {
      return { ok: false, status: 502, error: `zendesk comment failed (${upd.status}): ${JSON.stringify(upd.data)}` };
    }
    zendeskTicketId = action.ticketId;
  } else {
    const subject = `${routing.subjectPrefix}: ${payload.fields.subject?.trim() || dealName || payload.dealId}`;
    const create = await zd(
      env,
      "POST",
      ZD.tickets,
      {
        ticket: {
          subject,
          type: "task",
          group_id: ZD_QUOTES_GROUP,
          requester: { name: payload.requesterName || payload.requesterEmail, email: payload.requesterEmail },
          comment: { body, public: true },
          custom_fields: zendeskCustomFields(payload),
          ...(action.kind === "followup" ? { via_followup_source_id: action.sourceId } : {}),
        },
      },
      signal,
    );
    if (!create.ok) {
      return { ok: false, status: 502, error: `zendesk create failed (${create.status}): ${JSON.stringify(create.data)}` };
    }
    zendeskTicketId = Number(create.data.ticket.id);
  }

  // Record the card's claim on this ticket BEFORE the mirror pass so origin /
  // request_type / request_id survive (syncZendeskTicket preserves origin).
  // request_id is recorded for comment actions too: a retried submit (fetch
  // retry after a timeout) hits the dupe-check above instead of re-commenting.
  const { error: upErr } = await sb.from("zendesk_tickets").upsert(
    {
      zendesk_ticket_id: zendeskTicketId,
      request_id: payload.requestId,
      zd_group_id: ZD_QUOTES_GROUP,
      deal_id: payload.dealId,
      request_type: payload.requestType,
      requester_email: payload.requesterEmail,
      quote_number: payload.fields.sap_quote_number || undefined,
      followup_of: action.kind === "followup" ? action.sourceId : undefined,
      origin: "card",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "zendesk_ticket_id" },
  );
  if (upErr) console.error(`[quote-desk] mapping upsert failed:`, upErr.message);

  await writeBackDealProps(env, payload, signal);

  // Mirror now (HS ticket + associations + comment notes) instead of waiting
  // for the webhook round-trip — the card shows the result synchronously.
  let hubspotTicketId: string | null = null;
  try {
    const sync = await syncZendeskTicket(env, zendeskTicketId, signal, sb);
    hubspotTicketId = sync.hubspotTicketId ?? null;
  } catch (e) {
    console.error(`[quote-desk] inline mirror of ${zendeskTicketId} failed (webhook will repair):`, e);
  }

  // Associate the quote-recipient contact (picked from the deal's contacts)
  // to the mirrored ticket — best-effort, the body line is the real record.
  if (hubspotTicketId && payload.recipientContactId && /^\d+$/.test(payload.recipientContactId)) {
    const assoc = await hs(
      env.HUBSPOT_TOKEN,
      "PUT",
      `/crm/v4/objects/tickets/${hubspotTicketId}/associations/default/contacts/${payload.recipientContactId}`,
      undefined,
      signal,
    );
    if (!assoc.ok) {
      console.error(`[quote-desk] recipient association failed:`, assoc.status, assoc.data);
    }
  }

  return {
    ok: true,
    action: action.kind,
    zendeskTicketId,
    zendeskUrl: zendeskTicketUrl(env, zendeskTicketId),
    hubspotTicketId,
  };
}

// ---------------------------------------------------------------------------
// Card reads
// ---------------------------------------------------------------------------

export interface DealTicketSummary {
  zendeskTicketId: number;
  zendeskUrl: string;
  hubspotTicketId: string | null;
  status: string | null;
  subject: string | null;
  requestType: string | null;
  quoteNumber: string | null;
  updatedAt: string | null;
}

/** The deal's mirrored tickets with an opportunistic live-status refresh. */
export async function listDealTickets(
  env: Env,
  dealId: string,
  signal: AbortSignal,
): Promise<DealTicketSummary[]> {
  const sb = serviceSupabase(env);
  const { data: rows } = await sb
    .from("zendesk_tickets")
    .select("zendesk_ticket_id, hubspot_ticket_id, zd_status, request_type, quote_number, last_event_at")
    .eq("deal_id", dealId)
    .order("zendesk_ticket_id", { ascending: false });
  const out: DealTicketSummary[] = (rows ?? []).map((r) => ({
    zendeskTicketId: Number(r.zendesk_ticket_id),
    zendeskUrl: zendeskTicketUrl(env, Number(r.zendesk_ticket_id)),
    hubspotTicketId: r.hubspot_ticket_id,
    status: r.zd_status,
    subject: null,
    requestType: r.request_type,
    quoteNumber: r.quote_number,
    updatedAt: r.last_event_at,
  }));
  if (!out.length) return out;

  const live = await zd(
    env,
    "GET",
    ZD.ticketsShowMany(out.map((t) => t.zendeskTicketId)),
    undefined,
    signal,
  );
  if (live.ok) {
    const byId = new Map<number, { status?: string; subject?: string; updated_at?: string }>(
      (live.data.tickets ?? []).map((t: { id: number }) => [t.id, t]),
    );
    for (const t of out) {
      const l = byId.get(t.zendeskTicketId);
      if (!l) continue;
      t.status = l.status ?? t.status;
      t.subject = l.subject ?? null;
      t.updatedAt = l.updated_at ?? t.updatedAt;
    }
  }
  return out;
}

/** Deal-associated contacts for the recipient picker. */
export async function listDealContacts(
  env: Env,
  dealId: string,
  signal: AbortSignal,
): Promise<{ id: string; name: string; email: string | null }[]> {
  if (!env.HUBSPOT_TOKEN) return [];
  const assoc = await hs(
    env.HUBSPOT_TOKEN,
    "GET",
    `/crm/v4/objects/0-3/${dealId}/associations/contacts?limit=100`,
    undefined,
    signal,
  );
  const ids: string[] = (assoc.ok ? (assoc.data?.results ?? []) : []).map(
    (r: { toObjectId: number | string }) => String(r.toObjectId),
  );
  if (!ids.length) return [];
  const read = await hs(
    env.HUBSPOT_TOKEN,
    "POST",
    "/crm/v3/objects/contacts/batch/read",
    { inputs: ids.map((id) => ({ id })), properties: ["firstname", "lastname", "email"] },
    signal,
  );
  if (!read.ok) return [];
  return (read.data?.results ?? []).map(
    (c: { id: string; properties: Record<string, string | null> }) => ({
      id: c.id,
      name:
        [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" ") ||
        c.properties.email ||
        c.id,
      email: c.properties.email ?? null,
    }),
  );
}
