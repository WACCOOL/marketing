import type { Env } from "./env.js";
import { serviceSupabase } from "./supabase.js";
import {
  updateIngestionStatus,
  type IngestMessage,
  type IngestionPatch,
} from "./ingest.js";

/**
 * wac-ingest queue consumer (Phase 1 — pass-through).
 *
 * Branched out of the shared queue() export in index.ts on
 * batch.queue === "wac-ingest". For each message it confirms the raw file is in
 * R2 and marks the ingestion `succeeded`; per-source PARSING (Excel -> staging
 * tables) is wired in here phase by phase. The failure-finalizer shape mirrors
 * the generation consumer: terminal on the last attempt (-> DLQ via
 * max_retries), retry otherwise.
 */

const MAX_ATTEMPTS = 3;

export async function handleIngestBatch(
  batch: MessageBatch<IngestMessage>,
  env: Env,
): Promise<void> {
  const sb = serviceSupabase(env);

  for (const message of batch.messages) {
    const msg = message.body;
    try {
      await updateIngestionStatus(sb, msg.ingestionId, {
        status: "processing",
        started_at: new Date().toISOString(),
        attempts: message.attempts,
      });

      // Confirm the stored original is present (the consumer re-reads it from R2,
      // never from the message). HEAD avoids pulling the bytes for the no-op pass.
      const head = await env.ASSETS_BUCKET.head(msg.r2Key);
      if (!head) {
        throw new Error(`R2 object missing: ${msg.r2Key}`);
      }

      // Phase 1: no parser yet — record the received file as succeeded. Later
      // phases replace this block with: fetch bytes -> parse -> upsert staging ->
      // reconcile, then patch the same row_count/inserted/updated/closed counts.
      const result: IngestionPatch = {
        status: "succeeded",
        finished_at: new Date().toISOString(),
      };
      await updateIngestionStatus(sb, msg.ingestionId, result);

      message.ack();
    } catch (e) {
      const errMessage = e instanceof Error ? e.message : String(e);
      console.error(
        `[ingest] ${msg.ingestionId} attempt ${message.attempts} failed:`,
        errMessage,
      );
      if (message.attempts >= MAX_ATTEMPTS) {
        try {
          await updateIngestionStatus(sb, msg.ingestionId, {
            status: "failed",
            error: errMessage,
            attempts: message.attempts,
            finished_at: new Date().toISOString(),
          });
        } catch (updateErr) {
          console.error(
            `[ingest] failed to finalize ${msg.ingestionId}:`,
            updateErr,
          );
        }
        message.ack();
      } else {
        message.retry();
      }
    }
  }
}
