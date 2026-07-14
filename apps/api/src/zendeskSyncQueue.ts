import type { Env } from "./env.js";
import { serviceSupabase } from "./supabase.js";
import { syncZendeskTicket } from "./zendeskSync.js";

/**
 * wac-zendesk-sync queue consumer.
 *
 * The Zendesk webhook enqueues one message per ticket event (a fast ack well
 * inside Zendesk's 12s webhook timeout) and this consumer does the real work —
 * serially (max_concurrency 1 in wrangler) so a busy morning in the Quotes
 * group drains at a pace both APIs' rate limits absorb. syncZendeskTicket is
 * idempotent (mapping row + comment-id dedupe), so retries and the duplicate
 * events Zendesk triggers naturally produce (status change AND comment on the
 * same update) never double-mirror.
 */

export interface ZendeskSyncMessage {
  ticketId: number;
}

const MAX_ATTEMPTS = 3;
const PER_TICKET_TIMEOUT_MS = 60_000;

export async function handleZendeskSyncBatch(
  batch: MessageBatch<ZendeskSyncMessage>,
  env: Env,
): Promise<void> {
  const sb = serviceSupabase(env);
  // The same update often fires multiple trigger events — collapse within the batch.
  const seen = new Set<number>();

  for (const message of batch.messages) {
    const ticketId = Number(message.body?.ticketId);
    if (!Number.isFinite(ticketId) || seen.has(ticketId)) {
      message.ack();
      continue;
    }
    seen.add(ticketId);
    try {
      const res = await syncZendeskTicket(env, ticketId, AbortSignal.timeout(PER_TICKET_TIMEOUT_MS), sb);
      if (res.action === "error") throw new Error(res.error ?? "sync error");
      message.ack();
    } catch (e) {
      const errMessage = e instanceof Error ? e.message : String(e);
      console.error(`[zendesk-sync] ticket ${ticketId} attempt ${message.attempts} failed:`, errMessage);
      if (message.attempts >= MAX_ATTEMPTS) {
        try {
          await sb.from("zendesk_tickets").upsert(
            {
              zendesk_ticket_id: ticketId,
              last_sync_error: errMessage,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "zendesk_ticket_id" },
          );
        } catch (updateErr) {
          console.error(`[zendesk-sync] failed to record error for ${ticketId}:`, updateErr);
        }
        message.ack(); // last_sync_error on the mapping row is the dead-letter record
      } else {
        message.retry({ delaySeconds: 30 * message.attempts });
      }
    }
  }
}
