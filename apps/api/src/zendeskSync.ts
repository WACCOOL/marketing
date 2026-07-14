import type { SupabaseClient } from "@supabase/supabase-js";
import { isFakeZendeskEmail } from "@wac/shared";
import type { Env } from "./env.js";
import { hs, PATHS, ASSOC } from "./hubspotPush.js";
import { serviceSupabase } from "./supabase.js";
import {
  ZD,
  ZD_FIELDS,
  ZD_QUOTES_GROUP,
  customFieldValue,
  parseSyncGroups,
  zd,
  zendeskTicketUrl,
  type ZdGroupConfig,
} from "./zendesk.js";

/**
 * Generic Zendesk -> HubSpot ticket mirror.
 *
 * One entry point — syncZendeskTicket — invoked by the webhook queue consumer,
 * the inline /sync route, the backfill route, and the nightly reconcile. For a
 * ticket in an allowlisted group (ZD_SYNC_GROUPS) it:
 *
 *   1. creates/updates the mirrored HubSpot ticket in the group's pipeline
 *      (stage from the group's Zendesk-status -> stage map),
 *   2. resolves the requester to a HubSpot contact (search by email, create
 *      when missing) and associates ticket<->contact — UNLESS the email is a
 *      Zendesk placeholder (isFakeZendeskEmail): those never touch contacts,
 *   3. (Quotes group) adopts the deal: HubSpot-deal-ID field first, else SAP
 *      quote number -> deal search on sap_quote_number (single match only),
 *      and associates ticket<->deal,
 *   4. mirrors every public comment as ONE Note associated to the ticket (and
 *      the deal, for quote tickets), deduped by Zendesk's stable comment id.
 *
 * Dark launch: when ZENDESK_SYNC_WRITE != "1" nothing is written to HubSpot —
 * the mapping row is still maintained in Supabase (with the computed deal /
 * contact matches and fake-email flags) and every HubSpot write is logged as
 * "[zendesk-sync] would ..." so a week of real traffic validates the mapping
 * before the flag flips.
 */

const write = (env: Env) => env.ZENDESK_SYNC_WRITE === "1";

interface ZdTicket {
  id: number;
  subject?: string;
  description?: string;
  status: string;
  group_id?: number;
  requester_id?: number;
  via?: { followup_source_id?: number };
  custom_fields?: { id: number; value: unknown }[];
  created_at?: string;
  updated_at?: string;
}

interface ZdAttachment {
  id: number;
  file_name: string;
  content_url: string;
  content_type?: string;
  size?: number;
  inline?: boolean;
}

interface ZdComment {
  id: number;
  public: boolean;
  author_id: number;
  plain_body?: string;
  html_body?: string;
  created_at: string;
  attachments?: ZdAttachment[];
}

export interface SyncResult {
  ticketId: number;
  action:
    | "skipped_group"
    | "skipped_unconfigured"
    | "error"
    | "synced"
    | "would_sync";
  group?: string;
  error?: string;
  dealId?: string | null;
  dealMatch?: "deal_id_field" | "quote_number" | "existing" | "none" | "ambiguous";
  contactId?: string | null;
  contactCreated?: boolean;
  fakeEmail?: boolean;
  hubspotTicketId?: string | null;
  hubspotTicketCreated?: boolean;
  stage?: string | null;
  notesCreated?: number;
  notesPending?: number;
}

