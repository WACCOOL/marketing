import type { Env } from "./env.js";
import { serviceSupabase } from "./supabase.js";
import { createIngestion, getLatestIngestionMarker } from "./ingest.js";
import {
  downloadDriveItem,
  driveItemMarker,
  getGraphToken,
  getMatchingAttachment,
  getSharedItem,
  graphConfigured,
  searchSenderMessages,
  XLSX_CONTENT_TYPE,
} from "./graph.js";

/**
 * Scheduled Microsoft Graph pullers (the free, no-Power-Automate delivery path).
 *
 * Instead of an external service pushing files to /api/ingest, the Worker pulls
 * them from Microsoft 365 on a cron and feeds the SAME ingest pipeline via
 * createIngestion(): R2 inbox + data_ingestions row + wac-ingest queue. Change
 * detection (source_marker) keeps a 30-min poll from re-ingesting unchanged
 * files. Both pullers are best-effort and never throw out of the cron.
 */

/** Coordinates for the cron-pulled sources. Stable values live here; the Open
 *  Orders mailbox is deployment config (OPEN_ORDERS_MAILBOX). */
const SOURCES = {
  territory: {
    // SharePoint "Copy link" URL to the Rep-Zip matrix (InsideSales-WACShowroom).
    // Resolved via the Graph Shares API — no site/library/path needed.
    shareUrl:
      "https://waclightingus.sharepoint.com/:x:/s/InsideSales-WACShowroom/IQDS9hL4PBACR5rpNCY1n6p6ATbniCrTSC8oLtsRrJto_6g",
  },
  openOrders: {
    sender: "Bogdan.Tataru@schonbek.com",
    subjectContains: "Open Orders Report",
    attachmentNameContains: "Open Orders Master",
    // First-run lookback so an empty marker doesn't sweep the whole mailbox.
    firstRunLookbackDays: 3,
  },
} as const;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Pull both Graph sources for one cron tick. Errors are logged, not thrown. */
export async function runGraphPull(env: Env): Promise<void> {
  if (!graphConfigured(env)) {
    console.warn("[graph] MS_* credentials unset; skipping Graph pull");
    return;
  }
  let token: string;
  try {
    token = await getGraphToken(env);
  } catch (e) {
    console.error("[graph] token acquisition failed (admin consent granted?)", e);
    return;
  }

  await pullTerritory(env, token).catch((e) =>
    console.error("[graph] territory pull failed", e),
  );
  await pullOpenOrders(env, token).catch((e) =>
    console.error("[graph] open-orders pull failed", e),
  );
}

/** Territory: ingest the SharePoint matrix only when its driveItem eTag changed. */
async function pullTerritory(env: Env, token: string): Promise<void> {
  const sb = serviceSupabase(env);
  const item = await getSharedItem(token, SOURCES.territory.shareUrl);
  const marker = driveItemMarker(item);

  const last = await getLatestIngestionMarker(sb, "territory");
  if (last && last === marker) {
    console.log("[graph] territory unchanged; skipping");
    return;
  }

  const bytes = await downloadDriveItem(token, SOURCES.territory.shareUrl, item);
  const res = await createIngestion(env, sb, {
    source: "territory",
    originalName: item.name,
    contentType: XLSX_CONTENT_TYPE,
    ext: "xlsx",
    bytes,
    deliveredBy: "graph-pull",
    sourceMarker: marker,
  });
  if (!res.ok) throw new Error(res.error);
  console.log(`[graph] territory ingested: ${item.name} (${bytes.byteLength} bytes)`);
}

/** Open Orders: ingest each new SAP email attachment newer than the last cursor. */
async function pullOpenOrders(env: Env, token: string): Promise<void> {
  const mailbox = env.OPEN_ORDERS_MAILBOX;
  if (!mailbox) {
    console.warn("[graph] OPEN_ORDERS_MAILBOX unset; skipping open-orders pull");
    return;
  }
  const sb = serviceSupabase(env);
  const last = await getLatestIngestionMarker(sb, "open-orders");
  const sinceIso = last ?? isoDaysAgo(SOURCES.openOrders.firstRunLookbackDays);

  const matched = await searchSenderMessages(token, mailbox, {
    sender: SOURCES.openOrders.sender,
    subjectContains: SOURCES.openOrders.subjectContains,
    sinceIso,
  });
  // First run (no cursor): ingest only the latest snapshot, not the whole
  // lookback window — Open Orders is a full daily snapshot, so older ones are
  // stale. After that, the cursor advances and each new email is picked up.
  const messages = last ? matched : matched.slice(-1);
  if (messages.length === 0) {
    console.log("[graph] open-orders: no new messages");
    return;
  }

  let ingested = 0;
  for (const msg of messages) {
    const att = await getMatchingAttachment(
      token,
      mailbox,
      msg.id,
      SOURCES.openOrders.attachmentNameContains,
    );
    if (!att) {
      console.warn(`[graph] open-orders msg ${msg.id} had no matching attachment`);
      continue;
    }
    const res = await createIngestion(env, sb, {
      source: "open-orders",
      originalName: att.name,
      contentType: XLSX_CONTENT_TYPE,
      ext: "xlsx",
      bytes: att.bytes,
      deliveredBy: "graph-pull",
      // Cursor: the message receivedDateTime, so the next run filters past it.
      sourceMarker: msg.receivedDateTime,
    });
    if (!res.ok) throw new Error(res.error);
    ingested++;
    console.log(
      `[graph] open-orders ingested: ${att.name} (msg ${msg.receivedDateTime})`,
    );
  }
  console.log(`[graph] open-orders: ingested ${ingested}/${messages.length} message(s)`);
}
