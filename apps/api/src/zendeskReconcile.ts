import type { Env } from "./env.js";
import { ZD, parseSyncGroups, zd } from "./zendesk.js";

/**
 * Drift repair + backfill for the Zendesk -> HubSpot mirror. Both walk the
 * Zendesk search API and enqueue matching tickets onto wac-zendesk-sync — the
 * queue consumer (idempotent) does the actual mirroring, so these sweeps are
 * safe to re-run and safe to interrupt.
 *
 * Reconcile (nightly cron + manual route): everything updated in the last 48h
 * across all allowlisted groups — the net under webhook outages / circuit
 * breaking. Backfill (manual route): one group at a time, open-ish tickets by
 * default or everything updated in the last N days.
 */

const PAGE_LIMIT = 30; // search API pages hard-cap at ~1000 results (100/page)

interface SweepResult {
  groups: Record<string, number>;
  enqueued: number;
  error?: string;
}

async function sweepQuery(env: Env, query: string, signal: AbortSignal): Promise<number[]> {
  const ids: number[] = [];
  let path: string | null = ZD.search(query);
  for (let page = 0; path && page < PAGE_LIMIT; page++) {
    const res = await zd(env, "GET", path, undefined, signal);
    if (!res.ok) throw new Error(`zendesk search ${res.status}: ${JSON.stringify(res.data)}`);
    for (const r of res.data.results ?? []) {
      if (typeof r.id === "number") ids.push(r.id);
    }
    const next: string | null = res.data.next_page ?? null;
    // next_page is absolute — strip to path+query for the zd() client.
    path = next ? next.replace(/^https:\/\/[^/]+/, "") : null;
  }
  return ids;
}

async function enqueueAll(env: Env, ids: number[]): Promise<number> {
  let sent = 0;
  for (const ticketId of ids) {
    await env.ZENDESK_SYNC_QUEUE.send({ ticketId });
    sent++;
  }
  return sent;
}

export async function runZendeskBackfill(
  env: Env,
  groupId: number,
  days: number | undefined,
  signal: AbortSignal,
): Promise<SweepResult> {
  const groups = parseSyncGroups(env);
  const group = groups.get(groupId);
  if (!group) {
    return { groups: {}, enqueued: 0, error: `group ${groupId} not in ZD_SYNC_GROUPS` };
  }
  const query =
    days && Number.isFinite(days)
      ? `type:ticket group_id:${groupId} updated>${days}days`
      : `type:ticket group_id:${groupId} status<solved`;
  try {
    const ids = await sweepQuery(env, query, signal);
    const enqueued = await enqueueAll(env, ids);
    console.log(`[zendesk-backfill] ${group.name}: ${enqueued} ticket(s) enqueued (${query})`);
    return { groups: { [group.name]: ids.length }, enqueued };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { groups: {}, enqueued: 0, error: msg };
  }
}

export async function runZendeskReconcile(env: Env, signal: AbortSignal): Promise<SweepResult> {
  const groups = parseSyncGroups(env);
  const result: SweepResult = { groups: {}, enqueued: 0 };
  for (const [groupId, group] of groups) {
    try {
      const ids = await sweepQuery(env, `type:ticket group_id:${groupId} updated>48hours`, signal);
      result.groups[group.name] = ids.length;
      result.enqueued += await enqueueAll(env, ids);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[zendesk-reconcile] group ${group.name} sweep failed:`, msg);
      result.error = msg;
    }
  }
  console.log(`[zendesk-reconcile] enqueued ${result.enqueued} ticket(s)`, JSON.stringify(result.groups));
  return result;
}
