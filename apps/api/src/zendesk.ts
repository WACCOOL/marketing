import type { Env } from "./env.js";

/**
 * Zendesk REST client + constants for the ticket mirror (zendeskSync.ts) and
 * the Quote Desk create flow (quoteDesk.ts). Mirrors the shape of hs() in
 * hubspotPush.ts: one call, 429 backoff via Retry-After, never throws on
 * non-2xx — callers branch on {ok, status, data}.
 *
 * Auth is the API-token basic scheme: base64("{email}/token:{api_token}").
 * All three ZENDESK_* env values must be set or callers get a clear error.
 */

const MAX_RATE_LIMIT_RETRIES = 6;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ZdResponse {
  ok: boolean;
  status: number;
  data: any;
}

export function zendeskConfigured(env: Env): boolean {
  return !!(env.ZENDESK_SUBDOMAIN && env.ZENDESK_EMAIL && env.ZENDESK_API_TOKEN);
}

export function zendeskBaseUrl(env: Env): string {
  return `https://${env.ZENDESK_SUBDOMAIN}.zendesk.com`;
}

/** Agent-facing ticket URL (for HubSpot ticket props / card links). */
export function zendeskTicketUrl(env: Env, ticketId: number): string {
  return `${zendeskBaseUrl(env)}/agent/tickets/${ticketId}`;
}

/** One Zendesk call with 429 backoff. Returns parsed body + status (never throws on non-2xx). */
export async function zd(
  env: Env,
  method: string,
  path: string,
  body: unknown | undefined,
  signal: AbortSignal,
): Promise<ZdResponse> {
  if (!zendeskConfigured(env)) {
    return { ok: false, status: 0, data: { error: "zendesk not configured" } };
  }
  const auth = btoa(`${env.ZENDESK_EMAIL}/token:${env.ZENDESK_API_TOKEN}`);
  let attempt = 0;
  for (;;) {
    const res = await fetch(`${zendeskBaseUrl(env)}${path}`, {
      method,
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(10_000, 500 * 2 ** attempt);
      await delay(wait);
      attempt++;
      continue;
    }
    return { ok: res.ok, status: res.status, data };
  }
}

export const ZD = {
  ticket: (id: number) => `/api/v2/tickets/${id}.json`,
  tickets: "/api/v2/tickets.json",
  ticketsShowMany: (ids: number[]) => `/api/v2/tickets/show_many.json?ids=${ids.join(",")}`,
  comments: (id: number) => `/api/v2/tickets/${id}/comments.json?include=users`,
  search: (query: string) => `/api/v2/search.json?query=${encodeURIComponent(query)}`,
  user: (id: number) => `/api/v2/users/${id}.json`,
  userSearch: (email: string) =>
    `/api/v2/users/search.json?query=${encodeURIComponent(`email:${email}`)}`,
};

/**
 * Zendesk ticket-field ids reused from the retired make.com scenario — these
 * already exist in the Quotes workflow, no new Zendesk fields needed.
 */
export const ZD_FIELDS = {
  /** "HubSpot Deal ID" — the primary deal-adoption key. */
  hubspotDealId: 36980915830167,
  /** "Quote Number" (SAP) — the secondary deal-adoption key. */
  quoteNumber: 1500004166021,
  /** "(Quotes) Category" — quotations | custom | international … */
  category: 1500004155501,
  /** "(Quotes) Task Type(s)" (multi-select). */
  taskTypes: 1500004167081,
  /** "Quote Need Date". */
  needDate: 1500004165781,
  /** "Project Name". */
  projectName: 1500004165721,
  /** "Account Number". */
  accountNumber: 1500004238882,
  /** "SO Number" / "PO Number". */
  soNumber: 1500004166201,
  poNumber: 1500004166221,
  /** "Special Pricing" (discount request). */
  specialPricing: 1500004238962,
  /** "Air Freight Pricing". */
  airFreight: 1500004239002,
  /** "Submittal Needed". */
  submittalNeeded: 1900000603165,
  /** "(Quote) Requestor". */
  requestor: 1900007701225,
  /** "Project Location (Address)". */
  projectLocation: 1500004238902,
  /** "Existing Rep Code/Agency". */
  repCode: 1500004862421,
  /** "Urgency". */
  urgency: 1500003988262,
} as const;

/** The Quotes group — the quote-request lifecycle applies inside this group. */
export const ZD_QUOTES_GROUP = 1500002309801;

export function customFieldValue(
  ticket: { custom_fields?: { id: number; value: unknown }[] },
  fieldId: number,
): string | null {
  const f = ticket.custom_fields?.find((c) => c.id === fieldId);
  if (!f || f.value === null || f.value === undefined) return null;
  const s = String(f.value).trim();
  return s || null;
}

// ---------------------------------------------------------------------------
// ZD_SYNC_GROUPS — the group allowlist + per-group HubSpot pipeline mapping
// ---------------------------------------------------------------------------

export interface ZdGroupConfig {
  /** Display name, for logs/props. */
  name: string;
  /** HubSpot ticket pipeline id tickets from this group land in. */
  pipelineId: string;
  /** Zendesk status → HubSpot pipeline stage id. Every status must map. */
  stages: Record<string, string>;
}

/**
 * Parse the ZD_SYNC_GROUPS JSON var: { "<zendesk group id>": {name, pipelineId,
 * stages: {new, open, pending, hold, solved, closed}} }. Only tickets whose
 * group is a key here sync — internal groups (IT/HR) are excluded by omission.
 */
export function parseSyncGroups(env: Env): Map<number, ZdGroupConfig> {
  const out = new Map<number, ZdGroupConfig>();
  if (!env.ZD_SYNC_GROUPS) return out;
  let raw: Record<string, ZdGroupConfig>;
  try {
    raw = JSON.parse(env.ZD_SYNC_GROUPS);
  } catch (e) {
    console.error("[zendesk-sync] ZD_SYNC_GROUPS is not valid JSON:", e);
    return out;
  }
  for (const [id, cfg] of Object.entries(raw)) {
    const groupId = Number(id);
    if (!Number.isFinite(groupId) || !cfg?.pipelineId || !cfg?.stages) {
      console.error(`[zendesk-sync] ZD_SYNC_GROUPS entry ${id} malformed; skipping`);
      continue;
    }
    out.set(groupId, { name: cfg.name ?? id, pipelineId: cfg.pipelineId, stages: cfg.stages });
  }
  return out;
}
