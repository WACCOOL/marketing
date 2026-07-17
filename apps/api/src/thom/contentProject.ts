import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkText, estimateTokens } from "@wac/shared";
import type { Env } from "../env.js";
import { embedTexts } from "./embed.js";

/**
 * Project a marketing_content row into the Thom RAG store (kb_documents +
 * kb_chunks) on save. This is the bridge from the marketing authoring table
 * (system-of-record) to the retrieval index Thom's search_docs reads.
 *
 * Design (mirrors the docs-ingest pipeline, but runs synchronously in the
 * Worker via the `AI` binding so a save is answerable immediately):
 *  - kb_documents carries one row per marketing doc, keyed by
 *    (source_system='marketing_admin', external_id = marketing_content.id).
 *  - `content_hash` = sha256(body) is the idempotency key: an unchanged
 *    published body is never re-embedded.
 *  - PUBLISHED + (changed | forced | not-yet-active) => chunk + embed +
 *    delete-then-insert kb_chunks + flip kb_documents.status to 'active'.
 *  - DRAFT => remove any existing chunks and park the document as 'superseded'
 *    so kb_search (active-only) can't retrieve it and the docs-ingest CLI
 *    (pending-only) won't try to re-extract it.
 *  - On an inline embed failure (Workers AI throw) the document is left
 *    'pending_extract' and the user's save STILL succeeds — the docs-ingest CLI
 *    re-embeds it out-of-band as a fallback. So a transient AI outage degrades
 *    to eventual indexing, never a failed save.
 */

export const MARKETING_SOURCE_SYSTEM = "marketing_admin";
export const MARKETING_DOC_TYPE = "marketing";

/** The subset of a marketing_content row the projection needs. */
export interface MarketingContentRow {
  id: string;
  title: string;
  brand: string | null;
  scope: "public" | "internal";
  body: string;
  status: "draft" | "published";
}

/** sha256 hex of a string via Web Crypto (available in Workers + Node 20+). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type KbDocStatus = "pending_extract" | "active" | "superseded" | "failed";

/** Pure builder for the kb_documents upsert payload — unit-testable. */
export function buildKbDocumentPayload(
  row: MarketingContentRow,
  hash: string,
  status: KbDocStatus,
): Record<string, unknown> {
  return {
    source_system: MARKETING_SOURCE_SYSTEM,
    external_id: row.id,
    doc_type: MARKETING_DOC_TYPE,
    scope: row.scope,
    brand: row.brand,
    title: row.title,
    url: null,
    content_hash: hash,
    status,
  };
}

/** Pure builder for the kb_chunks insert rows — unit-testable. */
export function buildChunkRows(
  documentId: string,
  row: MarketingContentRow,
  chunks: { index: number; content: string }[],
  vectorLiterals: string[],
): Record<string, unknown>[] {
  return chunks.map((c, i) => ({
    document_id: documentId,
    scope: row.scope,
    doc_type: MARKETING_DOC_TYPE,
    brand: row.brand,
    chunk_index: c.index,
    page: null,
    content: c.content,
    token_count: estimateTokens(c.content),
    embedding: vectorLiterals[i]!,
  }));
}

export interface ProjectResult {
  status: KbDocStatus;
  chunks: number;
}

/**
 * Upsert + (re)index one marketing_content row. `sb` MUST be the service client
 * (kb_documents/kb_chunks are service-role-write). `force` re-embeds even when
 * the body hash is unchanged.
 */
export async function projectMarketingContent(
  env: Env,
  sb: SupabaseClient,
  row: MarketingContentRow,
  force = false,
): Promise<ProjectResult> {
  const hash = await sha256Hex(row.body);

  // Prior projected state, for change detection.
  const { data: existing } = await sb
    .from("kb_documents")
    .select("id, content_hash, status")
    .eq("source_system", MARKETING_SOURCE_SYSTEM)
    .eq("external_id", row.id)
    .maybeSingle();

  const changed = !existing || existing.content_hash !== hash;
  const isPublished = row.status === "published";
  // Published rows need (re)embedding when the body changed, when forced, or
  // when they aren't already active (e.g. first publish, or recovering a prior
  // pending/failed state).
  const needsEmbed = isPublished && (changed || force || existing?.status !== "active");

  // The status we write in the metadata upsert. Draft parks the doc out of
  // retrieval; an unchanged already-active published row stays active; a
  // published row about to be embedded goes transiently pending (so a mid-embed
  // failure leaves it recoverable by the docs-ingest CLI).
  const upsertStatus: KbDocStatus = !isPublished
    ? "superseded"
    : needsEmbed
      ? "pending_extract"
      : "active";

  const { data: upserted, error: upErr } = await sb
    .from("kb_documents")
    .upsert(buildKbDocumentPayload(row, hash, upsertStatus), {
      onConflict: "source_system,external_id",
    })
    .select("id")
    .single();
  if (upErr || !upserted) {
    throw new Error(`kb_documents upsert failed: ${upErr?.message ?? "no row"}`);
  }
  const documentId = upserted.id as string;

  // Draft: strip any prior chunks; the doc is parked as 'superseded'.
  if (!isPublished) {
    const { error: delErr } = await sb.from("kb_chunks").delete().eq("document_id", documentId);
    if (delErr) throw new Error(`kb_chunks delete failed: ${delErr.message}`);
    return { status: "superseded", chunks: 0 };
  }

  // Published + unchanged + already active: nothing to do.
  if (!needsEmbed) return { status: "active", chunks: 0 };

  // Published + needs (re)embed. A Workers AI failure here must NOT fail the
  // user's save — leave the doc pending for the docs-ingest fallback.
  try {
    const chunks = chunkText(row.body);
    if (!chunks.length) {
      // Empty body somehow — clear chunks, park pending (nothing to retrieve).
      await sb.from("kb_chunks").delete().eq("document_id", documentId);
      return { status: "pending_extract", chunks: 0 };
    }
    const vectors = await embedTexts(env, chunks.map((c) => c.content));
    const rows = buildChunkRows(documentId, row, chunks, vectors);

    const { error: delErr } = await sb.from("kb_chunks").delete().eq("document_id", documentId);
    if (delErr) throw new Error(`kb_chunks delete failed: ${delErr.message}`);
    const { error: insErr } = await sb.from("kb_chunks").insert(rows);
    if (insErr) throw new Error(`kb_chunks insert failed: ${insErr.message}`);

    const { error: statusErr } = await sb
      .from("kb_documents")
      .update({ status: "active", extracted_at: new Date().toISOString(), last_error: null })
      .eq("id", documentId);
    if (statusErr) throw new Error(`kb_documents status flip failed: ${statusErr.message}`);

    return { status: "active", chunks: chunks.length };
  } catch (e) {
    // Inline embed/index failed: the doc stays 'pending_extract' (set by the
    // upsert above) for the docs-ingest CLI to pick up. Don't fail the save.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[thom] inline marketing projection failed for ${row.id}, left pending: ${msg}`);
    return { status: "pending_extract", chunks: 0 };
  }
}
