import type { Env } from "./env.js";
import { serviceSupabase } from "./supabase.js";
import { updateIngestionStatus, type IngestMessage } from "./ingest.js";
import { processIngestion } from "./ingestProcess.js";

/**
 * wac-ingest queue consumer.
 *
 * Branched out of the shared queue() export in index.ts on
 * batch.queue === "wac-ingest". Marks the ingestion `processing`, hands it to
 * processIngestion() (parse -> staging tables, or pass-through for sources
 * without a parser yet), then records the result. The failure-finalizer shape
 * mirrors the generation consumer: terminal on the last attempt (-> DLQ via
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

      // Parse + stage (or pass-through for sources without a parser yet).
      const result = await processIngestion(env, sb, msg);
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
