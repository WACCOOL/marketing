import { createHash } from "node:crypto";
import type { Env } from "./env.js";
import { ZD, zd, zendeskTicketUrl } from "./zendesk.js";
import type { ThomIngestMessage } from "./thomIngest.js";

/**
 * ZenDesk INTERNAL-TICKET capture helpers for Thom's RAG KB (dark-launched
 * behind THOM_ZENDESK_TICKETS). Pure/testable core + the Tier-A producer hook.
 *
 * Containment guarantees enforced here:
 *  - kb_documents stores a POINTER ROW ONLY — doc_type='zendesk_ticket',
 *    scope='internal', url=agent ticket link, content_hash, external_id=ticket
 *    id, title=subject. NEVER a ticket body. The only body-at-rest is the
 *    REDACTED text in kb_chunks, produced by the docs-ingest extraction pass.
 *  - scope is ALWAYS 'internal', so RLS + kb_search's scope filter keep tickets
 *    off any future public surface.
 *
 * THOM_TICKET_GROUPS is deliberately SEPARATE from ZD_SYNC_GROUPS: which groups'
 * tickets feed the KB is a different decision from which mirror to HubSpot.
 */

export const THOM_TICKET_SOURCE_SYSTEM = "zendesk";
export const THOM_TICKET_DOC_TYPE = "zendesk_ticket";

/**
 * Parse THOM_TICKET_GROUPS into a set of numeric group ids. Accepts either a
 * JSON array (`[123, 456]` or `["123","456"]`) or a plain CSV (`123,456`).
 * Invalid/empty input yields an empty set (capture then no-ops). Mirrors the
 * fail-soft posture of parseSyncGroups.
 */
export function parseTicketGroups(raw: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!raw) return out;
  const trimmed = raw.trim();
  if (!trimmed) return out;
  let tokens: unknown[];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      tokens = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error("[thom-tickets] THOM_TICKET_GROUPS is not valid JSON:", e);
      return out;
    }
  } else {
    tokens = trimmed.split(",");
  }
  for (const tok of tokens) {
    const id = Number(typeof tok === "string" ? tok.trim() : tok);
    if (Number.isFinite(id) && id > 0) out.add(id);
  }
  return out;
}

/** Whether a ticket's group is one whose tickets feed Thom's KB. */
export function ticketInKbGroups(groupId: number | null | undefined, groups: Set<number>): boolean {
  return groupId != null && groups.has(groupId);
}

/**
 * Change-detection hash for a ticket: sha256 of updated_at + the public comment
 * ids. A new comment (new id) OR any ticket update (bumped updated_at) yields a
 * new hash, so the pointer-row upsert re-pends the row for re-extraction; an
 * untouched ticket keeps its hash and current status. Comment ids are sorted so
 * ordering never spuriously changes the hash.
 */
export function ticketContentHash(
  updatedAt: string | null | undefined,
  commentIds: number[],
): string {
  const ids = [...commentIds].sort((a, b) => a - b).join(",");
  return createHash("sha256")
    .update(`${updatedAt ?? ""}\n${ids}`)
    .digest("hex");
}

/**
 * kb_documents POINTER-ROW payload for a ticket. `status` is intentionally
 * OMITTED here — the consumer (handleTicketMessage) resolves it explicitly via
 * resolveKbDocStatus against the row's current (content_hash, status), because
 * the upsert's ON CONFLICT UPDATE would otherwise leave a CHANGED ticket stuck
 * on 'active' (the DB's pending_extract default only covers new inserts). There
 * is NO body field here — the body lives only as redacted kb_chunks.content.
 */
export function buildTicketDocPayload(
  ticketId: number,
  url: string,
  subject: string | null,
  hash: string,
): Record<string, unknown> {
  return {
    source_system: THOM_TICKET_SOURCE_SYSTEM,
    external_id: String(ticketId),
    doc_type: THOM_TICKET_DOC_TYPE,
    scope: "internal",
    url,
    title: subject,
    content_hash: hash,
  };
}

/** The Tier-A ingest message that discovers a ticket for the KB. */
export function buildTicketIngestMessage(env: Env, ticketId: number): ThomIngestMessage {
  return {
    source: "zendesk",
    docType: THOM_TICKET_DOC_TYPE,
    externalId: String(ticketId),
    url: zendeskTicketUrl(env, ticketId),
  };
}

/**
 * Tier-A producer hook (piggyback): if the ticket-capture flag is on and this
 * ticket's group feeds the KB, enqueue it onto THOM_INGEST_QUEUE. Called from
 * the zendesk-sync queue consumer with the group id it already resolved (no
 * extra ZenDesk fetch). Returns whether a message was enqueued. Best-effort —
 * never throws (a KB-capture blip must not fail the HubSpot mirror).
 */
export async function maybeEnqueueKbTicket(
  env: Env,
  ticketId: number,
  groupId: number | null | undefined,
): Promise<boolean> {
  if (env.THOM_ZENDESK_TICKETS !== "1") return false;
  const groups = parseTicketGroups(env.THOM_TICKET_GROUPS);
  if (!ticketInKbGroups(groupId, groups)) return false;
  try {
    await env.THOM_INGEST_QUEUE.send(buildTicketIngestMessage(env, ticketId));
    return true;
  } catch (e) {
    console.error(`[thom-tickets] enqueue ticket ${ticketId} failed:`, e);
    return false;
  }
}

interface ZdTicketLite {
  id: number;
  subject?: string;
  group_id?: number | null;
  updated_at?: string;
}
interface ZdCommentLite {
  id: number;
  public: boolean;
}

/**
 * Consumer-side: build the pointer row for a ticket message by reading the
 * ticket's metadata + PUBLIC comment ids from ZenDesk (NO body is read or
 * stored here — the redacted body is produced later by docs-ingest). Returns
 * null when the ticket is gone, unreadable, or (defense-in-depth) not in a KB
 * group. Only public comments contribute to the change hash, matching what the
 * extraction pass will actually embed.
 */
export async function buildTicketPointerRow(
  env: Env,
  ticketId: number,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const groups = parseTicketGroups(env.THOM_TICKET_GROUPS);
  const tRes = await zd(env, "GET", ZD.ticket(ticketId), undefined, signal);
  if (!tRes.ok) throw new Error(`zendesk ticket fetch ${tRes.status}`);
  const ticket: ZdTicketLite | undefined = tRes.data?.ticket;
  if (!ticket) return null;
  // Defense-in-depth: even though producers pre-filter by group, re-check here
  // so a stray/mis-routed message can never write a non-KB ticket.
  if (!ticketInKbGroups(ticket.group_id, groups)) return null;

  const cRes = await zd(env, "GET", ZD.comments(ticketId), undefined, signal);
  const commentIds: number[] = cRes.ok
    ? ((cRes.data?.comments ?? []) as ZdCommentLite[]).filter((c) => c.public).map((c) => c.id)
    : [];

  const hash = ticketContentHash(ticket.updated_at, commentIds);
  return buildTicketDocPayload(ticketId, zendeskTicketUrl(env, ticketId), ticket.subject ?? null, hash);
}
