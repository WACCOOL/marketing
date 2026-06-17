import type { Env } from "./env.js";

/**
 * Microsoft Graph app-only client (client-credentials).
 *
 * Used by the scheduled Graph pullers (graphPull.ts) to read the Territory file
 * from SharePoint and the Open Orders attachment from a mailbox — no signed-in
 * user. Requires the MS_* secrets and admin-consented Application permissions
 * (Sites.Read.All, Mail.Read). The token is fetched once per cron tick and
 * passed into the pullers, so there is no module-global token cache.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** True when the Graph credentials are configured (cron skips otherwise). */
export function graphConfigured(env: Env): boolean {
  return !!(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET);
}

/** Acquire an app-only Graph access token (client-credentials, .default scope). */
export async function getGraphToken(env: Env): Promise<string> {
  if (!graphConfigured(env)) {
    throw new Error("Microsoft Graph credentials (MS_*) are not configured");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.MS_CLIENT_ID!,
    client_secret: env.MS_CLIENT_SECRET!,
    scope: "https://graph.microsoft.com/.default",
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!res.ok) {
    throw new Error(`graph token request failed ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

async function graphGet(token: string, pathOrUrl: string): Promise<Response> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`graph GET ${pathOrUrl} -> ${res.status}: ${await res.text()}`);
  }
  return res;
}

async function graphJson<T>(token: string, pathOrUrl: string): Promise<T> {
  return (await graphGet(token, pathOrUrl)).json() as Promise<T>;
}

// --- SharePoint shared items (Territory) -------------------------------------

/**
 * Encode a SharePoint sharing URL into a Graph share id ("u!" + base64url),
 * per the Shares API. Lets us resolve a "Copy link" URL straight to a driveItem
 * without knowing the site/library/path.
 */
export function encodeShareUrl(shareUrl: string): string {
  const b64 = btoa(shareUrl)
    .replace(/=+$/, "")
    .replace(/\//g, "_")
    .replace(/\+/g, "-");
  return `u!${b64}`;
}

export interface DriveItemMeta {
  id: string;
  name: string;
  size?: number;
  eTag?: string;
  cTag?: string;
  lastModifiedDateTime?: string;
  /** Pre-authenticated download URL (instance annotation on a driveItem GET). */
  "@microsoft.graph.downloadUrl"?: string;
}

/** Resolve a sharing URL to its driveItem metadata (incl. the download URL). */
export async function getSharedItem(
  token: string,
  shareUrl: string,
): Promise<DriveItemMeta> {
  const sid = encodeShareUrl(shareUrl);
  return graphJson<DriveItemMeta>(token, `/shares/${sid}/driveItem`);
}

/** A stable change marker for a driveItem (eTag preferred, else modified time). */
export function driveItemMarker(item: DriveItemMeta): string {
  return item.eTag ?? item.cTag ?? item.lastModifiedDateTime ?? item.id;
}

/** Download a resolved driveItem's bytes via its pre-authed URL (no auth header). */
export async function downloadDriveItem(
  token: string,
  shareUrl: string,
  item: DriveItemMeta,
): Promise<ArrayBuffer> {
  const direct = item["@microsoft.graph.downloadUrl"];
  if (direct) {
    const res = await fetch(direct);
    if (!res.ok) throw new Error(`download failed ${res.status}`);
    return res.arrayBuffer();
  }
  // Fallback: /content follows a 302 to a pre-authed URL.
  const sid = encodeShareUrl(shareUrl);
  return (await graphGet(token, `/shares/${sid}/driveItem/content`)).arrayBuffer();
}

// --- Mail (Open Orders) ------------------------------------------------------

export interface GraphMessage {
  id: string;
  subject: string | null;
  receivedDateTime: string;
  from?: { emailAddress?: { address?: string } };
  hasAttachments: boolean;
}

/**
 * Find recent messages from a sender that carry an attachment, newer than
 * `sinceIso`, returned oldest-first.
 *
 * Graph rejects a server-side `from/emailAddress/address eq` filter
 * ("InefficientFilter"), and a plain date-ordered page misses the target in a
 * busy mailbox. KQL `$search="from:…"` is the one reliable selector — but it
 * can't combine with `$filter`/`$orderby`, so attachment / subject / date-cursor
 * are applied client-side over the (≤25) search hits.
 */
export async function searchSenderMessages(
  token: string,
  mailbox: string,
  opts: { sender: string; subjectContains?: string; sinceIso?: string },
): Promise<GraphMessage[]> {
  const q = new URLSearchParams();
  q.set("$search", `"from:${opts.sender}"`);
  q.set("$top", "25");
  q.set("$select", "id,subject,receivedDateTime,from,hasAttachments");
  const data = await graphJson<{ value: GraphMessage[] }>(
    token,
    `/users/${encodeURIComponent(mailbox)}/messages?${q.toString()}`,
  );
  const subject = opts.subjectContains?.toLowerCase();
  return data.value
    .filter((m) => m.hasAttachments)
    .filter((m) => !subject || (m.subject ?? "").toLowerCase().includes(subject))
    .filter((m) => !opts.sinceIso || m.receivedDateTime > opts.sinceIso!)
    .sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime));
}

interface GraphFileAttachment {
  "@odata.type": string;
  id: string;
  name: string;
  contentType: string;
  size: number;
  contentBytes?: string; // base64 (file attachments)
}

/** Decode a base64 attachment body to an ArrayBuffer. */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

/**
 * Return the first file attachment whose name contains `nameContains` (case-
 * insensitive), with its bytes. Null if the message has no matching attachment.
 */
export async function getMatchingAttachment(
  token: string,
  mailbox: string,
  messageId: string,
  nameContains: string,
): Promise<{ name: string; bytes: ArrayBuffer } | null> {
  const data = await graphJson<{ value: GraphFileAttachment[] }>(
    token,
    `/users/${encodeURIComponent(mailbox)}/messages/${messageId}/attachments`,
  );
  const needle = nameContains.toLowerCase();
  const match = data.value.find(
    (a) =>
      a["@odata.type"] === "#microsoft.graph.fileAttachment" &&
      a.name.toLowerCase().includes(needle) &&
      a.contentBytes,
  );
  if (!match || !match.contentBytes) return null;
  return { name: match.name, bytes: base64ToArrayBuffer(match.contentBytes) };
}
