import type { Env } from "./env.js";
import { serviceSupabase } from "./supabase.js";
import { processEventLead, type EventLeadBody, type EventLeadResult } from "./eventLead.js";

/**
 * wac-event-leads queue consumer.
 *
 * The event-lead webhook enqueues one message per enrolled contact (a fast, burst-proof
 * ack) and this consumer does the real work — SERIALLY (max_concurrency 1 in wrangler),
 * so a 200-contact list enrollment drains at a pace HubSpot's API rate limit can absorb
 * instead of 200 parallel invocations starving each other into timeouts (the 2026-07-02
 * Lightovation run: 217 enrollments → only 62 leads).
 *
 * Each contact's outcome is recorded in `event_lead_outcomes` so "why didn't X get a
 * lead?" is a query. Failures retry (per-message, delayed) up to MAX_ATTEMPTS, then
 * park in the DLQ; processing is idempotent (owners who already have a lead for the
 * campaign are skipped), so retries never duplicate leads.
 */

const MAX_ATTEMPTS = 3;
/** Generous per-contact budget — the queue is serial, so there's no herd to starve. */
const PER_CONTACT_TIMEOUT_MS = 90_000;

function outcomeStatus(res: EventLeadResult): string {
  if (res.skippedReason === "competitor") return "skipped_competitor";
  // Owned contact at a standard event — owner notified instead of a lead.
  if (res.skippedReason === "owned") return "skipped_owned";
  if (res.leads.some((l) => l.leadError)) return "error";
  if (!res.leads.length) return res.dedupedExisting > 0 ? "skipped_existing" : "no_owner";
  return "done";
}

export async function handleEventLeadBatch(
  batch: MessageBatch<EventLeadBody>,
  env: Env,
): Promise<void> {
  const sb = serviceSupabase(env);

  for (const message of batch.messages) {
    const payload = message.body;
    const contactId = payload.contactId;
    try {
      const res = await processEventLead(env, payload, AbortSignal.timeout(PER_CONTACT_TIMEOUT_MS));
      await sb
        .from("event_lead_outcomes")
        .upsert(
          {
            contact_id: contactId,
            campaign: res.campaignName ?? "",
            status: outcomeStatus(res),
            lead_type: res.leadType,
            lead_count: res.leads.filter((l) => l.leadId).length,
            leads: res.leads.map((l) => ({
              leadId: l.leadId,
              ownerId: l.ownerId,
              ownerSource: l.ownerSource,
              label: l.leafLabel,
              error: l.leadError,
            })),
            deduped_existing: res.dedupedExisting,
            error: res.leads.map((l) => l.leadError).filter(Boolean).join("; ") || null,
            attempts: message.attempts,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "contact_id" },
        )
        .then(({ error }) => {
          if (error) console.error(`[event-lead] ${contactId} outcome upsert failed:`, error.message);
        });
      message.ack();
    } catch (e) {
      const errMessage = e instanceof Error ? e.message : String(e);
      console.error(`[event-lead] ${contactId} attempt ${message.attempts} failed:`, errMessage);
      if (message.attempts >= MAX_ATTEMPTS) {
        try {
          await sb.from("event_lead_outcomes").upsert(
            {
              contact_id: contactId,
              status: "error",
              error: errMessage,
              attempts: message.attempts,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "contact_id" },
          );
        } catch (updateErr) {
          console.error(`[event-lead] failed to finalize ${contactId}:`, updateErr);
        }
        message.ack(); // outcomes table is the dead-letter record (status=error)
      } else {
        message.retry({ delaySeconds: 30 * message.attempts });
      }
    }
  }
}
