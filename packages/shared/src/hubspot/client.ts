import { UNIVERSAL_PIPELINE_ID } from "./dealStage.js";

/**
 * Shared HubSpot HTTP client.
 *
 * Extracted from apps/api/src/hubspotPush.ts so the 7 per-app `hs()` copies
 * (api, sales-sync, oa-sync, turnover-sync, open-orders-sync, products-sync,
 * forecast's Python twin) can converge on one implementation. hubspotPush.ts
 * re-exports these, so its 11 in-worker importers are unchanged.
 *
 * `hs()` keeps hubspotPush's exact semantics by default — retry 429 only,
 * never throw on non-2xx — because the PUSH path must not blindly retry 5xx:
 * a write that succeeded server-side but returned 500 would double-apply
 * non-idempotent creates (notes, tasks). READ callers (Thom Bot's CRM tools)
 * opt into the stronger oa-sync-style retry via `retryTransient: true`
 * (5xx + network errors), which is safe for GET/search/batch-read.
 */

const HS_BASE = "https://api.hubapi.com";
const MAX_RATE_LIMIT_RETRIES = 6;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_NET_ATTEMPTS = 12;
// HubSpot CRM search page cap; also the batch-read input cap.
const SEARCH_PAGE = 100;
const BATCH = 100;
const INTER_PAGE_MS = 120;

export const PATHS = {
  dealSearch: "/crm/v3/objects/0-3/search",
  dealUpsert: "/crm/v3/objects/0-3/batch/upsert",
  dealUpdate: "/crm/v3/objects/0-3/batch/update",
  lineItemUpsert: "/crm/v3/objects/line_items/batch/upsert",
  lineItemToDeal: "/crm/v4/associations/line_items/0-3/batch/create",
  companyToDeal: "/crm/v4/associations/companies/0-3/batch/create",
  contactToDeal: "/crm/v4/associations/contacts/0-3/batch/create",
  companyUpsert: "/crm/v3/objects/companies/batch/upsert",
  companyLookup: "/crm/v3/objects/companies/",
  companySearch: "/crm/v3/objects/companies/search",
  contactLookup: "/crm/v3/objects/contacts/",
  contactSearch: "/crm/v3/objects/contacts/search",
  owners: "/crm/v3/owners",
  dealPipeline: `/crm/v3/pipelines/deals/${UNIVERSAL_PIPELINE_ID}`,
  dealPipelineStage: `/crm/v3/pipelines/deals/${UNIVERSAL_PIPELINE_ID}/stages`,
  leadCreate: "/crm/v3/objects/leads",
  // Zendesk ticket mirror (zendeskSync.ts / quoteDesk.ts).
  ticketCreate: "/crm/v3/objects/tickets",
  noteCreate: "/crm/v3/objects/notes",
  contactCreate: "/crm/v3/objects/contacts",
};

export const ASSOC = {
  category: "HUBSPOT_DEFINED",
  lineItemToDeal: 20,
  companyToDeal: 6,
  contactToDeal: 4,
  // HubSpot-defined defaults used by the Zendesk ticket mirror.
  ticketToDeal: 28,
  ticketToContact: 16,
  noteToTicket: 228,
  noteToDeal: 214,
};

export interface HsResponse {
  ok: boolean;
  status: number;
  data: any;
}

