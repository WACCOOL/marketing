// Thom Bot — knowledge ingestion queue (Tier A: light, in-Worker).
//
// One message per source document discovered by a sync (Sales Layer spec
// sheets / manuals; ZenDesk internal tickets piggyback off the mirror). The
// consumer does ONLY cheap work — fetch metadata, hash, upsert kb_documents as
// pending_extract — and never parses PDFs or stores bodies: the heavy
// extract/chunk/embed pass (and, for tickets, PII redaction) runs out-of-band
// in the apps/docs-ingest Node CLI (Workers have a CPU ceiling; the catalog
// does not).

import { resolveKbDocStatus } from "@wac/shared";
import type { Env } from "./env.js";
import { serviceSupabase } from "./supabase.js";
import {
  buildTicketPointerRow,
  parseTicketGroups,
  THOM_TICKET_DOC_TYPE,
  THOM_TICKET_SOURCE_SYSTEM,
} from "./thomTickets.js";

export interface ThomIngestMessage {
  /** Where the document came from: 'sales_layer' | 'zendesk'. */
  source: "sales_layer" | "zendesk";
  /** 'spec_sheet' | 'manual' | 'zendesk_ticket' | ... — validated at 0043. */
  docType: string;
  /** Direct download URL (PDF) or the internal ticket link. */
  url?: string;
  /** Upstream change-detection key (Sales Layer file hash / ticket event id). */
  hash?: string;
  /** Stable upstream id (ZenDesk ticket id) — kb_documents.external_id. */
  externalId?: string;
  /** Product-level doc: the owning SKU (PPID). */
  sku?: string;
  /** Family-level doc (e.g. an install manual covering a whole family). */
  family?: string;
  brand?: string;
  /** Human label for the download button ("Specification Sheet"). */
  label?: string;
}

const PER_TICKET_TIMEOUT_MS = 30_000;

/**
 * Upsert the kb_documents POINTER ROW for a ZenDesk ticket message — NO body.
 * Gated behind THOM_ZENDESK_TICKETS (defense-in-depth; the producer also gates)
 * and the THOM_TICKET_GROUPS allowlist (re-checked inside buildTicketPointerRow).
 * A non-KB or flag-off message is a no-op (the caller acks it). The redacted
 * body lands later, as kb_chunks, via the docs-ingest extraction pass.
 */
async function handleTicketMessage(
  env: Env,
  msg: ThomIngestMessage,
): Promise<void> {
  if (env.THOM_ZENDESK_TICKETS !== "1") return; // dark launch: drop silently
  if (parseTicketGroups(env.THOM_TICKET_GROUPS).size === 0) return;
  const ticketId = Number(msg.externalId);
  if (!Number.isFinite(ticketId) || ticketId <= 0) return;

  const row = await buildTicketPointerRow(env, ticketId, AbortSignal.timeout(PER_TICKET_TIMEOUT_MS));
  if (!row) return; // ticket gone or not in a KB group — nothing to write

  const sb = serviceSupabase(env);
  // Resolve status EXPLICITLY: the upsert's ON CONFLICT UPDATE only writes the
  // supplied columns, so a changed ticket (new content_hash) would otherwise
  // stay 'active' and docs-ingest (pending_extract only) would never re-extract
  // it. Read the current row's (content_hash, status) and requeue on change; an
  // unchanged ticket keeps its status. NO ticket body is written here.
  const { data: existing, error: readErr } = await sb
    .from("kb_documents")
    .select("content_hash, status")
    .eq("source_system", THOM_TICKET_SOURCE_SYSTEM)
    .eq("external_id", String(ticketId))
    .maybeSingle();
  if (readErr) throw new Error(`kb_documents (ticket ${ticketId}) read failed: ${readErr.message}`);
  row.status = resolveKbDocStatus(
    existing ? { content_hash: existing.content_hash ?? null, status: String(existing.status) } : null,
    String(row.content_hash),
  );
  const { error } = await sb
    .from("kb_documents")
    .upsert(row, { onConflict: "source_system,external_id" });
  if (error) throw new Error(`kb_documents (ticket ${ticketId}) upsert failed: ${error.message}`);
  console.log(`[thom-ingest] ticket ${ticketId} pointer upserted (${row.status})`);
}

const MAX_ATTEMPTS = 3;

export async function handleThomIngestBatch(
  batch: MessageBatch<ThomIngestMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    if (body.docType === THOM_TICKET_DOC_TYPE) {
      try {
        await handleTicketMessage(env, body);
        message.ack();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `[thom-ingest] ticket ${body.externalId} attempt ${message.attempts} failed:`,
          msg,
        );
        if (message.attempts >= MAX_ATTEMPTS) message.ack();
        else message.retry({ delaySeconds: 30 * message.attempts });
      }
      continue;
    }
    // Sales Layer spec sheets / manuals: still the Phase-0 stub (the Sales Layer
    // doc capture path lands separately). Ack — the sync re-discovers docs each
    // run, so draining early messages loses nothing.
    console.log(`[thom-ingest] (phase-0 stub) ack ${body.docType} ${body.url ?? ""}`);
    message.ack();
  }
}