/** Mapping row as stored in zendesk_tickets (subset we read/write here). */
interface MappingRow {
  zendesk_ticket_id: number;
  hubspot_ticket_id: string | null;
  deal_id: string | null;
  contact_id: string | null;
  request_type?: string | null;
  origin?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Note body: author + timestamp header, then the comment (plain, escaped). */
function noteBody(author: string, createdAt: string, plain: string): string {
  const when = createdAt.slice(0, 16).replace("T", " ");
  const body = esc(plain).replace(/\r?\n/g, "<br>");
  return `<strong>${esc(author)}</strong> <em>(Zendesk, ${esc(when)} UTC)</em><br><br>${body}`;
}

// Attachments above this size are linked in the note body instead of copied
// into HubSpot Files (Workers memory + Files API practicality).
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Copy a Zendesk comment attachment into HubSpot Files; returns the file id.
 * Zendesk's content_url 302s to a presigned S3 URL that REJECTS an
 * Authorization header, so the redirect is followed manually without auth.
 */
async function mirrorAttachment(
  env: Env,
  att: ZdAttachment,
  signal: AbortSignal,
): Promise<string | null> {
  const auth = btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`);
  let res = await fetch(att.content_url, {
    headers: { authorization: `Basic ${auth}` },
    redirect: "manual",
    signal,
  });
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) {
    res = await fetch(location, { signal });
  }
  if (!res.ok) {
    console.error(`[zendesk-sync] attachment ${att.id} download failed: ${res.status}`);
    return null;
  }
  const blob = await res.blob();
  if (blob.size > MAX_ATTACHMENT_BYTES) return null;

  const form = new FormData();
  form.append("file", blob, att.file_name || `zendesk-attachment-${att.id}`);
  form.append("options", JSON.stringify({ access: "PRIVATE", overwrite: false }));
  form.append("folderPath", "/zendesk-attachments");
  const up = await fetch("https://api.hubapi.com/files/v3/files", {
    method: "POST",
    headers: { authorization: `Bearer ${env.HUBSPOT_TOKEN}` },
    body: form,
    signal,
  });
  if (!up.ok) {
    console.error(`[zendesk-sync] attachment ${att.id} upload failed: ${up.status}`, await up.text());
    return null;
  }
  const data: { id?: string } = await up.json();
  return data.id ? String(data.id) : null;
}

/** Mirror a comment's attachments; returns HubSpot file ids + not-copied leftovers. */
async function mirrorAttachments(
  env: Env,
  comment: ZdComment,
  signal: AbortSignal,
): Promise<{ fileIds: string[]; skipped: ZdAttachment[] }> {
  const fileIds: string[] = [];
  const skipped: ZdAttachment[] = [];
  for (const att of comment.attachments ?? []) {
    if (att.inline) continue; // embedded signature images etc. — noise
    if ((att.size ?? 0) > MAX_ATTACHMENT_BYTES) {
      skipped.push(att);
      continue;
    }
    try {
      const id = await mirrorAttachment(env, att, signal);
      if (id) fileIds.push(id);
      else skipped.push(att);
    } catch (e) {
      console.error(`[zendesk-sync] attachment ${att.id} mirror failed:`, e);
      skipped.push(att);
    }
  }
  return { fileIds, skipped };
}

async function findDealByQuoteNumber(
  env: Env,
  quoteNumber: string,
  signal: AbortSignal,
): Promise<{ id: string | null; match: "quote_number" | "none" | "ambiguous" }> {
  const res = await hs(
    env.HUBSPOT_TOKEN!,
    "POST",
    PATHS.dealSearch,
    {
      filterGroups: [
        {
          filters: [
            { propertyName: "sap_quote_number", operator: "EQ", value: quoteNumber },
          ],
        },
      ],
      properties: ["sap_quote_number"],
      limit: 2,
    },
    signal,
  );
  const results: { id: string }[] = res.ok ? (res.data?.results ?? []) : [];
  if (results.length === 1) return { id: results[0]!.id, match: "quote_number" };
  if (results.length > 1) return { id: null, match: "ambiguous" };
  return { id: null, match: "none" };
}

/** Search a contact by email; create it when missing (real emails only). */
async function resolveContact(
  env: Env,
  email: string,
  name: string | undefined,
  signal: AbortSignal,
): Promise<{ id: string | null; created: boolean }> {
  const search = await hs(
    env.HUBSPOT_TOKEN!,
    "POST",
    PATHS.contactSearch,
    {
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "EQ", value: email.toLowerCase() }] },
      ],
      properties: ["email"],
      limit: 1,
    },
    signal,
  );
  const found = search.ok ? search.data?.results?.[0]?.id : null;
  if (found) return { id: String(found), created: false };

  if (!write(env)) {
    console.log(`[zendesk-sync] would create contact ${email}`);
    return { id: null, created: false };
  }
  const parts = (name ?? "").trim().split(/\s+/);
  const properties: Record<string, string> = { email: email.toLowerCase() };
  if (parts[0]) properties.firstname = parts[0];
  if (parts.length > 1) properties.lastname = parts.slice(1).join(" ");
  const created = await hs(env.HUBSPOT_TOKEN!, "POST", PATHS.contactCreate, { properties }, signal);
  if (!created.ok) {
    console.error(`[zendesk-sync] contact create for ${email} failed:`, created.status, created.data);
    return { id: null, created: false };
  }
  return { id: String(created.data.id), created: true };
}

/** Default-typed v4 association (idempotent — re-PUT is a no-op). */
async function associate(
  env: Env,
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  signal: AbortSignal,
): Promise<void> {
  if (!write(env)) {
    console.log(`[zendesk-sync] would associate ${fromType} ${fromId} -> ${toType} ${toId}`);
    return;
  }
  const res = await hs(
    env.HUBSPOT_TOKEN!,
    "PUT",
    `/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`,
    undefined,
    signal,
  );
  if (!res.ok) {
    console.error(
      `[zendesk-sync] associate ${fromType} ${fromId} -> ${toType} ${toId} failed:`,
      res.status,
      res.data,
    );
  }
}

export async function syncZendeskTicket(
  env: Env,
  ticketId: number,
  signal: AbortSignal,
  sbIn?: SupabaseClient,
): Promise<SyncResult> {
  if (!env.HUBSPOT_TOKEN) {
    return { ticketId, action: "skipped_unconfigured", error: "HUBSPOT_TOKEN unset" };
  }
  const groups = parseSyncGroups(env);
  if (groups.size === 0) {
    return { ticketId, action: "skipped_unconfigured", error: "ZD_SYNC_GROUPS unset/empty" };
  }

  const tRes = await zd(env, "GET", ZD.ticket(ticketId), undefined, signal);
  if (!tRes.ok) {
    return { ticketId, action: "error", error: `zendesk ticket fetch ${tRes.status}` };
  }
  const ticket: ZdTicket = tRes.data.ticket;
  const group = ticket.group_id ? groups.get(ticket.group_id) : undefined;
  if (!group) return { ticketId, action: "skipped_group" };

  const sb = sbIn ?? serviceSupabase(env);
  const { data: existingRow } = await sb
    .from("zendesk_tickets")
    .select("zendesk_ticket_id, hubspot_ticket_id, deal_id, contact_id, request_type, origin")
    .eq("zendesk_ticket_id", ticketId)
    .maybeSingle<MappingRow>();

  const result: SyncResult = {
    ticketId,
    action: write(env) ? "synced" : "would_sync",
    group: group.name,
    dealId: existingRow?.deal_id ?? null,
    dealMatch: existingRow?.deal_id ? "existing" : "none",
    contactId: existingRow?.contact_id ?? null,
    hubspotTicketId: existingRow?.hubspot_ticket_id ?? null,
    notesCreated: 0,
    notesPending: 0,
  };

  // ---- deal adoption (Quotes group only) ---------------------------------
  const quoteNumber = customFieldValue(ticket, ZD_FIELDS.quoteNumber);
  if (!result.dealId && ticket.group_id === ZD_QUOTES_GROUP) {
    const fieldDealId = customFieldValue(ticket, ZD_FIELDS.hubspotDealId);
    if (fieldDealId && /^\d+$/.test(fieldDealId)) {
      result.dealId = fieldDealId;
      result.dealMatch = "deal_id_field";
    } else if (quoteNumber) {
      const found = await findDealByQuoteNumber(env, quoteNumber, signal);
      result.dealId = found.id;
      result.dealMatch = found.match;
      if (found.match === "ambiguous") {
        console.log(`[zendesk-sync] ticket ${ticketId}: quote # ${quoteNumber} matches >1 deal; not adopting`);
      }
    }
  }

  // ---- contact resolution -------------------------------------------------
  let requesterEmail: string | null = null;
  let requesterName: string | undefined;
  if (!result.contactId && ticket.requester_id) {
    const uRes = await zd(env, "GET", ZD.user(ticket.requester_id), undefined, signal);
    if (uRes.ok) {
      requesterEmail = uRes.data.user?.email ?? null;
      requesterName = uRes.data.user?.name ?? undefined;
    }
    result.fakeEmail = isFakeZendeskEmail(requesterEmail);
    if (result.fakeEmail) {
      console.log(`[zendesk-sync] ticket ${ticketId}: requester email ${requesterEmail ?? "(none)"} looks fake; skipping contact`);
    } else if (requesterEmail) {
      const contact = await resolveContact(env, requesterEmail, requesterName, signal);
      result.contactId = contact.id;
      result.contactCreated = contact.created;
    }
  }

  // ---- HubSpot ticket create / update ------------------------------------
  const stage = group.stages[ticket.status] ?? null;
  result.stage = stage;
  if (!stage) {
    console.error(`[zendesk-sync] ticket ${ticketId}: no stage mapped for status "${ticket.status}" in group ${group.name}`);
  }
  const props: Record<string, string> = {
    subject: ticket.subject || `Zendesk ticket ${ticketId}`,
    hs_pipeline: group.pipelineId,
    ...(stage ? { hs_pipeline_stage: stage } : {}),
    zendesk_ticket_id: String(ticketId),
    zendesk_ticket_url: zendeskTicketUrl(env, ticketId),
    zendesk_group: group.name,
  };

  if (!write(env)) {
    console.log(
      `[zendesk-sync] would ${result.hubspotTicketId ? "update" : "create"} HS ticket for ZD ${ticketId}`,
      JSON.stringify({ props, dealId: result.dealId, contactId: result.contactId }),
    );
  } else if (result.hubspotTicketId) {
    const upd = await hs(
      env.HUBSPOT_TOKEN,
      "PATCH",
      `${PATHS.ticketCreate}/${result.hubspotTicketId}`,
      { properties: props },
      signal,
    );
    if (!upd.ok) {
      return { ...result, action: "error", error: `HS ticket update ${upd.status}: ${JSON.stringify(upd.data)}` };
    }
  } else {
    const associations: unknown[] = [];
    if (result.dealId) {
      associations.push({
        to: { id: result.dealId },
        types: [{ associationCategory: ASSOC.category, associationTypeId: ASSOC.ticketToDeal }],
      });
    }
    if (result.contactId) {
      associations.push({
        to: { id: result.contactId },
        types: [{ associationCategory: ASSOC.category, associationTypeId: ASSOC.ticketToContact }],
      });
    }
    const created = await hs(
      env.HUBSPOT_TOKEN,
      "POST",
      PATHS.ticketCreate,
      { properties: props, ...(associations.length ? { associations } : {}) },
      signal,
    );
    if (!created.ok) {
      return { ...result, action: "error", error: `HS ticket create ${created.status}: ${JSON.stringify(created.data)}` };
    }
    result.hubspotTicketId = String(created.data.id);
    result.hubspotTicketCreated = true;
  }

  // Late associations (deal/contact resolved after the HS ticket existed).
  if (result.hubspotTicketId && !result.hubspotTicketCreated) {
    if (result.dealId && result.dealMatch !== "existing") {
      await associate(env, "tickets", result.hubspotTicketId, "deals", result.dealId, signal);
    }
    if (result.contactId && !existingRow?.contact_id) {
      await associate(env, "tickets", result.hubspotTicketId, "contacts", result.contactId, signal);
    }
  }

  // ---- comment mirror -----------------------------------------------------
  const cRes = await zd(env, "GET", ZD.comments(ticketId), undefined, signal);
  if (cRes.ok) {
    const comments: ZdComment[] = (cRes.data.comments ?? []).filter((c: ZdComment) => c.public);
    const authors = new Map<number, string>(
      (cRes.data.users ?? []).map((u: { id: number; name?: string }) => [u.id, u.name ?? "Unknown"]),
    );
    const ids = comments.map((c) => c.id);
    const seen = new Set<number>();
    if (ids.length) {
      const { data: rows } = await sb
        .from("zendesk_ticket_comments")
        .select("zendesk_comment_id")
        .in("zendesk_comment_id", ids);
      for (const r of rows ?? []) seen.add(Number(r.zendesk_comment_id));
    }
    for (const comment of comments) {
      if (seen.has(comment.id)) continue;
      if (!write(env) || !result.hubspotTicketId) {
        result.notesPending = (result.notesPending ?? 0) + 1;
        continue;
      }
      const associations: unknown[] = [
        {
          to: { id: result.hubspotTicketId },
          types: [{ associationCategory: ASSOC.category, associationTypeId: ASSOC.noteToTicket }],
        },
      ];
      if (result.dealId) {
        associations.push({
          to: { id: result.dealId },
          types: [{ associationCategory: ASSOC.category, associationTypeId: ASSOC.noteToDeal }],
        });
      }
      const author = authors.get(comment.author_id) ?? "Unknown";
      // Copy attachments into HubSpot Files so they live on the note (and thus
      // the ticket + deal). Oversized/failed ones become links in the body.
      const { fileIds, skipped } = await mirrorAttachments(env, comment, signal);
      let body = noteBody(author, comment.created_at, comment.plain_body ?? "");
      if (skipped.length) {
        body +=
          "<br><br>" +
          skipped
            .map((a) => `<a href="${esc(a.content_url)}">Attachment: ${esc(a.file_name)}</a>`)
            .join("<br>");
      }
      const note = await hs(
        env.HUBSPOT_TOKEN,
        "POST",
        PATHS.noteCreate,
        {
          properties: {
            hs_timestamp: comment.created_at,
            hs_note_body: body,
            ...(fileIds.length ? { hs_attachment_ids: fileIds.join(";") } : {}),
          },
          associations,
        },
        signal,
      );
      if (!note.ok) {
        console.error(`[zendesk-sync] note create for ZD comment ${comment.id} failed:`, note.status, note.data);
        continue;
      }
      const { error: insErr } = await sb.from("zendesk_ticket_comments").insert({
        zendesk_comment_id: comment.id,
        zendesk_ticket_id: ticketId,
        hubspot_note_id: String(note.data.id),
        author,
      });
      if (insErr) console.error(`[zendesk-sync] comment row insert failed:`, insErr.message);
      result.notesCreated = (result.notesCreated ?? 0) + 1;
    }
    if (!write(env) && result.notesPending) {
      console.log(`[zendesk-sync] would mirror ${result.notesPending} comment(s) for ZD ${ticketId}`);
    }
  }

  // ---- mapping upsert ------------------------------------------------------
  const { error: upErr } = await sb.from("zendesk_tickets").upsert(
    {
      zendesk_ticket_id: ticketId,
      hubspot_ticket_id: result.hubspotTicketId,
      zd_group_id: ticket.group_id ?? null,
      deal_id: result.dealId,
      contact_id: result.contactId,
      contact_created: result.contactCreated ?? undefined,
      requester_email: requesterEmail ?? undefined,
      requester_email_fake: result.fakeEmail ?? undefined,
      category: customFieldValue(ticket, ZD_FIELDS.category),
      zd_status: ticket.status,
      hs_stage: stage,
      quote_number: quoteNumber,
      followup_of: ticket.via?.followup_source_id ?? undefined,
      origin: existingRow?.origin ?? "adopted",
      last_event_at: ticket.updated_at ?? new Date().toISOString(),
      last_sync_error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "zendesk_ticket_id" },
  );
  if (upErr) console.error(`[zendesk-sync] mapping upsert for ${ticketId} failed:`, upErr.message);

  return result;
}
