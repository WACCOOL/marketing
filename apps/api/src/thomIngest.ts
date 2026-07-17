// Thom Bot — knowledge ingestion queue (Tier A: light, in-Worker).
//
// One message per source document discovered by a sync (Sales Layer spec
// sheets / manuals now; ZenDesk tickets piggyback later). The consumer does
// ONLY cheap work — fetch bytes, hash, store to R2, upsert kb_documents as
// pending_extract — and never parses PDFs: the heavy extract/chunk/embed pass
// runs out-of-band in the apps/docs-ingest Node CLI (Workers have a CPU
// ceiling; the catalog does not).

import type { Env } from "./env.js";

export interface ThomIngestMessage {
  /** Where the document came from: 'sales_layer' | 'zendesk'. */
  source: "sales_layer" | "zendesk";
  /** 'spec_sheet' | 'manual' | ... — validated at the API layer (see 0043). */
  docType: string;
  /** Direct download URL of the source document. */
  url: string;
  /** Upstream change-detection key (Sales Layer file hash / ticket event id). */
  hash: string;
  /** Product-level doc: the owning SKU (PPID). */
  sku?: string;
  /** Family-level doc (e.g. an install manual covering a whole family). */
  family?: string;
  brand?: string;
  /** Human label for the download button ("Specification Sheet"). */
  label?: string;
}

export async function handleThomIngestBatch(
  batch: MessageBatch<ThomIngestMessage>,
  _env: Env,
): Promise<void> {
  // Phase 0 stub: the wac-thom-ingest queue is wired (so messages can never
  // fall through to the generation consumer) but ingestion itself lands in
  // Phase 1. Ack everything — the Sales Layer sync re-discovers docs on every
  // run, so nothing is lost by draining early messages here.
  for (const message of batch.messages) {
    console.log(
      `[thom-ingest] (phase-0 stub) ack ${message.body.docType} ${message.body.url}`,
    );
    message.ack();
  }
}
