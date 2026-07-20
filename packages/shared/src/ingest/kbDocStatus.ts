/**
 * Status resolution for kb_documents captures whose `external_id` is a STABLE
 * upstream id (ZenDesk article/ticket id) rather than a content hash.
 *
 * Why this exists: a PostgREST upsert's ON CONFLICT UPDATE writes exactly the
 * columns in the payload and leaves the rest untouched. Omitting `status` from
 * the payload therefore only yields 'pending_extract' on brand-new INSERTS (the
 * DB default) — for an EXISTING row whose content changed, the upsert would
 * update `content_hash` while leaving status='active', and the extraction pass
 * (which only processes 'pending_extract') would never re-extract it. Captures
 * with a stable external_id must resolve `status` explicitly, from the row's
 * current (content_hash, status). (Hash-keyed captures like the Sales Layer
 * docs don't need this: a changed file is a new external_id, i.e. a new row.)
 */

export interface KbDocStatusRow {
  content_hash: string | null;
  status: string;
}

/**
 * The `status` to write in a capture upsert:
 *  - no existing row            -> 'pending_extract' (new document)
 *  - existing but 'superseded'  -> 'pending_extract' (re-published upstream)
 *  - content_hash changed       -> 'pending_extract' (edited; re-extract)
 *  - otherwise                  -> the current status, written back unchanged
 *    (so 'active' stays active and 'failed' stays failed until --retry-failed).
 */
export function resolveKbDocStatus(
  existing: KbDocStatusRow | null | undefined,
  hash: string,
): string {
  if (!existing) return "pending_extract";
  if (existing.status === "superseded") return "pending_extract";
  if (existing.content_hash !== hash) return "pending_extract";
  return existing.status;
}