export interface HsOpts {
  /**
   * Also retry 5xx (500/502/503/504) and network errors with backoff.
   * ONLY for read paths — see the module header for why writes must not.
   */
  retryTransient?: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One HubSpot call with 429 backoff. Returns parsed body + status (never throws on non-2xx). */
export async function hs(
  token: string,
  method: string,
  path: string,
  body: unknown | undefined,
  signal?: AbortSignal,
  opts?: HsOpts,
): Promise<HsResponse> {
  let attempt = 0;
  let netAttempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(`${HS_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (e) {
      // An aborted signal must propagate; only genuine network errors retry.
      if (!opts?.retryTransient || signal?.aborted || netAttempt >= MAX_NET_ATTEMPTS) {
        throw e;
      }
      netAttempt++;
      await delay(Math.min(60_000, 1000 * 2 ** (netAttempt - 1)));
      continue;
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    const retryable = opts?.retryTransient
      ? RETRY_STATUSES.has(res.status)
      : res.status === 429;
    if (retryable && attempt < MAX_RATE_LIMIT_RETRIES) {
      const ra = Number(res.headers.get("retry-after"));
      const wait =
        Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(10_000, 500 * 2 ** attempt);
      await delay(wait);
      attempt++;
      continue;
    }
    return { ok: res.ok, status: res.status, data };
  }
}

// ---------------------------------------------------------------------------
// Read helpers (Thom Bot's CRM tools; any future read path)
// ---------------------------------------------------------------------------

export interface HsObject {
  id: string;
  properties: Record<string, string | null>;
}

export interface HsSearchFilter {
  propertyName: string;
  operator: string;
  value?: string;
  values?: string[];
}

export interface SearchAllOpts {
  /** Hard cap on rows returned. REQUIRED thinking for chat-driven callers. */
  maxResults?: number;
  signal?: AbortSignal;
}

/**
 * Page a CRM search by ascending hs_object_id (GT filter + ASC sort).
 * This is the ONLY way past HubSpot's silent 10,000-result search cap —
 * offset paging stops dead at 10k with no error. Ported from
 * apps/forecast/src/wac_forecast/extract/hubspot.py iter_search().
 *
 * `filters` are ANDed together (one filterGroup) alongside the paging filter.
 */
export async function* searchAll(
  token: string,
  objectType: string,
  filters: HsSearchFilter[],
  properties: string[],
  opts?: SearchAllOpts,
): AsyncGenerator<HsObject> {
  let lastId = "0";
  let seen = 0;
  const max = opts?.maxResults ?? Infinity;
  for (;;) {
    const res = await hs(
      token,
      "POST",
      `/crm/v3/objects/${objectType}/search`,
      {
        filterGroups: [
          {
            filters: [
              ...filters,
              { propertyName: "hs_object_id", operator: "GT", value: lastId },
            ],
          },
        ],
        sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
        properties,
        limit: SEARCH_PAGE,
      },
      opts?.signal,
      { retryTransient: true },
    );
    if (!res.ok) {
      throw new Error(
        `HubSpot search ${objectType} -> ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`,
      );
    }
    const results: HsObject[] = res.data?.results ?? [];
    if (!results.length) return;
    for (const r of results) {
      yield r;
      seen++;
      if (seen >= max) return;
    }
    lastId = results[results.length - 1]!.id;
    if (results.length < SEARCH_PAGE) return;
    await delay(INTER_PAGE_MS);
  }
}

/** Clamp n into [lo, hi] (non-finite → lo). Exported for unit testing. */
export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

/**
 * A SINGLE sorted search page — the top-N objects by a metric. Unlike
 * searchAll (which pages by ascending hs_object_id and so CANNOT sort by a
 * business metric), this asks HubSpot to sort server-side and returns just the
 * first page. HubSpot serves up to 200 results/page, which is plenty for any
 * "top N" ranking. No pagination — `limit` is clamped to [1, 200].
 *
 * `filters` are ANDed together in one filterGroup.
 */
export async function searchTop(
  token: string,
  objectType: string,
  filters: HsSearchFilter[],
  properties: string[],
  sort: { propertyName: string; direction: "ASCENDING" | "DESCENDING" },
  limit: number,
  signal?: AbortSignal,
): Promise<HsObject[]> {
  const res = await hs(
    token,
    "POST",
    `/crm/v3/objects/${objectType}/search`,
    {
      filterGroups: [{ filters }],
      sorts: [sort],
      properties,
      limit: clamp(limit, 1, 200),
    },
    signal,
    { retryTransient: true },
  );
  if (!res.ok) {
    throw new Error(
      `HubSpot searchTop ${objectType} -> ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`,
    );
  }
  return (res.data?.results ?? []) as HsObject[];
}

/**
 * Batch-read objects by id or by a unique idProperty. HubSpot returns 207
 * (multi-status) when some/all inputs matched nothing — that's a normal
 * "not found" outcome here, not an error.
 */
export async function batchRead(
  token: string,
  objectType: string,
  values: string[],
  properties: string[],
  opts?: { idProperty?: string; signal?: AbortSignal },
): Promise<Map<string, HsObject>> {
  const map = new Map<string, HsObject>();
  const uniq = [...new Set(values.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += BATCH) {
    const res = await hs(
      token,
      "POST",
      `/crm/v3/objects/${objectType}/batch/read`,
      {
        ...(opts?.idProperty ? { idProperty: opts.idProperty } : {}),
        properties,
        inputs: uniq.slice(i, i + BATCH).map((v) => ({ id: v })),
      },
      opts?.signal,
      { retryTransient: true },
    );
    if (!res.ok && res.status !== 207) {
      throw new Error(
        `HubSpot batch-read ${objectType} -> ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`,
      );
    }
    for (const r of (res.data?.results ?? []) as HsObject[]) {
      const key = opts?.idProperty ? r.properties[opts.idProperty] : r.id;
      if (key) map.set(key, r);
    }
  }
  return map;
}

/** Fetch one object by id with an explicit property list; null when 404. */
export async function getById(
  token: string,
  objectType: string,
  id: string,
  properties: string[],
  opts?: { signal?: AbortSignal; associations?: string[] },
): Promise<HsObject | null> {
  const params = new URLSearchParams({ properties: properties.join(",") });
  if (opts?.associations?.length) params.set("associations", opts.associations.join(","));
  const res = await hs(
    token,
    "GET",
    `/crm/v3/objects/${objectType}/${encodeURIComponent(id)}?${params}`,
    undefined,
    opts?.signal,
    { retryTransient: true },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `HubSpot get ${objectType}/${id} -> ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`,
    );
  }
  return res.data as HsObject;
}

/**
 * Property names that exist on an object type. Lets a caller warn-and-skip
 * missing properties instead of erroring the whole request (the pattern
 * forecast's Python client uses before every pull).
 */
export async function existingProperties(
  token: string,
  objectType: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const res = await hs(token, "GET", `/crm/v3/properties/${objectType}`, undefined, signal, {
    retryTransient: true,
  });
  if (!res.ok) {
    throw new Error(`HubSpot properties ${objectType} -> ${res.status}`);
  }
  return new Set(
    ((res.data?.results ?? []) as { name: string }[]).map((p) => p.name),
  );
}
