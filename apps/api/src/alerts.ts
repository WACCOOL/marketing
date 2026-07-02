import { serviceSupabase } from "./supabase.js";
import type { Env } from "./env.js";

/**
 * Severe-issue alerting for the SAP -> HubSpot sync pipeline.
 *
 * Best-effort and isolated: notifySevere never throws into a caller's path, so a
 * down Slack webhook can't break the capture/result endpoints or the cron. When
 * ALERT_SLACK_WEBHOOK is unset, alerts are logged only. Routine auto-fixes are
 * NOT alerted — only the severe cases (Phase 1: the heartbeat no-data check;
 * Phase 2 will add DLQ landings / held-needs-decision / failure spikes).
 */

export type SevereKind = "heartbeat" | "dlq" | "held" | "spike" | "showroom";

export interface SevereAlert {
  kind: SevereKind;
  title: string;
  detail?: string;
  recordId?: string;
}

export async function notifySevere(env: Env, alert: SevereAlert): Promise<void> {
  const line = `[hubspot-sync][SEVERE:${alert.kind}] ${alert.title}${
    alert.detail ? ` — ${alert.detail}` : ""
  }`;
  console.error(line);

  const webhook = env.ALERT_SLACK_WEBHOOK;
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `:rotating_light: ${line}` }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (e) {
    console.error("[hubspot-sync] alert delivery failed:", e);
  }
}

/** Object types we expect a steady SAP feed for. */
const HEARTBEAT_OBJECTS = ["deals", "companies"] as const;
/** Alert if an object type that HAS received data goes quiet this long. */
const HEARTBEAT_STALE_HOURS = 12;

/**
 * Heartbeat / no-data check (cron). The scariest silent failure is the whole
 * feed stopping (SAP job or a Lambda breaks) — nothing errors, data just stops.
 * For each object type that has EVER received a payload, alert if the newest one
 * is older than the staleness threshold. Skips object types with no rows yet
 * (pre-launch) and skips entirely when the integration token isn't configured.
 */
export async function runHubspotHeartbeat(env: Env): Promise<void> {
  if (!env.SAP_SYNC_TOKEN) return; // integration not configured yet
  const sb = serviceSupabase(env);
  const staleMs = HEARTBEAT_STALE_HOURS * 3_600_000;

  for (const objectType of HEARTBEAT_OBJECTS) {
    try {
      const { data, error } = await sb
        .from("hubspot_sync_records")
        .select("created_at")
        .eq("object_type", objectType)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        console.error(`[hubspot-sync] heartbeat query failed (${objectType}):`, error.message);
        continue;
      }
      const newest = (data as { created_at: string } | null)?.created_at;
      if (!newest) continue; // never received any — not yet live

      const ageMs = Date.now() - new Date(newest).getTime();
      if (ageMs > staleMs) {
        const hours = Math.round(ageMs / 3_600_000);
        await notifySevere(env, {
          kind: "heartbeat",
          title: `No ${objectType} payloads received for ${hours}h`,
          detail: `Newest ${objectType} capture was ${newest}. The SAP feed or the Lambda may be down.`,
        });
      }
    } catch (e) {
      console.error(`[hubspot-sync] heartbeat check errored (${objectType}):`, e);
    }
  }
}
