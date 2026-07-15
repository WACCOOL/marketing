import {
  COMPANY_FIELD_MAP,
  DEAL_DATE_FIELDS,
  DEAL_FIELD_MAP,
  DEAL_STAGE_IDS,
  LINE_ITEM_DATE_FIELDS,
  LINE_ITEM_FIELD_MAP,
  SPECIFIER_LABEL,
  UNIVERSAL_PIPELINE_ID,
  deriveCreateDate,
  deriveDealAmount,
  deriveDealStageAndCloseDate,
  lineItemDates,
  toEpochMs,
  parseAnnuityGrid,
  wildcardToRegExp,
  accountForms,
  buildRepCodeCreateProperties,
  buildRepCodeTaskContent,
  companyStatusFromRiskCategory,
  computeInsideSalesFields,
  extractInvalidPropertyItems,
  healProperties,
  isValidationError,
  mapFields,
  normalizeRepCodeForCreate,
  parseRepCodes,
  repCodeInactiveFromCompanyStatus,
  repCodeSyncProperties,
  resolveRepCodeSchema,
  smartMatchToAllowedOptions,
  solveStageProbabilities,
  specifierAccountNumbers,
  toDecimalPercent,
  toHubspotDate,
  toNumber,
  weightedAverageProbability,
  type ExistingDealState,
  type FixAction,
  type InsideSalesResolvers,
  type RepCodeSchema,
  type StageOpenCounts,
} from "@wac/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import type { Env } from "./env.js";
import { downloadDriveItem, getGraphToken, getSharedItem, graphConfigured } from "./graph.js";
import {
  loadAliases,
  loadOptions,
  normalizeWithLearning,
  persistAliases,
  upsertPropertyOptions,
  type LearnEntry,
  type OptionDef,
} from "./hubspotHeal.js";

/**
 * Worker-side HubSpot push (Phase 2) — ported from the two AWS Lambdas so the
 * Worker owns mapping + dedup + push + self-healing. fetch-based (no axios), uses
 * the Worker's own HUBSPOT_TOKEN secret, and reports every heal/association
 * action so the dashboard shows exactly what happened. The pure matching lives in
 * @wac/shared (heal.ts / mapping.ts); this module is the HTTP + orchestration.
 * (Separate from hubspot.ts, which is the read-only campaign adapter.)
 */

const HS_BASE = "https://api.hubapi.com";

/**
 * Universal Pipeline (deals) + its stages — canonical ids live in
 * @wac/shared/hubspot/dealStage.ts (shared with the territory-sync close-date
 * reconcile). The probability calibration touches prequal..awarded only;
 * Closed Won/Lost are fixed by HubSpot (100% / 0%) and untouched.
 */
export { UNIVERSAL_PIPELINE_ID } from "@wac/shared";
export const DEAL_STAGES = DEAL_STAGE_IDS;

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

const BATCH_SIZE = 100;
const INTER_BATCH_MS = 250;
const MAX_RATE_LIMIT_RETRIES = 6;
const MAX_FIX_RETRIES = 3;

export interface AssocSkip {
  objectType: string;
  property: string;
  rawValue: string | null;
  reason: string;
}
export interface PushOutcome {
  result: unknown;
  error: string | null;
  status: number;
  fixActions: (FixAction & { scope?: string })[];
  assocSkips: AssocSkip[];
}

interface HsResponse {
  ok: boolean;
  status: number;
  data: any;
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
  signal: AbortSignal,
): Promise<HsResponse> {
  let attempt = 0;
  for (;;) {
    const res = await fetch(`${HS_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
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

/** A HubSpot error we couldn't heal — carries status + body for outcome recording. */
class HsError extends Error {
  status: number;
  data: any;
  constructor(res: HsResponse) {
    super(typeof res.data?.message === "string" ? res.data.message : `HubSpot ${res.status}`);
    this.status = res.status;
    this.data = res.data;
  }
}

/**
 * Run a single-object request with the heal loop: on a validation error, smart-match
 * or drop the offending properties (recording actions) and retry; throw if unrecoverable.
 */
export async function withHeal(
  token: string,
  signal: AbortSignal,
  scope: string,
  fixActions: (FixAction & { scope?: string })[],
  initialProps: Record<string, unknown>,
  send: (props: Record<string, unknown>) => Promise<HsResponse>,
): Promise<HsResponse> {
  let props = initialProps;
  let attempt = 0;
  for (;;) {
    const res = await send(props);
    if (res.ok) return res;
    if (!isValidationError(res.data) || attempt >= MAX_FIX_RETRIES) throw new HsError(res);
    const healed = healProperties(props, res.data);
    if (!healed.changed) throw new HsError(res);
    for (const a of healed.actions) fixActions.push({ ...a, scope });
    props = healed.properties;
    attempt++;
  }
}

/* ----------------------------- owner resolution ---------------------------- */

export interface OwnerRec {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}
interface OwnerMaps {
  byFullName: Map<string, OwnerRec>;
  bySurnameInitial: Map<string, OwnerRec | null>; // null = ambiguous
  at: number;
}
let ownerCache: OwnerMaps | null = null;
const OWNER_TTL_MS = 10 * 60 * 1000;

async function getOwnerMaps(token: string, signal: AbortSignal): Promise<OwnerMaps> {
  if (ownerCache && Date.now() - ownerCache.at < OWNER_TTL_MS) return ownerCache;
  const byFullName = new Map<string, OwnerRec>();
  const bySurnameInitial = new Map<string, OwnerRec | null>();
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const qs = `?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const res = await hs(token, "GET", `${PATHS.owners}${qs}`, undefined, signal);
    if (!res.ok) break;
    for (const o of res.data?.results ?? []) {
      const first = String(o.firstName ?? "").trim().toLowerCase();
      const last = String(o.lastName ?? "").trim().toLowerCase();
      const email = String(o.email ?? "");
      const id = String(o.id ?? "");
      if (!id || !email) continue;
      if (first && last) {
        const rec: OwnerRec = { id, email, firstName: String(o.firstName), lastName: String(o.lastName) };
        byFullName.set(`${first} ${last}`, rec);
        const key = `${last} ${first[0]}`;
        bySurnameInitial.set(key, bySurnameInitial.has(key) ? null : rec);
      }
    }
    after = res.data?.paging?.next?.after;
    if (!after) break;
  }
  ownerCache = { byFullName, bySurnameInitial, at: Date.now() };
  return ownerCache;
}

/** Resolve a "First Last" name to a HubSpot user/owner (exact, then surname+initial). */
export async function resolveOwnerByName(
  token: string,
  name: string,
  signal: AbortSignal,
): Promise<OwnerRec | null> {
  const parts = name.trim().toLowerCase().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  const maps = await getOwnerMaps(token, signal);
  const exact = maps.byFullName.get(`${parts[0]} ${parts[parts.length - 1]}`);
  if (exact) return exact;
  return maps.bySurnameInitial.get(`${parts[parts.length - 1]} ${parts[0]![0]}`) ?? null;
}

/* ---------------------------- contact resolution --------------------------- */

/** SAP caps `requested_by` at 20 chars, so any value at/over the cap is a
 *  truncated email (the TLD is cut off) — never treat it as complete. */
const SAP_REQUESTED_BY_LEN = 20;

/** Likely TLD completions for a truncated last segment (first letter -> candidates). */
const TLD_COMPLETIONS: Record<string, string[]> = {
  c: ["com", "co"],
  n: ["net"],
  o: ["org"],
  i: ["io"],
  b: ["biz"],
  u: ["us"],
};

function isValidEmail(email: unknown): boolean {
  // require a 2+ char TLD so a chopped ".c" / ".n" can't masquerade as valid
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email ?? ""));
}

export interface ContactByEmail {
  id: string;
  email: string;
}

export async function getContactByEmailExact(
  token: string,
  email: string,
  signal: AbortSignal,
): Promise<ContactByEmail | null> {
  const path = `${PATHS.contactLookup}${encodeURIComponent(email)}?idProperty=email&properties=email`;
  const res = await hs(token, "GET", path, undefined, signal);
  if (res.status === 404 || !res.data?.id) return null;
  if (!res.ok) throw new HsError(res);
  return { id: String(res.data.id), email: String(res.data?.properties?.email ?? email) };
}

async function findContactByEmailPrefix(
  token: string,
  prefix: string,
  signal: AbortSignal,
  repDomain?: string,
): Promise<{ contact: ContactByEmail | null; reason: string }> {
  const res = await hs(
    token,
    "POST",
    PATHS.contactSearch,
    {
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "CONTAINS_TOKEN", value: `${prefix}*` }] },
      ],
      properties: ["email", "firstname", "lastname", "num_associated_deals"],
      limit: 10,
    },
    signal,
  );
  if (!res.ok) throw new HsError(res);
  const matches = (res.data?.results ?? []).filter((r: any) =>
    String(r?.properties?.email ?? "").toLowerCase().startsWith(prefix),
  );
  if (matches.length === 1) {
    return {
      contact: { id: String(matches[0].id), email: matches[0].properties?.email ?? prefix },
      reason: "email prefix match",
    };
  }
  // Strongest tie-break: the candidate whose domain == the deal's rep-company
  // domain (a contact at the rep IS the right person).
  if (repDomain && matches.length > 1) {
    const repMatches = matches.filter((m: any) =>
      String(m?.properties?.email ?? "").toLowerCase().endsWith(`@${repDomain}`),
    );
    if (repMatches.length === 1) {
      return {
        contact: { id: String(repMatches[0].id), email: repMatches[0].properties?.email ?? prefix },
        reason: "email prefix match (rep-domain tie-break)",
      };
    }
  }
  // Tie-break: exactly 2 candidates and only one is a .com → prefer the .com.
  if (matches.length === 2) {
    const dotcom = matches.filter((m: any) =>
      String(m?.properties?.email ?? "").toLowerCase().endsWith(".com"),
    );
    if (dotcom.length === 1) {
      return {
        contact: { id: String(dotcom[0].id), email: dotcom[0].properties?.email ?? prefix },
        reason: "email prefix match (.com tie-break)",
      };
    }
  }
  // Tie-break: the candidate associated with a company that IS a rep is the one.
  // Tie-break: prefer the most complete, REAL profile over typo'd duplicates — a
  // typo email has a domain that isn't a real company, usually no deals and no name.
  if (matches.length > 1) {
    const scored = await Promise.all(
      matches.map(async (m: any) => {
        const email = String(m.properties?.email ?? "").toLowerCase();
        const domain = email.split("@")[1] ?? "";
        const realDomain = domain ? await companyDomainExists(token, domain, signal) : false;
        const deals = Number(m.properties?.num_associated_deals ?? 0) || 0;
        const named = (m.properties?.firstname ? 1 : 0) + (m.properties?.lastname ? 1 : 0);
        return { m, score: (realDomain ? 100 : 0) + deals * 10 + named };
      }),
    );
    const max = Math.max(...scored.map((s) => s.score));
    const top = scored.filter((s) => s.score === max);
    if (max > 0 && top.length === 1) {
      const m = top[0]!.m;
      return {
        contact: { id: String(m.id), email: m.properties?.email ?? prefix },
        reason: "email prefix match (best-profile tie-break)",
      };
    }
  }
  if (matches.length > 1) {
    const repFlags = await Promise.all(matches.map((m: any) => isContactAtRep(token, String(m.id), signal)));
    const repHits = matches.filter((_: any, i: number) => repFlags[i]);
    if (repHits.length === 1) {
      return {
        contact: { id: String(repHits[0].id), email: repHits[0].properties?.email ?? prefix },
        reason: "email prefix match (rep-association tie-break)",
      };
    }
  }
  if (matches.length > 1) {
    return { contact: null, reason: `ambiguous email prefix — ${matches.length} contacts match "${prefix}"` };
  }
  return { contact: null, reason: `no contact whose email starts with "${prefix}"` };
}

/** Email domains too generic to match a rep on. */
export const GENERIC_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
  "me.com", "live.com", "msn.com", "comcast.net", "att.net", "verizon.net",
]);

/**
 * Rep Code custom object (2-41537429) property holding the rep's account number —
 * confirmed via /crm/v3/properties/2-41537429 as `account` (label "Account #").
 * That account number matches a Company's account_number_, identifying the rep.
 */
const REP_CODE_ACCOUNT_PROP = "account";

interface ContactRec {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

/** Create a HubSpot contact from a COMPLETE email (+ name). 409 -> fetch existing. */
async function createContact(
  token: string,
  props: { email: string; firstName?: string; lastName?: string },
  signal: AbortSignal,
): Promise<string | null> {
  const properties: Record<string, string> = { email: props.email };
  if (props.firstName) properties.firstname = props.firstName;
  if (props.lastName) properties.lastname = props.lastName;
  const res = await hs(token, "POST", "/crm/v3/objects/contacts", { properties }, signal);
  if (res.ok && res.data?.id) return String(res.data.id);
  if (res.status === 409) {
    const existing = await getContactByEmailExact(token, props.email, signal);
    return existing?.id ?? null;
  }
  console.error(`[push] createContact failed ${res.status}`);
  return null;
}

/** Match "First Last" within a small contact pool (exact, then first-initial+last). */
function matchNameInContacts(name: string, pool: ContactRec[]): ContactRec | null {
  const parts = name.trim().toLowerCase().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const withEmail = pool.filter((c) => c.email);
  let hits = withEmail.filter(
    (c) => c.firstName.toLowerCase() === first && c.lastName.toLowerCase() === last,
  );
  if (hits.length === 1) return hits[0]!;
  hits = withEmail.filter(
    (c) => c.lastName.toLowerCase() === last && c.firstName.toLowerCase().startsWith(first[0]!),
  );
  return hits.length === 1 ? hits[0]! : null;
}

/** Find a HubSpot contact by exact first+last name — only when it's UNIQUE (one such person). */
async function findUniqueContactByName(
  token: string,
  name: string,
  signal: AbortSignal,
): Promise<{ id: string; email: string } | null> {
  const parts = name.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const res = await hs(
    token,
    "POST",
    PATHS.contactSearch,
    {
      filterGroups: [
        {
          filters: [
            { propertyName: "firstname", operator: "EQ", value: first },
            { propertyName: "lastname", operator: "EQ", value: last },
          ],
        },
      ],
      properties: ["email", "firstname", "lastname"],
      limit: 5,
    },
    signal,
  );
  if (!res.ok) return null;
  const withEmail = (res.data?.results ?? []).filter((c: any) => c.properties?.email);
  if (withEmail.length === 1) {
    return { id: String(withEmail[0].id), email: String(withEmail[0].properties.email) };
  }
  return null;
}

async function batchReadContacts(
  token: string,
  ids: string[],
  signal: AbortSignal,
): Promise<ContactRec[]> {
  if (!ids.length) return [];
  const res = await hs(
    token,
    "POST",
    "/crm/v3/objects/contacts/batch/read",
    { properties: ["email", "firstname", "lastname"], inputs: ids.slice(0, 100).map((id) => ({ id })) },
    signal,
  );
  if (!res.ok) return [];
  return (res.data?.results ?? []).map((c: any) => ({
    id: String(c.id),
    email: String(c.properties?.email ?? ""),
    firstName: String(c.properties?.firstname ?? ""),
    lastName: String(c.properties?.lastname ?? ""),
  }));
}

/**
 * Last-resort: a requested_by NAME with no matching HubSpot user. Resolve the
 * deal's rep company (sales_group -> Rep Code 2-41537429 -> account number -> the
 * Company with that account_number_) and match the name against that rep's
 * contacts (associated, then same non-generic email domain). Fully fail-soft.
 */
/** Resolve the deal's rep company (sales_group -> Rep Code `account` -> Company) + its verified domain. */
async function resolveRepCompany(
  token: string,
  salesGroup: unknown,
  signal: AbortSignal,
): Promise<{ id: string; domain: string } | null> {
  const sg = salesGroup != null ? String(salesGroup).trim() : "";
  if (!sg) return null;
  const rc = await hs(
    token,
    "POST",
    "/crm/v3/objects/2-41537429/batch/read",
    { idProperty: "rep_code", properties: [REP_CODE_ACCOUNT_PROP], inputs: [{ id: sg }] },
    signal,
  );
  const acct = rc.ok ? String(rc.data?.results?.[0]?.properties?.[REP_CODE_ACCOUNT_PROP] ?? "").trim() : "";
  if (!acct) return null;
  const id = await lookupCompanyId(token, acct, signal);
  if (!id) return null;
  const co = await hs(token, "GET", `${PATHS.companyLookup}${id}?properties=domain`, undefined, signal);
  const domain = co.ok ? String(co.data?.properties?.domain ?? "").toLowerCase().trim() : "";
  return { id, domain };
}

/** True if an account number is on a Rep Code (i.e. the company is one of our reps). */
async function isRepAccount(token: string, accountNumber: string, signal: AbortSignal): Promise<boolean> {
  if (!accountNumber) return false;
  const res = await hs(
    token,
    "POST",
    "/crm/v3/objects/2-41537429/search",
    {
      filterGroups: [{ filters: [{ propertyName: "account", operator: "EQ", value: accountNumber }] }],
      properties: ["account"],
      limit: 1,
    },
    signal,
  );
  return res.ok && (res.data?.results?.length ?? 0) > 0;
}

/** True if a contact is associated with a company that is a rep. */
async function isContactAtRep(token: string, contactId: string, signal: AbortSignal): Promise<boolean> {
  const assoc = await hs(token, "GET", `/crm/v4/objects/contacts/${contactId}/associations/companies?limit=20`, undefined, signal);
  const ids = (assoc.ok ? assoc.data?.results ?? [] : [])
    .map((r: any) => String(r.toObjectId ?? r.to?.id ?? ""))
    .filter(Boolean);
  if (!ids.length) return false;
  const br = await hs(
    token,
    "POST",
    "/crm/v3/objects/companies/batch/read",
    { properties: ["account_number_"], inputs: ids.map((id: string) => ({ id })) },
    signal,
  );
  const accts = (br.ok ? br.data?.results ?? [] : [])
    .map((c: any) => String(c.properties?.account_number_ ?? ""))
    .filter(Boolean);
  for (const a of accts) if (await isRepAccount(token, a, signal)) return true;
  return false;
}

/** True if any HubSpot company has this exact domain (used to verify a reconstructed TLD). */
async function companyDomainExists(token: string, domain: string, signal: AbortSignal): Promise<boolean> {
  if (!domain) return false;
  const res = await hs(
    token,
    "POST",
    "/crm/v3/objects/companies/search",
    {
      filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: domain }] }],
      properties: ["domain"],
      limit: 1,
    },
    signal,
  );
  return res.ok && (res.data?.results?.length ?? 0) > 0;
}

async function resolveRepAccountContact(
  token: string,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ id: string; email: string; reason: string } | null> {
  const salesGroup = payload.sales_group != null ? String(payload.sales_group).trim() : "";
  const name = String(payload.requested_by ?? "").trim();
  if (!salesGroup || !name) return null;

  // 1) rep code -> account number
  const rc = await hs(
    token,
    "POST",
    "/crm/v3/objects/2-41537429/batch/read",
    { idProperty: "rep_code", properties: [REP_CODE_ACCOUNT_PROP], inputs: [{ id: salesGroup }] },
    signal,
  );
  const acct = rc.ok ? String(rc.data?.results?.[0]?.properties?.[REP_CODE_ACCOUNT_PROP] ?? "").trim() : "";
  if (!acct) return null; // unknown property name / no rep account → no-op

  // 2) account number -> rep company
  const repCompanyId = await lookupCompanyId(token, acct, signal);
  if (!repCompanyId) return null;

  // 3) contacts associated to the rep company → name match
  const assoc = await hs(
    token,
    "GET",
    `/crm/v4/objects/companies/${repCompanyId}/associations/contacts?limit=100`,
    undefined,
    signal,
  );
  const ids = (assoc.ok ? assoc.data?.results ?? [] : [])
    .map((r: any) => String(r.toObjectId ?? r.to?.id ?? ""))
    .filter(Boolean);
  const pool = await batchReadContacts(token, ids, signal);
  let m = matchNameInContacts(name, pool);
  if (m) return { id: m.id, email: m.email, reason: "rep-account associated contact" };

  // 4) same-domain fallback (non-generic)
  const co = await hs(token, "GET", `${PATHS.companyLookup}${repCompanyId}?properties=domain`, undefined, signal);
  const domain = co.ok ? String(co.data?.properties?.domain ?? "").toLowerCase().trim() : "";
  if (domain && !GENERIC_DOMAINS.has(domain)) {
    const search = await hs(
      token,
      "POST",
      PATHS.contactSearch,
      {
        filterGroups: [{ filters: [{ propertyName: "email", operator: "CONTAINS_TOKEN", value: domain }] }],
        properties: ["email", "firstname", "lastname"],
        limit: 100,
      },
      signal,
    );
    const domPool: ContactRec[] = (search.ok ? search.data?.results ?? [] : [])
      .map((c: any) => ({
        id: String(c.id),
        email: String(c.properties?.email ?? ""),
        firstName: String(c.properties?.firstname ?? ""),
        lastName: String(c.properties?.lastname ?? ""),
      }))
      .filter((c: ContactRec) => c.email.toLowerCase().endsWith(`@${domain}`));
    m = matchNameInContacts(name, domPool);
    if (m) return { id: m.id, email: m.email, reason: "rep-domain contact" };
  }
  return null;
}

export interface ResolvedPoc {
  email: string | null;
  contactId: string | null;
  reason: string;
}

/**
 * Resolve requested_by to a canonical email + an associable contact. Chain:
 * truncated email → prefix contact; complete email → exact contact OR create;
 * name → HubSpot user → that email → exact contact OR create; name with no user
 * → rep-account contact. Always rewrites requested_by to the resolved email.
 * Never throws (lookup errors → reason); only creates contacts from a COMPLETE email.
 */
async function resolvePointOfContact(
  token: string,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ResolvedPoc> {
  const v = payload.requested_by != null ? String(payload.requested_by).trim() : "";
  if (!v) return { email: null, contactId: null, reason: "empty requested_by" };
  try {
    if (v.includes("@")) {
      // Only a SHORT, well-formed address is a complete email we'll create from;
      // anything at SAP's 20-char cap is truncated → prefix-match, never create.
      if (v.length < SAP_REQUESTED_BY_LEN && isValidEmail(v)) {
        const exact = await getContactByEmailExact(token, v, signal);
        if (exact) return { email: exact.email, contactId: exact.id, reason: "exact email match" };
        const created = await createContact(token, { email: v }, signal);
        return {
          email: v,
          contactId: created,
          reason: created ? "created contact from email" : "valid email, contact create failed",
        };
      }
      // truncated email → prefix match only (can't create from an incomplete address)
      // Truncated/incomplete email. Resolve the rep company domain to (a) break
      // prefix ties (a contact at the rep IS the right one) and (b) reconstruct
      // the full address from the VERIFIED domain when no contact matches.
      const rep = await resolveRepCompany(token, payload.sales_group, signal);
      const repDomain = rep?.domain ?? "";
      const { contact, reason } = await findContactByEmailPrefix(
        token,
        v.toLowerCase(),
        signal,
        repDomain || undefined,
      );
      if (contact) return { email: contact.email, contactId: contact.id, reason };

      // Reconstruct: complete the truncated TLD of the SAME domain (e.g.
      // "dlsgroupoh.c" -> "dlsgroupoh.com") and create ONLY if that full domain
      // is a real HubSpot company domain — never a blind guess.
      const at = v.indexOf("@");
      const local = at > 0 ? v.slice(0, at) : "";
      const tdom = at > 0 ? v.slice(at + 1).toLowerCase() : "";
      const dot = tdom.lastIndexOf(".");
      if (local && dot > 0) {
        const base = tdom.slice(0, dot);
        const frag = tdom.slice(dot + 1);
        const tlds = (TLD_COMPLETIONS[frag[0] ?? ""] ?? []).filter((t) => t.startsWith(frag));
        for (const tld of tlds) {
          const fullDomain = `${base}.${tld}`;
          if (!(await companyDomainExists(token, fullDomain, signal))) continue;
          const full = `${local}@${fullDomain}`;
          const exact = await getContactByEmailExact(token, full, signal);
          if (exact) return { email: exact.email, contactId: exact.id, reason: "reconstructed (verified domain) contact" };
          const created = await createContact(token, { email: full }, signal);
          if (created) return { email: full, contactId: created, reason: "reconstructed (verified domain) created contact" };
        }
      }
      return { email: null, contactId: null, reason };
    }

    // a name → HubSpot user/owner
    const owner = await resolveOwnerByName(token, v, signal);
    if (owner) {
      const exact = await getContactByEmailExact(token, owner.email, signal);
      if (exact) return { email: owner.email, contactId: exact.id, reason: "name → user → contact" };
      const created = await createContact(
        token,
        { email: owner.email, firstName: owner.firstName, lastName: owner.lastName },
        signal,
      );
      return {
        email: owner.email,
        contactId: created,
        reason: created ? "name → user → created contact" : "name → user (contact create failed)",
      };
    }

    // name with no user → rep-account fallback
    const rep = await resolveRepAccountContact(token, payload, signal);
    if (rep) return { email: rep.email, contactId: rep.id, reason: rep.reason };
    // last resort: a UNIQUE HubSpot contact with that exact name → assume it's them
    const uniq = await findUniqueContactByName(token, v, signal);
    if (uniq) return { email: uniq.email, contactId: uniq.id, reason: "unique contact name match" };
    return { email: null, contactId: null, reason: "name: no HubSpot user or rep-account contact" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { email: null, contactId: null, reason: `lookup error: ${msg}` };
  }
}

/* ------------------------------- deal upsert ------------------------------- */

/** Existing-deal properties the stage/close-date/create-date derivations need
 *  (fetched in the same lookup we already do — zero extra API calls). */
const DEAL_STATE_PROPS = [
  "stage_of_project",
  "dealstage",
  "closedate",
  "pipeline",
  "createdate",
  "quote_creation_date",
  "quote_conversion_date",
  "amount",
];

interface ExistingDealHit {
  id: string;
  properties: Record<string, unknown>;
}

async function findDealByQuoteNumber(
  token: string,
  quoteNumber: string,
  signal: AbortSignal,
): Promise<ExistingDealHit | null> {
  const res = await hs(
    token,
    "POST",
    PATHS.dealSearch,
    {
      filterGroups: [
        { filters: [{ propertyName: "sap_quote_number", operator: "EQ", value: quoteNumber }] },
      ],
      limit: 1,
      properties: ["sap_quote_number", ...DEAL_STATE_PROPS],
    },
    signal,
  );
  if (!res.ok) throw new HsError(res);
  const hit = res.data?.results?.[0];
  return hit?.id ? { id: String(hit.id), properties: hit.properties ?? {} } : null;
}

/** Fetch a deal by record id (the opportunity_id path); null when it doesn't exist. */
async function getDealById(
  token: string,
  id: string,
  signal: AbortSignal,
): Promise<ExistingDealHit | null> {
  const res = await hs(
    token,
    "GET",
    `/crm/v3/objects/0-3/${id}?properties=${DEAL_STATE_PROPS.join(",")}`,
    undefined,
    signal,
  );
  if (res.status === 404 || res.data?.category === "OBJECT_NOT_FOUND") return null;
  if (!res.ok) throw new HsError(res);
  return { id: String(res.data?.id ?? id), properties: res.data?.properties ?? {} };
}

function toExistingDealState(p: Record<string, unknown>): ExistingDealState {
  return {
    stageOfProject: p.stage_of_project != null ? String(p.stage_of_project) : null,
    dealstage: p.dealstage != null ? String(p.dealstage) : null,
    closedateMs: toEpochMs(p.closedate),
    pipeline: p.pipeline != null ? String(p.pipeline) : null,
    quoteConversionDateMs: toEpochMs(p.quote_conversion_date),
  };
}

/**
 * Convert SAP date strings (`MM/DD/YYYY` or ISO `YYYY-MM-DD`) to HubSpot's date
 * format (midnight-UTC ms) for the given target properties; drop null/invalid so
 * a bad value is never sent. Empty values are dropped silently (normal SAP
 * blanks / `00/00/0000` sentinels), but a NON-empty value that fails to parse is
 * recorded as a field issue — a silent drop here is how the 2026-06-26 feed
 * format change went unnoticed while every date field quietly stopped syncing.
 * These properties are date-typed with no options, so they must not pass through
 * the enum heal (kept out of the options map).
 */
function coerceDates(
  bag: Record<string, unknown>,
  fields: readonly string[],
  fixActions: (FixAction & { scope?: string })[],
  scope?: string,
): void {
  for (const f of fields) {
    if (bag[f] === undefined) continue;
    const d = toHubspotDate(bag[f]);
    if (d === null) {
      const raw = String(bag[f] ?? "").trim();
      // Null sentinels SAP actually sends: 00/00/0000, 0000-00-00, 00000000, `--`.
      if (raw && !/^0+\/0+\/0+$|^0+-0+-0+$|^0+$|^-+$/.test(raw)) {
        fixActions.push({
          property: f,
          from: raw,
          action: "invalid_date",
          reason: `dropped — unparseable date "${raw}" (expected MM/DD/YYYY or YYYY-MM-DD)`,
          ...(scope ? { scope } : {}),
        });
      }
      delete bag[f];
    } else {
      bag[f] = d;
    }
  }
}

async function upsertDeal(
  env: Env,
  token: string,
  payload: Record<string, unknown>,
  poc: ResolvedPoc,
  signal: AbortSignal,
  fixActions: (FixAction & { scope?: string })[],
  aliasMap: Map<string, string>,
  optionsByProp: Map<string, OptionDef[]>,
  learn: LearnEntry[],
): Promise<{ id: string; quoteNumber: string | null; isNew: boolean; dealname: string | null }> {
  const quoteNumber = payload.quotation_number != null ? String(payload.quotation_number).trim() : "";
  const dealIdRaw = payload.opportunity_id ?? payload.oppourtunity_id ?? null;
  const dealId = dealIdRaw != null ? String(dealIdRaw).trim() : "";
  const hasDealId = /^\d+$/.test(dealId);

  const mapped = mapFields(payload, DEAL_FIELD_MAP);
  if (poc.email) mapped.requested_by = poc.email; // self-heal SAP's truncated/name value
  coerceDates(mapped, DEAL_DATE_FIELDS, fixActions); // SAP date string -> HubSpot date (ms); drop blanks/sentinels
  // Proactive: apply learned aliases + validate/auto-correct dropdowns before pushing.
  const n = normalizeWithLearning("deals", "deal", mapped, optionsByProp, aliasMap);
  for (const a of n.actions) fixActions.push(a);
  for (const e of n.learn) learn.push(e);
  const properties = n.properties;
  const dealname = typeof properties.dealname === "string" ? properties.dealname : null;

  // Resolve the existing deal (and its stage/close-date state) up front —
  // quote number first, then opportunity_id (null when it doesn't exist,
  // replacing the old try/404 dance).
  let existing: ExistingDealHit | null = null;
  if (quoteNumber) existing = await findDealByQuoteNumber(token, quoteNumber, signal);
  if (!existing && hasDealId) existing = await getDealById(token, dealId, signal);

  // Derived dealstage/closedate — absorbs the "Update Deal Stage based on
  // Project Stage changes" (1741406037) and "Set Close Date for Deal based on
  // Line Item Conversion Date" (1765878069) HubSpot workflows; rules live in
  // @wac/shared deriveDealStageAndCloseDate. Merged AFTER normalizeWithLearning
  // so the derived props never pass through the enum heal (dealstage is
  // pipeline-stage typed, closedate is a datetime — same reasoning as coerceDates).
  const derived = deriveDealStageAndCloseDate({
    stageOfProject: payload.stage_of_project != null ? String(payload.stage_of_project) : null,
    existing: existing ? toExistingDealState(existing.properties) : null,
    lineItems: lineItemDates(Array.isArray(payload.products) ? (payload.products as Record<string, unknown>[]) : []),
    quoteLastChangedMs: toHubspotDate(payload.quote_last_changed_date),
    options: { lostCloseDates: env.DEAL_LOST_CLOSEDATE_WRITE === "1", clearCloseDateOnReopen: true },
  });
  if (env.DEAL_STAGE_DERIVE_WRITE === "1") {
    Object.assign(properties, derived.properties);
    for (const a of derived.actions) fixActions.push({ ...a, scope: "deal" });
  } else if (Object.keys(derived.properties).length) {
    // Dark launch: compute + log only, so `wrangler tail` shows what WOULD be
    // written while the HubSpot workflows still own these properties.
    console.log(
      `[dealstage] DEAL_STAGE_DERIVE_WRITE!=1 — would write ${JSON.stringify(derived.properties)} for deal ${existing?.id ?? "(new)"} quote ${quoteNumber || dealId}`,
    );
  }

  // Derived amount — SAP's quote_net_value header tracks the quote's OPEN value
  // (0.00 once fully converted, i.e. exactly when a deal goes Closed Won), so the
  // straight pass-through zeroes/understates converted deals. Recompute from the
  // payload's line items (Σ quantity × unit_price reproduces the header exactly
  // while the quote is untouched); rules live in @wac/shared deriveDealAmount.
  // Same merged-after-normalizeWithLearning placement: amount is number-typed and
  // must never pass through the enum heal.
  const products = Array.isArray(payload.products) ? (payload.products as Record<string, unknown>[]) : [];
  const derivedAmount = deriveDealAmount({
    headerAmount: properties.amount,
    lines: products.map((p) => ({ quantity: p.item_quantity, unitPrice: p.unit_price })),
    existingAmount:
      existing && existing.properties.amount != null && existing.properties.amount !== ""
        ? Number(existing.properties.amount)
        : null,
  });
  if (env.DEAL_AMOUNT_DERIVE_WRITE === "1") {
    if (derivedAmount.dropAmount) delete properties.amount;
    Object.assign(properties, derivedAmount.properties);
    for (const a of derivedAmount.actions) fixActions.push({ ...a, scope: "deal" });
  } else if (derivedAmount.actions.length) {
    console.log(
      `[dealamount] DEAL_AMOUNT_DERIVE_WRITE!=1 — would ${derivedAmount.dropAmount ? "drop amount" : `write ${JSON.stringify(derivedAmount.properties)}`} for deal ${existing?.id ?? "(new)"} quote ${quoteNumber || dealId}`,
    );
  }

  // Derived createdate — backdates HubSpot's system createdate to the earliest
  // SAP signal (quote_creation_date, or the oldest line conversion date when
  // SAP dated the SO before the quote entry) when that's older than the current
  // createdate (bulk-imported deals carry their import date). Same
  // merged-after-normalizeWithLearning placement: createdate is a datetime
  // and must never pass through the enum heal. Diff-only, so no-op pushes never
  // touch it; the payload's quote_creation_date (already midnight-UTC ms via
  // coerceDates) is preferred, falling back to the value stored on the deal.
  const payloadConversions = lineItemDates(products)
    .map((l) => l.conversionMs)
    .concat(existing ? [toEpochMs(existing.properties.quote_conversion_date)] : [])
    .filter((ms): ms is number => ms !== null);
  const createDate = deriveCreateDate({
    quoteCreationMs: toEpochMs(properties.quote_creation_date ?? existing?.properties.quote_creation_date),
    oldestConversionMs: payloadConversions.length ? Math.min(...payloadConversions) : null,
    existingCreateDateMs: existing ? toEpochMs(existing.properties.createdate) : null,
    nowMs: Date.now(),
  });
  if (Object.keys(createDate.properties).length) {
    if (env.DEAL_CREATEDATE_WRITE === "1") {
      Object.assign(properties, createDate.properties);
      for (const a of createDate.actions) fixActions.push({ ...a, scope: "deal" });
    } else {
      console.log(
        `[createdate] DEAL_CREATEDATE_WRITE!=1 — would write ${JSON.stringify(createDate.properties)} for deal ${existing?.id ?? "(new)"} quote ${quoteNumber || dealId}`,
      );
    }
  }

  // Raw SAP header net value — preserved verbatim (zeros included) so the
  // zeroing behavior stays inspectable next to the repaired Amount (Davis
  // 2026-07-13). Merged after normalizeWithLearning like the other derived
  // numbers so it never passes the enum heal.
  const rawHeaderNet = toNumber(payload.quote_net_value);
  if (rawHeaderNet !== undefined) properties["sap_net_value"] = rawHeaderNet;

  // Closed Lost amount reconstruction: SAP zeroes header AND deal amount on
  // rejection — exactly when the lost value matters for reporting. Line unit
  // prices survive, so a lost deal's Amount becomes Σ line (qty × unit price).
  // Lost deals ONLY: for open deals the zeroing header IS the open value, and
  // for won/partially-converted deals the line sum overstates the converted
  // value (and quoting confirmed that zeroing is deliberate — PR #121/#123).
  const effectiveStage = (derived.properties as Record<string, unknown>)["dealstage"] ?? existing?.properties.dealstage ?? null;
  if (String(effectiveStage ?? "") === DEAL_STAGE_IDS.closedLost) {
    const lineNetSum = products.reduce((s, p) => {
      const q = Number(p?.item_quantity);
      const up = Number(p?.unit_price);
      return s + (Number.isFinite(q) && Number.isFinite(up) ? q * up : 0);
    }, 0);
    if (lineNetSum > 0) properties["amount"] = Math.round(lineNetSum * 100) / 100;
  }

  if (existing) {
    const id = existing.id;
    await withHeal(token, signal, "deal", fixActions, properties, (props) =>
      hs(token, "POST", PATHS.dealUpdate, { inputs: [{ id, properties: props }] }, signal),
    );
    return { id, quoteNumber: quoteNumber || null, isNew: false, dealname };
  }

  if (!quoteNumber) throw new Error("Missing quotation_number and no valid opportunity_id provided.");
  const res = await withHeal(token, signal, "deal", fixActions, properties, (props) =>
    hs(token, "POST", PATHS.dealUpsert, {
      inputs: [{ idProperty: "sap_quote_number", id: quoteNumber, properties: props }],
    }, signal),
  );
  const result = res.data?.results?.[0];
  if (!result?.id) throw new Error("HubSpot deal upsert response missing id");
  return { id: String(result.id), quoteNumber, isNew: Boolean(result?.new), dealname };
}

/* ------------------------------- line items -------------------------------- */

async function upsertLineItems(
  token: string,
  products: any[],
  signal: AbortSignal,
  fixActions: (FixAction & { scope?: string })[],
  aliasMap: Map<string, string>,
  optionsByProp: Map<string, OptionDef[]>,
  learn: LearnEntry[],
): Promise<{ id: string }[]> {
  const out: { id: string }[] = [];
  const sorted = [...products].sort((a, b) =>
    String(a?.quote_product_name ?? "").localeCompare(String(b?.quote_product_name ?? ""), undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
  const dedup = new Map<string, any>();
  for (const p of sorted) {
    const key = String(p?.quote_product_name ?? "").trim();
    if (key) dedup.set(key, p);
  }
  const items = [...dedup.values()];
  let position = 1;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const inputs = batch.map((p) => {
      if (!p.quote_product_name || !p.quote_line) {
        throw new Error("Each line item requires quote_product_name and quote_line");
      }
      const mapped = mapFields(p, LINE_ITEM_FIELD_MAP);
      if (mapped.quantity !== undefined) mapped.quantity = toNumber(mapped.quantity);
      if (mapped.unit_price !== undefined) {
        mapped.unit_price = toNumber(mapped.unit_price);
        mapped.price = mapped.unit_price;
      }
      // Extended line net value (unit price × qty). SAP zeroes the HEADER net
      // value on rejection/conversion but line prices survive, so this is the
      // durable record of what each line was worth (Davis 2026-07-13).
      {
        const q = Number(mapped.quantity);
        const up = Number(mapped.unit_price);
        if (Number.isFinite(q) && Number.isFinite(up)) mapped.net_value = Math.round(q * up * 100) / 100;
      }
      if (mapped.commission !== undefined) mapped.commission = toDecimalPercent(mapped.commission);
      if (mapped.hs_discount_percentage !== undefined) {
        mapped.hs_discount_percentage = toDecimalPercent(mapped.hs_discount_percentage);
      }
      coerceDates(mapped, LINE_ITEM_DATE_FIELDS, fixActions, "line_item"); // SAP date string -> HubSpot date (ms)
      if (p.doc__currency) {
        mapped.currency = p.doc__currency;
        mapped.doc__currency = p.doc__currency;
      }
      mapped.name = p.material_description || p.material__ || p.quote_product_name;
      mapped.hs_position_on_quote = position++;
      // Proactive learn/validate for line-item dropdowns.
      const n = normalizeWithLearning("line_items", "line_item", mapped, optionsByProp, aliasMap);
      for (const a of n.actions) fixActions.push(a);
      for (const e of n.learn) learn.push(e);
      return { idProperty: "quote_product_name", id: String(p.quote_product_name).trim(), properties: n.properties };
    });

    const res = await healBatchUpsert(token, signal, inputs, fixActions);
    for (const r of res.data?.results ?? []) out.push({ id: String(r.id) });
    if (i + BATCH_SIZE < items.length) await delay(INTER_BATCH_MS);
  }
  return out;
}

/** Batch upsert line items with a batch-level heal loop (normalize/drop across all inputs). */
async function healBatchUpsert(
  token: string,
  signal: AbortSignal,
  inputs: any[],
  fixActions: (FixAction & { scope?: string })[],
): Promise<HsResponse> {
  let attempt = 0;
  for (;;) {
    const res = await hs(token, "POST", PATHS.lineItemUpsert, { inputs }, signal);
    if (res.ok) return res;
    if (!isValidationError(res.data) || attempt >= MAX_FIX_RETRIES) throw new HsError(res);
    if (
      typeof res.data?.message === "string" &&
      res.data.message.includes("Duplicate IDs found in batch input")
    ) {
      fixActions.push({ scope: "line_item", property: "(batch)", action: "dropped", from: "duplicate ids" });
      throw new HsError(res);
    }
    const items = extractInvalidPropertyItems(res.data);
    if (!items.length) throw new HsError(res);
    let changed = false;
    for (const item of items) {
      const prop = item.name;
      if (!prop) continue;
      for (const input of inputs) {
        const props = input?.properties;
        if (!props || !(prop in props)) continue;
        const raw = String(props[prop] ?? "");
        let action: "normalized" | "dropped" = "dropped";
        if (Array.isArray(item.allowedOptions) && item.allowedOptions.length) {
          const mapped = smartMatchToAllowedOptions(raw, item.allowedOptions);
          if (mapped !== null) {
            props[prop] = mapped;
            action = "normalized";
          } else {
            delete props[prop];
          }
        } else {
          delete props[prop];
        }
        changed = true;
        fixActions.push({ scope: "line_item", property: prop, from: raw, action });
      }
    }
    if (!changed) throw new HsError(res);
    attempt++;
  }
}

/* ------------------------------ associations ------------------------------- */

export async function batchAssociate(
  token: string,
  path: string,
  typeId: number,
  pairs: { fromId: string; toId: string }[],
  signal: AbortSignal,
  category: "HUBSPOT_DEFINED" | "USER_DEFINED" = "HUBSPOT_DEFINED",
): Promise<void> {
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const inputs = pairs.slice(i, i + BATCH_SIZE).map((p) => ({
      types: [{ associationCategory: category, associationTypeId: typeId }],
      from: { id: p.fromId },
      to: { id: p.toId },
    }));
    const res = await hs(token, "POST", path, { inputs }, signal);
    if (!res.ok) throw new HsError(res);
  }
}

export async function lookupCompanyId(
  token: string,
  accountNumber: unknown,
  signal: AbortSignal,
): Promise<string | null> {
  if (!accountNumber) return null;
  const path = `${PATHS.companyLookup}${encodeURIComponent(String(accountNumber))}?idProperty=account_number_`;
  const res = await hs(token, "GET", path, undefined, signal);
  if (res.status === 404 || !res.data?.id) return null;
  if (!res.ok) throw new HsError(res);
  return String(res.data.id);
}

/* -------------------------------- specifiers ------------------------------- */

// Company property holding the Sugar legacy account number (final fallback).
const SPECIFIER_SUGAR_PROP = "sugar_legacy_account_number_uniqueid";

/**
 * Resolve a specifier account-number value to a Company id via the cascade:
 *   1. `account_number_` (across padded/stripped forms),
 *   2. the value as a HubSpot Record ID (`hs_object_id`),
 *   3. the Sugar legacy account number (`sugar_legacy_account_number_uniqueid`).
 * First hit wins; null when nothing matches.
 */
async function resolveSpecifierCompanyId(
  token: string,
  value: string,
  signal: AbortSignal,
): Promise<string | null> {
  // 1. account number (account_number_)
  for (const form of accountForms(value)) {
    const id = await lookupCompanyId(token, form, signal);
    if (id) return id;
  }
  // 2. HubSpot Record ID (numeric only)
  if (/^\d+$/.test(value)) {
    const res = await hs(token, "GET", `${PATHS.companyLookup}${encodeURIComponent(value)}`, undefined, signal);
    if (res.ok && res.data?.id) return String(res.data.id);
  }
  // 3. Sugar legacy account number
  const res = await hs(
    token,
    "POST",
    PATHS.companySearch,
    {
      filterGroups: [{ filters: [{ propertyName: SPECIFIER_SUGAR_PROP, operator: "EQ", value }] }],
      properties: ["hs_object_id"],
      limit: 1,
    },
    signal,
  );
  const hit = res.ok ? res.data?.results?.[0] : null;
  return hit?.id ? String(hit.id) : null;
}

// The companies→deals "Specifier" USER_DEFINED association label typeId, resolved by
// display name. null = the label hasn't been created in HubSpot yet → associating
// no-ops. undefined = not yet resolved this worker lifetime.
let specifierLabelCache: number | null | undefined;
async function getSpecifierLabel(token: string, signal: AbortSignal): Promise<number | null> {
  if (specifierLabelCache !== undefined) return specifierLabelCache;
  const res = await hs(token, "GET", `/crm/v4/associations/companies/0-3/labels`, undefined, signal);
  const match = res.ok
    ? (res.data?.results ?? []).find(
        (l: any) => String(l.label ?? "").trim().toLowerCase() === SPECIFIER_LABEL.toLowerCase(),
      )
    : null;
  specifierLabelCache = match?.typeId != null ? Number(match.typeId) : null;
  return specifierLabelCache;
}

/**
 * Associate each of a deal's specifier companies (`specifier_account_number_1..5`,
 * resolved via {@link resolveSpecifierCompanyId}) to the deal with the "Specifier"
 * label — absorbing the 5 "Associated Specifier N to Opportunity" workflows.
 * Additive + idempotent (re-creating the same labeled association is a HubSpot
 * no-op); stale-specifier removal is left to the daily reconcile. No-op until the
 * label exists in HubSpot. Every failure is non-fatal → assocSkips.
 */
async function associateSpecifiersForDeal(
  token: string,
  dealId: string,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  assocSkips: AssocSkip[],
): Promise<void> {
  const values = specifierAccountNumbers(payload);
  if (!values.length) return;
  const typeId = await getSpecifierLabel(token, signal);
  if (typeId == null) return; // label not set up yet → safe no-op

  const companyIds = new Set<string>();
  for (const value of values) {
    let id: string | null = null;
    try {
      id = await resolveSpecifierCompanyId(token, value, signal);
    } catch (e) {
      assocSkips.push({
        objectType: "companies",
        property: "specifier_account_number",
        rawValue: value,
        reason: `specifier lookup error: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    if (id) companyIds.add(id);
    else
      assocSkips.push({
        objectType: "companies",
        property: "specifier_account_number",
        rawValue: value,
        reason: `no company for specifier ${value}`,
      });
  }
  if (!companyIds.size) return;
  try {
    await batchAssociate(
      token,
      PATHS.companyToDeal,
      typeId,
      [...companyIds].map((fromId) => ({ fromId, toId: dealId })),
      signal,
      "USER_DEFINED",
    );
  } catch (e) {
    assocSkips.push({
      objectType: "companies",
      property: "specifier_account_number",
      rawValue: [...companyIds].join(","),
      reason: `specifier assoc error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/* ----------------------------- national accounts --------------------------- */

// The companies→deals "National Account" USER_DEFINED label typeId, resolved by
// display name (mirrors getSpecifierLabel). null = label not created in HubSpot
// yet → associating no-ops. undefined = not yet resolved this worker lifetime.
const NATIONAL_ACCOUNT_LABEL = "National Account";
let nationalAccountLabelCache: number | null | undefined;
async function getNationalAccountLabel(token: string, signal: AbortSignal): Promise<number | null> {
  if (nationalAccountLabelCache !== undefined) return nationalAccountLabelCache;
  const res = await hs(token, "GET", `/crm/v4/associations/companies/0-3/labels`, undefined, signal);
  const match = res.ok
    ? (res.data?.results ?? []).find(
        (l: any) => String(l.label ?? "").trim().toLowerCase() === NATIONAL_ACCOUNT_LABEL.toLowerCase(),
      )
    : null;
  nationalAccountLabelCache = match?.typeId != null ? Number(match.typeId) : null;
  return nationalAccountLabelCache;
}

// Compiled wildcard → companyId matchers from the "Annuity Pipeline" sheet,
// TTL-cached per worker (the sheet changes rarely; the daily reconcile is the
// safety net). Fail-soft: any download/parse error keeps the last good map.
interface AnnuityMatcher {
  companyId: string;
  regexes: RegExp[];
}
let annuityMatcherCache: { matchers: AnnuityMatcher[]; at: number } | null = null;
const ANNUITY_MATCHER_TTL_MS = 6 * 60 * 60 * 1000; // 6h

async function loadAnnuityMatchers(env: Env): Promise<AnnuityMatcher[]> {
  if (annuityMatcherCache && Date.now() - annuityMatcherCache.at < ANNUITY_MATCHER_TTL_MS) {
    return annuityMatcherCache.matchers;
  }
  if (!env.ANNUITY_SHEET_URL || !graphConfigured(env)) return annuityMatcherCache?.matchers ?? [];
  try {
    const gtoken = await getGraphToken(env);
    const item = await getSharedItem(gtoken, env.ANNUITY_SHEET_URL);
    const buf = await downloadDriveItem(gtoken, env.ANNUITY_SHEET_URL, item);
    const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
    const sheet = wb.Sheets["Annuities and Associations"] ?? wb.Sheets[wb.SheetNames[0]!];
    const grid = sheet ? XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false }) : [];
    const { accounts } = parseAnnuityGrid(grid);
    const matchers = accounts
      .filter((a) => a.wildcards.length > 0)
      .map((a) => ({ companyId: a.companyId, regexes: a.wildcards.map(wildcardToRegExp) }));
    annuityMatcherCache = { matchers, at: Date.now() };
    return matchers;
  } catch (e) {
    console.error(`[national-account] annuity matcher load failed: ${e instanceof Error ? e.message : String(e)}`);
    return annuityMatcherCache?.matchers ?? [];
  }
}

/**
 * Tag the matching national-account company(ies) onto a deal with the "National
 * Account" label when the deal name matches that account's SAP wildcards from the
 * Annuity Pipeline sheet — the real-time half of the labeling (the daily
 * annuity-sync `--task=associate` run reconciles/backfills the rest). Additive +
 * idempotent (re-creating the same labeled association is a HubSpot no-op); no-op
 * until the label exists. Every failure is non-fatal → assocSkips.
 */
async function associateNationalAccountForDeal(
  env: Env,
  token: string,
  dealId: string,
  dealname: string | null,
  signal: AbortSignal,
  assocSkips: AssocSkip[],
): Promise<void> {
  if (!dealname || !env.ANNUITY_SHEET_URL) return;
  const typeId = await getNationalAccountLabel(token, signal);
  if (typeId == null) return; // label not set up yet → safe no-op
  const matchers = await loadAnnuityMatchers(env);
  if (!matchers.length) return;
  const lower = dealname.toLowerCase();
  const companyIds = matchers.filter((m) => m.regexes.some((re) => re.test(lower))).map((m) => m.companyId);
  if (!companyIds.length) return;
  try {
    await batchAssociate(
      token,
      PATHS.companyToDeal,
      typeId,
      companyIds.map((fromId) => ({ fromId, toId: dealId })),
      signal,
      "USER_DEFINED",
    );
  } catch (e) {
    assocSkips.push({
      objectType: "companies",
      property: "national_account_wildcard",
      rawValue: dealname,
      reason: `national account assoc error: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/* -------------------------------- entry points ----------------------------- */

/** Push a Deals/Quotes payload: deal + line items + associations + requested_by heal. */
export async function pushDeal(
  env: Env,
  sb: SupabaseClient,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<PushOutcome> {
  const token = env.HUBSPOT_TOKEN;
  const fixActions: (FixAction & { scope?: string })[] = [];
  const assocSkips: AssocSkip[] = [];
  if (!token) {
    return { result: null, error: "HUBSPOT_TOKEN not configured", status: 500, fixActions, assocSkips };
  }

  const learn: LearnEntry[] = [];
  const [dealAliases, dealOptions, liAliases, liOptions] = await Promise.all([
    loadAliases(sb, "deals"),
    loadOptions(sb, "deals"),
    loadAliases(sb, "line_items"),
    loadOptions(sb, "line_items"),
  ]);

  try {
    const poc = await resolvePointOfContact(token, payload, signal);
    const deal = await upsertDeal(env, token, payload, poc, signal, fixActions, dealAliases, dealOptions, learn);

    const products = Array.isArray(payload.products) ? payload.products : [];
    const lineItems = products.length
      ? await upsertLineItems(token, products, signal, fixActions, liAliases, liOptions, learn)
      : [];

    if (lineItems.length) {
      await batchAssociate(
        token,
        PATHS.lineItemToDeal,
        ASSOC.lineItemToDeal,
        lineItems.map((li) => ({ fromId: li.id, toId: deal.id })),
        signal,
      );
    }

    try {
      const companyId = await lookupCompanyId(token, payload.account_number, signal);
      if (companyId) {
        await batchAssociate(token, PATHS.companyToDeal, ASSOC.companyToDeal, [{ fromId: companyId, toId: deal.id }], signal);
      } else {
        assocSkips.push({
          objectType: "companies",
          property: "account_number",
          rawValue: payload.account_number != null ? String(payload.account_number) : null,
          reason: `no company for account_number ${payload.account_number}`,
        });
      }
    } catch (e) {
      assocSkips.push({
        objectType: "companies",
        property: "account_number",
        rawValue: payload.account_number != null ? String(payload.account_number) : null,
        reason: `company assoc error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    if (poc.contactId) {
      try {
        await batchAssociate(token, PATHS.contactToDeal, ASSOC.contactToDeal, [{ fromId: poc.contactId, toId: deal.id }], signal);
      } catch (e) {
        assocSkips.push({
          objectType: "contacts",
          property: "requested_by",
          rawValue: payload.requested_by != null ? String(payload.requested_by) : null,
          reason: `contact assoc error: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } else {
      assocSkips.push({
        objectType: "contacts",
        property: "requested_by",
        rawValue: payload.requested_by != null ? String(payload.requested_by) : null,
        reason: poc.reason,
      });
    }

    // Specifier companies → deal, with the "Specifier" label (absorbs the 5
    // "Associated Specifier N to Opportunity" workflows). Non-fatal → assocSkips.
    await associateSpecifiersForDeal(token, deal.id, payload, signal, assocSkips);

    // National-account company → deal, with the "National Account" label, when the
    // deal name matches the account's wildcards (real-time; daily reconcile backfills).
    await associateNationalAccountForDeal(env, token, deal.id, deal.dealname, signal, assocSkips);

    // The quote's rep code (sales_group) — auto-create the Rep Code record +
    // association + review task when SAP references a code HubSpot lacks.
    await ensureServicingRepCodes({
      env,
      sb,
      token,
      rawValue: payload.sales_group,
      property: "sales_group",
      source: {
        type: "deal",
        objectType: "deals",
        id: deal.id,
        label: deal.quoteNumber ?? deal.dealname ?? deal.id,
      },
      fixActions,
      assocSkips,
      signal,
    });

    return {
      result: {
        hs_record_id: deal.id,
        sap_quote_number: deal.quoteNumber,
        new: deal.isNew,
        requested_by: poc.email ?? payload.requested_by ?? null,
        line_items: lineItems.length,
      },
      error: null,
      status: 200,
      fixActions,
      assocSkips,
    };
  } catch (err) {
    return {
      result: null,
      error: err instanceof Error ? err.message : String(err),
      status: err instanceof HsError ? err.status : 500,
      fixActions,
      assocSkips,
    };
  } finally {
    await persistAliases(sb, learn);
  }
}

/* --------------------------- inside-sales (ISR) ---------------------------- */

export const REP_OBJECT = "2-41537429";
let repResolverCache: { maps: InsideSalesResolvers; at: number } | null = null;
const REP_RESOLVER_TTL_MS = 10 * 60 * 1000;

/**
 * Build the AMT->owner and rep_code->owner maps from the synced `rep_codes` table
 * (the parsed "Rep Code RSM ISR Mapping" sheet). ISR names resolve to HubSpot
 * owner ids via the cached owner maps. amt->isr conflicts resolve to the majority.
 * TTL-cached (the sheet changes ~every 6h). Fail-soft: returns empty maps on error.
 */
async function loadRepResolvers(
  sb: SupabaseClient,
  token: string,
  signal: AbortSignal,
): Promise<InsideSalesResolvers> {
  if (repResolverCache && Date.now() - repResolverCache.at < REP_RESOLVER_TTL_MS) {
    return repResolverCache.maps;
  }
  const amtToOwner = new Map<string, string>();
  const repCodeToOwner = new Map<string, string>();
  const { data, error } = await sb.from("rep_codes").select("rep_code, amt_rep_code, isr");
  if (error) {
    console.error(`[inside-sales] loadRepResolvers failed: ${error.message}`);
    return { amtToOwner, repCodeToOwner };
  }
  const rows = (data ?? []) as { rep_code: string | null; amt_rep_code: string | null; isr: string | null }[];

  // resolve each distinct ISR name to an owner id once
  const ownerIdByName = new Map<string, string | null>();
  const ownerFor = async (name: string): Promise<string | null> => {
    const key = name.trim().toLowerCase();
    if (ownerIdByName.has(key)) return ownerIdByName.get(key)!;
    const o = await resolveOwnerByName(token, name, signal);
    ownerIdByName.set(key, o?.id ?? null);
    return o?.id ?? null;
  };

  const amtIsrCounts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const isr = r.isr != null ? String(r.isr).trim() : "";
    if (!isr) continue;
    const amt = r.amt_rep_code != null ? String(r.amt_rep_code).trim() : "";
    if (amt) {
      const counts = amtIsrCounts.get(amt) ?? new Map<string, number>();
      counts.set(isr, (counts.get(isr) ?? 0) + 1);
      amtIsrCounts.set(amt, counts);
    }
    const rc = r.rep_code != null ? String(r.rep_code).trim().toUpperCase() : "";
    if (rc) {
      const id = await ownerFor(isr);
      if (id) repCodeToOwner.set(rc, id);
    }
  }
  for (const [amt, counts] of amtIsrCounts) {
    let best = "";
    let bestN = -1;
    for (const [isr, n] of counts) {
      if (n > bestN) {
        best = isr;
        bestN = n;
      }
    }
    if (counts.size > 1) {
      console.warn(`[inside-sales] AMT ${amt} maps to ${counts.size} ISRs; using majority "${best}"`);
    }
    const id = await ownerFor(best);
    if (id) amtToOwner.set(amt, id);
  }

  // Overlay the COMPLETE AMT→ISR roster (amt_isr_map, from the "AMT ISR Mapping"
  // tab) — the primary source: it covers AMT codes with no field rep code (e.g.
  // 441 = Christina Yin). Wins over the rep-sheet majority where both exist.
  {
    const { data: amtData, error: amtErr } = await sb
      .from("amt_isr_map")
      .select("amt_rep_code, inside_sales_person");
    if (amtErr) {
      console.error(`[inside-sales] amt_isr_map load failed: ${amtErr.message}`);
    }
    for (const r of (amtData ?? []) as { amt_rep_code: string | null; inside_sales_person: string | null }[]) {
      const amt = r.amt_rep_code != null ? String(r.amt_rep_code).trim() : "";
      const person = r.inside_sales_person != null ? String(r.inside_sales_person).trim() : "";
      if (!amt || !person) continue;
      const id = await ownerFor(person);
      if (id) amtToOwner.set(amt, id);
    }
  }

  // Augment rep_code -> owner from the Rep Code OBJECTS' current owners. Picks up
  // rep codes missing from the sheet whose owner was derived from the agency
  // company's AMT (set by territory-sync's reconcile / the account-join below), so
  // no-AMT accounts serviced by those rep codes still resolve. Sheet wins (fill
  // only). ~6 paginated reads, cached with the rest.
  let objAfter: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await hs(
      token,
      "GET",
      `/crm/v3/objects/${REP_OBJECT}?limit=100&properties=rep_code,hubspot_owner_id${objAfter ? `&after=${objAfter}` : ""}`,
      undefined,
      signal,
    );
    if (!res.ok) break;
    for (const r of res.data?.results ?? []) {
      const rc = String(r.properties?.rep_code ?? "").trim().toUpperCase();
      const oid = String(r.properties?.hubspot_owner_id ?? "");
      if (rc && oid && !repCodeToOwner.has(rc)) repCodeToOwner.set(rc, oid);
    }
    objAfter = res.data?.paging?.next?.after;
    if (!objAfter) break;
  }

  repResolverCache = { maps: { amtToOwner, repCodeToOwner }, at: Date.now() };
  return repResolverCache.maps;
}

/**
 * Rep Code object(s) whose `account` matches a company's account number — i.e. the
 * company IS a rep. Returns id + current owner so the caller can skip no-op writes.
 * Empty result = not a rep = no rep-code owner update (the gate).
 */
async function findRepCodesByAccount(
  token: string,
  accountNumber: string,
  signal: AbortSignal,
  extraProps: string[] = [],
): Promise<{ id: string; ownerId: string; repCode: string; properties: Record<string, string> }[]> {
  const forms = accountForms(accountNumber);
  if (!forms.length) return [];
  const properties = [...new Set([REP_CODE_ACCOUNT_PROP, "hubspot_owner_id", "rep_code", ...extraProps])];
  const res = await hs(
    token,
    "POST",
    `/crm/v3/objects/${REP_OBJECT}/search`,
    {
      filterGroups: [{ filters: [{ propertyName: REP_CODE_ACCOUNT_PROP, operator: "IN", values: forms }] }],
      properties,
      limit: 50,
    },
    signal,
  );
  if (!res.ok) return [];
  return (res.data?.results ?? []).map((r: any) => ({
    id: String(r.id),
    ownerId: String(r.properties?.hubspot_owner_id ?? ""),
    repCode: String(r.properties?.rep_code ?? "").trim(),
    properties: (r.properties ?? {}) as Record<string, string>,
  }));
}

/**
 * Re-own a rep code's ACTIVE deals to a new owner. Deals link to a rep code via
 * their `sales_group` property (= the deal's Current-labeled rep code); we filter
 * to open deals with HubSpot's calculated `hs_is_closed` so closed-won/closed-lost
 * are never touched. Diff-only: a deal already on `ownerId` is skipped. Returns the
 * number updated plus any failures (surfaced as assocSkips by the caller). Used by
 * the real-time path when a Rep Code owner actually changed.
 */
async function reownActiveDealsForRepCode(
  token: string,
  repCode: string,
  ownerId: string,
  signal: AbortSignal,
): Promise<{ updated: number; failures: string[] }> {
  const failures: string[] = [];
  const code = repCode.trim();
  if (!code || !ownerId) return { updated: 0, failures };

  // Collect active deals (sales_group = repCode AND not closed) whose owner differs.
  const toUpdate: string[] = [];
  let after: string | undefined;
  do {
    const res = await hs(
      token,
      "POST",
      PATHS.dealSearch,
      {
        filterGroups: [
          {
            filters: [
              { propertyName: "sales_group", operator: "EQ", value: code },
              { propertyName: "hs_is_closed", operator: "EQ", value: "false" },
              // Territory ownership applies once SAP knows the deal — every
              // SAP-pushed deal carries a quote number (it's the upsert key).
              // Quote-less deals (Material Bank, showroom POs) are owner-
              // routed by their own rules and must not be swept, even though
              // a HubSpot workflow stamps sales_group on them at creation.
              { propertyName: "sap_quote_number", operator: "HAS_PROPERTY" },
            ],
          },
        ],
        properties: ["hubspot_owner_id"],
        limit: 100,
        after,
      },
      signal,
    );
    if (!res.ok) {
      failures.push(`deal search for sales_group ${code} failed (${res.status})`);
      break;
    }
    for (const d of res.data?.results ?? []) {
      if (String(d.properties?.hubspot_owner_id ?? "") !== ownerId) toUpdate.push(String(d.id));
    }
    after = res.data?.paging?.next?.after;
  } while (after);

  // Batch-update the deal owner in chunks; idempotent — only diffs were collected.
  let updated = 0;
  for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
    const slice = toUpdate.slice(i, i + BATCH_SIZE);
    const inputs = slice.map((id) => ({ id, properties: { hubspot_owner_id: ownerId } }));
    const res = await hs(token, "POST", PATHS.dealUpdate, { inputs }, signal);
    if (!res.ok) {
      failures.push(`deal owner batch/update for sales_group ${code} failed (${res.status})`);
      continue;
    }
    updated += slice.length;
  }
  return { updated, failures };
}

// --- Rep Code object sync (absorbs the "Account # to Rep Code Syncing" workflow) ---
// The Rep Code object's property internal names + status option values aren't known
// statically, so resolve them from the live schema once per worker.
let repCodeSchemaCache: RepCodeSchema | null = null;
async function getRepCodeSchema(token: string, signal: AbortSignal): Promise<RepCodeSchema | null> {
  if (repCodeSchemaCache) return repCodeSchemaCache;
  const res = await hs(token, "GET", `/crm/v3/properties/${REP_OBJECT}`, undefined, signal);
  if (!res.ok || !Array.isArray(res.data?.results)) return null;
  repCodeSchemaCache = resolveRepCodeSchema(res.data.results);
  return repCodeSchemaCache;
}

// The directional "Inactive" association label, resolved by display label. `create`
// is the {target}→repcode typeId used by batch create/labels-archive; `inverse` is
// the repcode→{target} typeId seen when reading associations from the rep side (used
// to diff). null = the label hasn't been created in HubSpot yet → labeling no-ops.
interface InactiveLabel {
  create: number;
  inverse: number | null;
}
const inactiveLabelCache = new Map<string, InactiveLabel | null>();
async function getInactiveLabel(
  token: string,
  target: "deals" | "companies",
  signal: AbortSignal,
): Promise<InactiveLabel | null> {
  if (inactiveLabelCache.has(target)) return inactiveLabelCache.get(target)!;
  let result: InactiveLabel | null = null;
  const fwd = await hs(token, "GET", `/crm/v4/associations/${target}/${REP_OBJECT}/labels`, undefined, signal);
  const fwdLabel = fwd.ok
    ? (fwd.data?.results ?? []).find((l: any) => String(l.label ?? "").trim().toLowerCase() === "inactive")
    : null;
  if (fwdLabel?.typeId != null) {
    const inv = await hs(token, "GET", `/crm/v4/associations/${REP_OBJECT}/${target}/labels`, undefined, signal);
    // Pair the inverse typeId (the repcode→target "Inactive Rep Code" label) by its
    // label text — names come back null from this endpoint. Falls back to idempotent
    // add-all/remove-all if the inverse can't be paired.
    const invLabel = inv.ok
      ? (inv.data?.results ?? []).find((l: any) => String(l.label ?? "").trim().toLowerCase().includes("inactive"))
      : null;
    result = { create: Number(fwdLabel.typeId), inverse: invLabel?.typeId != null ? Number(invLabel.typeId) : null };
  }
  inactiveLabelCache.set(target, result);
  return result;
}

/** Read a rep code's associated deal/company ids + the association typeIds present
 * (repcode→target direction), paginated. */
async function readRepAssociations(
  token: string,
  repId: string,
  target: "deals" | "companies",
  signal: AbortSignal,
): Promise<{ toId: string; typeIds: number[] }[]> {
  const out: { toId: string; typeIds: number[] }[] = [];
  let after: string | undefined;
  do {
    const qs = `?limit=500${after ? `&after=${after}` : ""}`;
    const res = await hs(token, "GET", `/crm/v4/objects/${REP_OBJECT}/${repId}/associations/${target}${qs}`, undefined, signal);
    if (!res.ok) break;
    for (const r of res.data?.results ?? []) {
      const toId = String(r.toObjectId ?? r.to?.id ?? "");
      const typeIds = (r.associationTypes ?? [])
        .map((t: any) => Number(t.typeId))
        .filter((n: number) => !Number.isNaN(n));
      if (toId) out.push({ toId, typeIds });
    }
    after = res.data?.paging?.next?.after;
  } while (after);
  return out;
}

/**
 * Make the "Inactive" directional label on a rep code's deal/company associations
 * match its (in)active state. Diff-only when the inverse typeId is known; falls back
 * to idempotent add-all / remove-all otherwise. Additive create + label-only archive
 * preserve other labels (e.g. "Current"). No-op (with no error) until the label is
 * created in HubSpot. Returns failure reasons (surfaced as assocSkips).
 */
async function syncInactiveLabel(
  token: string,
  repId: string,
  target: "deals" | "companies",
  inactive: boolean,
  signal: AbortSignal,
): Promise<string[]> {
  const failures: string[] = [];
  const label = await getInactiveLabel(token, target, signal);
  if (!label) return failures; // label not set up in HubSpot yet → safe no-op
  const assocs = await readRepAssociations(token, repId, target, signal);
  if (!assocs.length) return failures;

  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const a of assocs) {
    const known = label.inverse != null;
    const has = known && a.typeIds.includes(label.inverse as number);
    if (inactive) {
      if (!known || !has) toAdd.push(a.toId);
    } else if (!known || has) {
      toRemove.push(a.toId);
    }
  }

  const apply = async (op: "create" | "labels/archive", ids: string[]): Promise<void> => {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const inputs = ids.slice(i, i + BATCH_SIZE).map((toId) => ({
        from: { id: toId },
        to: { id: repId },
        types: [{ associationCategory: "USER_DEFINED", associationTypeId: label.create }],
      }));
      const res = await hs(token, "POST", `/crm/v4/associations/${target}/${REP_OBJECT}/batch/${op}`, { inputs }, signal);
      if (!res.ok) failures.push(`${target} inactive-label ${op} for rep ${repId} failed (${res.status})`);
    }
  };
  await apply("create", toAdd);
  await apply("labels/archive", toRemove);
  return failures;
}

/**
 * For a pushed company, sync its matching Rep Code object(s) — absorbing the
 * "Account # to Rep Code Syncing" workflow (Owner/Agency/City/Brands/Status/State,
 * diff-only) and applying/removing the directional "Inactive" label on each rep
 * code's Deal/Company associations from the company's Status. Empty rep-code match
 * (a regular customer company) = no-op. All writes are non-fatal → assocSkips.
 */
async function syncRepCodesForCompany(opts: {
  token: string;
  accountNumber: string;
  companyFields: { companyName?: unknown; city?: unknown; productBrand?: unknown; stateAbbr?: unknown };
  companyStatus: "true" | "false" | null;
  isrOwner: string;
  signal: AbortSignal;
}): Promise<AssocSkip[]> {
  const { token, accountNumber, companyFields, companyStatus, isrOwner, signal } = opts;
  const skips: AssocSkip[] = [];

  const schema = await getRepCodeSchema(token, signal);
  const extra = schema
    ? [schema.agency, schema.city, schema.brands, schema.state, schema.status].filter((x): x is string => !!x)
    : [];

  let reps: Awaited<ReturnType<typeof findRepCodesByAccount>>;
  try {
    reps = await findRepCodesByAccount(token, accountNumber, signal, extra);
  } catch (e) {
    skips.push({
      objectType: REP_OBJECT,
      property: "rep_code_sync",
      rawValue: accountNumber,
      reason: `rep-code lookup error: ${e instanceof Error ? e.message : String(e)}`,
    });
    return skips;
  }
  if (!reps.length) return skips;

  const inactive = repCodeInactiveFromCompanyStatus(companyStatus);

  for (const rep of reps) {
    // Field sync (workflow B): owner + agency/city/brands/state/status, diff-only.
    const desired: Record<string, string> = {};
    if (isrOwner) desired.hubspot_owner_id = isrOwner;
    if (schema) Object.assign(desired, repCodeSyncProperties({ ...companyFields, companyStatus }, schema));
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(desired)) {
      if (String(rep.properties[k] ?? "") !== v) patch[k] = v;
    }
    if (Object.keys(patch).length) {
      const pr = await hs(token, "PATCH", `/crm/v3/objects/${REP_OBJECT}/${rep.id}`, { properties: patch }, signal);
      if (!pr.ok) {
        skips.push({
          objectType: REP_OBJECT,
          property: Object.keys(patch).join(","),
          rawValue: null,
          reason: `rep code ${rep.id} field sync failed (${pr.status})`,
        });
      } else if ("hubspot_owner_id" in patch && isrOwner) {
        // Owner changed → cascade to its ACTIVE deals (territory-sync is the backfill).
        const { failures } = await reownActiveDealsForRepCode(token, rep.repCode, isrOwner, signal);
        for (const reason of failures) {
          skips.push({ objectType: "deals", property: "hubspot_owner_id", rawValue: isrOwner, reason });
        }
      }
    }

    // Inactive label (the original ask) — only when we know the status this push.
    if (inactive !== null) {
      for (const target of ["deals", "companies"] as const) {
        for (const reason of await syncInactiveLabel(token, rep.id, target, inactive, signal)) {
          skips.push({ objectType: target, property: "association_label", rawValue: "Inactive", reason });
        }
      }
    }
  }
  return skips;
}

// --- Missing Rep Code auto-create (servicing rep code from the SAP payload) ---
// Distinct from syncRepCodesForCompany above: that path matches companies that ARE
// rep agencies (Rep Code `account` = company account number). This one handles the
// SERVICING rep code every customer account/quote carries (company `sales_rep_code`,
// deal `sales_group`). When that code has no Rep Code record, the HubSpot workflows
// keyed on the property miss their trigger and the record ends up unassociated — so
// the Worker creates the record, links it, and opens a review task.

/** Fallback recipient of the review task when REP_CODE_ALERT_OWNER_EMAIL is unset. */
const REP_CODE_ALERT_OWNER_DEFAULT = "davis.rothenberg@waclighting.com";

/** rep_code (UPPERCASE) -> record id, per-isolate — skips re-reads for codes already seen. */
const ensuredRepCodeIds = new Map<string, string>();

/**
 * Ensure a Rep Code record exists for `code`. Read-by-code first; on miss, batch
 * UPSERT by `rep_code` — race-safe under queue concurrency: two racing upserts both
 * succeed and exactly one response carries `new: true`, so only the winner triggers
 * the association/task follow-ups. Returns null on HubSpot failure.
 */
async function ensureRepCodeRecord(
  token: string,
  code: string,
  ownerId: string | undefined,
  signal: AbortSignal,
): Promise<{ id: string; created: boolean } | null> {
  const cached = ensuredRepCodeIds.get(code);
  if (cached) return { id: cached, created: false };

  const read = await hs(
    token,
    "POST",
    `/crm/v3/objects/${REP_OBJECT}/batch/read`,
    { idProperty: "rep_code", properties: ["rep_code"], inputs: [{ id: code }] },
    signal,
  );
  const existing = read.ok ? read.data?.results?.[0] : null;
  if (existing?.id) {
    ensuredRepCodeIds.set(code, String(existing.id));
    return { id: String(existing.id), created: false };
  }

  const up = await hs(
    token,
    "POST",
    `/crm/v3/objects/${REP_OBJECT}/batch/upsert`,
    { inputs: [{ idProperty: "rep_code", id: code, properties: buildRepCodeCreateProperties(code, ownerId) }] },
    signal,
  );
  const result = up.ok ? up.data?.results?.[0] : null;
  if (!result?.id) return null;
  ensuredRepCodeIds.set(code, String(result.id));
  return { id: String(result.id), created: Boolean(result?.new) };
}

/** The association types to link a deal/company to a Rep Code: the unlabeled base
 * pair PLUS, for deals, the "Current" label (the portal labels rep-code associations
 * Current/Previous/Inactive). Both must be sent together — creating with ONLY the
 * labeled type returns 201 but attaches nothing (verified live 2026-07-02 in the
 * showroom-orders sync). null = none resolvable → default-association PUT fallback. */
interface RepLinkType {
  typeId: number;
  category: "HUBSPOT_DEFINED" | "USER_DEFINED";
}
const repLinkTypesCache = new Map<string, RepLinkType[] | null>();
async function getRepCodeLinkTypes(
  token: string,
  from: "deals" | "companies",
  signal: AbortSignal,
): Promise<RepLinkType[] | null> {
  if (repLinkTypesCache.has(from)) return repLinkTypesCache.get(from)!;
  const res = await hs(token, "GET", `/crm/v4/associations/${from}/${REP_OBJECT}/labels`, undefined, signal);
  const rows: any[] = res.ok ? res.data?.results ?? [] : [];
  const ref = (t: any): RepLinkType => ({
    typeId: Number(t.typeId),
    category: t.category === "HUBSPOT_DEFINED" ? "HUBSPOT_DEFINED" : "USER_DEFINED",
  });
  const unlabeled = rows.find((l) => l.typeId != null && l.label == null);
  const current =
    from === "deals"
      ? rows.find((l) => l.typeId != null && String(l.label ?? "").trim().toLowerCase() === "current")
      : undefined;
  const picked = [unlabeled, current].filter((t) => t != null).map(ref);
  const result = picked.length ? picked : null;
  repLinkTypesCache.set(from, result);
  return result;
}

/** Associate a deal/company to a Rep Code record. Returns a failure reason or null. */
async function associateRepCode(
  token: string,
  from: "deals" | "companies",
  fromId: string,
  repId: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const types = await getRepCodeLinkTypes(token, from, signal);
    if (types) {
      const res = await hs(
        token,
        "POST",
        `/crm/v4/associations/${from}/${REP_OBJECT}/batch/create`,
        {
          inputs: [
            {
              types: types.map((t) => ({ associationCategory: t.category, associationTypeId: t.typeId })),
              from: { id: fromId },
              to: { id: repId },
            },
          ],
        },
        signal,
      );
      // A 201 with an empty results array is a silent no-op (seen live) — treat as failure.
      const created = ((res.ok ? res.data?.results : null) ?? []).length;
      return res.ok && created > 0
        ? null
        : `rep-code association ${from} ${fromId} -> ${repId} attached nothing (status ${res.status})`;
    }
    const res = await hs(
      token,
      "PUT",
      `/crm/v4/objects/${from}/${fromId}/associations/default/${REP_OBJECT}/${repId}`,
      undefined,
      signal,
    );
    return res.ok ? null : `rep-code association ${from} ${fromId} -> ${repId} failed (${res.status})`;
  } catch (e) {
    return `rep-code association ${from} ${fromId} -> ${repId} failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Owner id for the review task, from REP_CODE_ALERT_OWNER_EMAIL (TTL-cached). */
const ALERT_OWNER_TTL_MS = 10 * 60 * 1000;
let alertOwnerCache: { id: string | null; at: number } | null = null;
async function getRepCodeAlertOwnerId(env: Env, token: string, signal: AbortSignal): Promise<string | null> {
  if (alertOwnerCache && Date.now() - alertOwnerCache.at < ALERT_OWNER_TTL_MS) return alertOwnerCache.id;
  const email = (env.REP_CODE_ALERT_OWNER_EMAIL || REP_CODE_ALERT_OWNER_DEFAULT).trim();
  const res = await hs(token, "GET", `${PATHS.owners}/?email=${encodeURIComponent(email)}&limit=1`, undefined, signal);
  const oid = res.ok ? res.data?.results?.[0]?.id : null;
  const id = oid != null ? String(oid) : null;
  alertOwnerCache = { id, at: Date.now() };
  return id;
}

/** Open the review TASK for an auto-created Rep Code, associated to the new record
 * and the triggering company/deal. Unresolvable owner → task created unassigned.
 * Returns failure reasons (surfaced as assocSkips). */
async function createRepCodeAlertTask(opts: {
  env: Env;
  token: string;
  repId: string;
  code: string;
  source: { type: "company" | "deal"; objectType: "companies" | "deals"; id: string; label: string };
  ownerSet: boolean;
  signal: AbortSignal;
}): Promise<string[]> {
  const { env, token, repId, code, source, ownerSet, signal } = opts;
  const failures: string[] = [];
  const { subject, body } = buildRepCodeTaskContent({
    repCode: code,
    sourceType: source.type,
    sourceLabel: source.label,
    ownerSet,
  });
  const ownerId = await getRepCodeAlertOwnerId(env, token, signal);
  const res = await hs(
    token,
    "POST",
    "/crm/v3/objects/tasks",
    {
      properties: {
        hs_task_subject: subject,
        hs_task_body: body,
        hs_timestamp: String(Date.now()),
        hs_task_status: "NOT_STARTED",
        hs_task_type: "TODO",
        ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
      },
    },
    signal,
  );
  const taskId = res.ok && res.data?.id != null ? String(res.data.id) : "";
  if (!taskId) {
    failures.push(`review task for auto-created rep code "${code}" failed (${res.status})`);
    return failures;
  }
  for (const target of [
    { type: REP_OBJECT, id: repId },
    { type: source.objectType as string, id: source.id },
  ]) {
    const ar = await hs(
      token,
      "PUT",
      `/crm/v4/objects/tasks/${taskId}/associations/default/${target.type}/${target.id}`,
      undefined,
      signal,
    );
    if (!ar.ok) failures.push(`task ${taskId} -> ${target.type} ${target.id} association failed (${ar.status})`);
  }
  return failures;
}

/**
 * For each rep code on the pushed payload with NO Rep Code record in HubSpot:
 * create the record (owner: the company's AMT-resolved ISR, or for deals the
 * territory sheet's rep_code -> ISR map), associate the triggering company/deal,
 * open the review task, and log an `auto_created` fixAction for the dashboard.
 * Codes that already exist are untouched (association stays the workflows' job).
 * Fully fail-soft: every failure lands in assocSkips, never in the push outcome.
 */
async function ensureServicingRepCodes(opts: {
  env: Env;
  sb: SupabaseClient;
  token: string;
  rawValue: unknown;
  property: "sales_rep_code" | "sales_group";
  source: { type: "company" | "deal"; objectType: "companies" | "deals"; id: string; label: string };
  companyIsrOwner?: string;
  fixActions: (FixAction & { scope?: string })[];
  assocSkips: AssocSkip[];
  signal: AbortSignal;
}): Promise<void> {
  const { env, sb, token, rawValue, property, source, companyIsrOwner, fixActions, assocSkips, signal } = opts;
  const raw = rawValue == null ? "" : String(rawValue).trim();
  if (!raw) return;

  for (const part of parseRepCodes(raw)) {
    try {
      const code = normalizeRepCodeForCreate(part);
      if (!code) {
        assocSkips.push({
          objectType: REP_OBJECT,
          property,
          rawValue: part,
          reason: `rep code auto-create skipped — "${part}" fails validation`,
        });
        continue;
      }

      let ownerId = companyIsrOwner ?? "";
      if (!ownerId && source.type === "deal" && !ensuredRepCodeIds.has(code)) {
        const resolvers = await loadRepResolvers(sb, token, signal);
        ownerId = resolvers.repCodeToOwner.get(code) ?? "";
      }

      const ensured = await ensureRepCodeRecord(token, code, ownerId || undefined, signal);
      if (!ensured) {
        assocSkips.push({
          objectType: REP_OBJECT,
          property,
          rawValue: code,
          reason: `rep code "${code}" lookup/create failed`,
        });
        continue;
      }
      if (!ensured.created) continue; // existed already, or a racing push won

      fixActions.push({
        scope: source.type,
        property,
        from: code,
        to: ensured.id,
        action: "auto_created",
        reason:
          `Rep Code "${code}" not in HubSpot — record created` +
          `${ownerId ? " with ISR owner" : ""} and associated to ${source.type} ${source.label}`,
      });

      const assocFail = await associateRepCode(token, source.objectType, source.id, ensured.id, signal);
      if (assocFail) {
        assocSkips.push({ objectType: source.objectType, property, rawValue: code, reason: assocFail });
      }

      for (const reason of await createRepCodeAlertTask({
        env,
        token,
        repId: ensured.id,
        code,
        source,
        ownerSet: Boolean(ownerId),
        signal,
      })) {
        assocSkips.push({ objectType: REP_OBJECT, property, rawValue: code, reason });
      }
    } catch (e) {
      assocSkips.push({
        objectType: REP_OBJECT,
        property,
        rawValue: part,
        reason: `rep code auto-create error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
}

/** Push a Companies payload: upsert by account_number_ with heal. */
export async function pushCompany(
  env: Env,
  sb: SupabaseClient,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<PushOutcome> {
  const token = env.HUBSPOT_TOKEN;
  const fixActions: (FixAction & { scope?: string })[] = [];
  const assocSkips: AssocSkip[] = [];
  if (!token) {
    return { result: null, error: "HUBSPOT_TOKEN not configured", status: 500, fixActions, assocSkips };
  }

  const accountNumber = payload.account_number_ != null ? String(payload.account_number_).trim() : "";
  if (!accountNumber) {
    return { result: null, error: "Missing account_number_", status: 400, fixActions, assocSkips };
  }

  const learn: LearnEntry[] = [];
  const [aliasMap, optionsByProp, resolvers] = await Promise.all([
    loadAliases(sb, "companies"),
    loadOptions(sb, "companies"),
    loadRepResolvers(sb, token, signal),
  ]);

  try {
    const mapped = mapFields(payload, COMPANY_FIELD_MAP);
    mapped.account_number_ = accountNumber;
    const n = normalizeWithLearning("companies", "company", mapped, optionsByProp, aliasMap);
    for (const a of n.actions) fixActions.push(a);
    for (const e of n.learn) learn.push(e);
    const properties = n.properties;

    // Inside-sales (ISR): deterministic from the synced rep_codes sheet (replaces
    // the stale HubSpot workflow chain). Injected AFTER normalize so the multi-value
    // `inside_sales_managers` checkbox isn't mis-dropped as a single enum value;
    // withHeal still recovers a genuinely invalid owner-id option at push time.
    const isr = computeInsideSalesFields(
      { amtRepCode: payload.inside_sales_rep, salesRepCode: payload.sales_rep_code },
      resolvers,
    );
    Object.assign(properties, isr.properties);
    for (const code of isr.unresolved) {
      assocSkips.push({
        objectType: "companies",
        property: isr.path === "amt" ? "inside_sales_rep" : "sales_rep_code",
        rawValue: code,
        reason: `inside-sales: no HubSpot owner for ${isr.path === "amt" ? "AMT code" : "rep code"} "${code}"`,
      });
    }

    // Company Status, derived from Risk Category Description (absorbs the "Set
    // Company Status to Active or Inactive" workflow). Injected AFTER normalize —
    // "true"/"false" are valid options, but injecting here keeps it out of the enum
    // heal path. Only when the payload carries the field, so a payload that omits it
    // never clobbers an existing status. `companyStatus` also drives the Rep Code
    // inactive labeling below (null = unknown this push → leave labels to reconcile).
    const companyStatus = companyStatusFromRiskCategory(payload.risk_category_description);
    if (companyStatus !== null) properties.status = companyStatus;

    const res = await withHeal(token, signal, "company", fixActions, properties, (props) =>
      hs(token, "POST", PATHS.companyUpsert, {
        inputs: [{ idProperty: "account_number_", id: accountNumber, properties: props }],
      }, signal),
    );
    const result = res.data?.results?.[0];
    if (!result?.id) throw new Error("HubSpot company upsert response missing id");

    // Sync the matching Rep Code object(s) — owner + Agency/City/Brands/Status/State
    // (absorbs the "Account # to Rep Code Syncing" workflow) and the directional
    // "Inactive" association label, all driven from this company. A regular customer
    // company matches no Rep Code → no-op. Owner only flows when path is AMT (the
    // company's own ISR). All failures are non-fatal (assocSkips).
    const isrOwner = isr.path === "amt" ? isr.properties.inside_sales_rep_from_sap ?? "" : "";
    // The company upsert already succeeded; rep-code sync must never fail the push.
    // NOTE: `agency` (= the company's HubSpot `name`, which carries a "#account"
    // suffix the writer doesn't have here) is intentionally owned by the territory
    // reconcile, which reads the real `name` — passing the bare SAP name here would
    // flip-flop against it. City/Brands/State/Status are identical either side.
    try {
      for (const skip of await syncRepCodesForCompany({
        token,
        accountNumber,
        companyFields: {
          city: payload.city,
          productBrand: payload.product_brand,
          stateAbbr: payload.state,
        },
        companyStatus,
        isrOwner,
        signal,
      })) {
        assocSkips.push(skip);
      }
    } catch (e) {
      assocSkips.push({
        objectType: REP_OBJECT,
        property: "rep_code_sync",
        rawValue: accountNumber,
        reason: `rep-code sync error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // The account's SERVICING rep code (sales_rep_code) — auto-create the Rep Code
    // record + association + review task when SAP references a code HubSpot lacks.
    await ensureServicingRepCodes({
      env,
      sb,
      token,
      rawValue: payload.sales_rep_code,
      property: "sales_rep_code",
      source: { type: "company", objectType: "companies", id: String(result.id), label: accountNumber },
      companyIsrOwner: isrOwner,
      fixActions,
      assocSkips,
      signal,
    });

    return {
      result: { hs_record_id: String(result.id), account_number_: accountNumber, new: Boolean(result?.new) },
      error: null,
      status: 200,
      fixActions,
      assocSkips,
    };
  } catch (err) {
    return {
      result: null,
      error: err instanceof Error ? err.message : String(err),
      status: err instanceof HsError ? err.status : 500,
      fixActions,
      assocSkips,
    };
  } finally {
    await persistAliases(sb, learn);
  }
}

/** Daily refresh of cached HubSpot enum options (called by the cron + on demand). */
export async function refreshHubspotOptions(env: Env, sb: SupabaseClient): Promise<void> {
  const token = env.HUBSPOT_TOKEN;
  if (!token) return;
  const signal = AbortSignal.timeout(30_000);
  const objects: { objectType: string; path: string }[] = [
    { objectType: "deals", path: "/crm/v3/properties/0-3" },
    { objectType: "companies", path: "/crm/v3/properties/companies" },
    { objectType: "line_items", path: "/crm/v3/properties/line_items" },
  ];
  for (const { objectType, path } of objects) {
    try {
      const res = await hs(token, "GET", path, undefined, signal);
      if (!res.ok) {
        console.error(`[heal] options fetch ${objectType} -> ${res.status}`);
        continue;
      }
      const rows = ((res.data?.results ?? []) as any[])
        .filter((p) => p?.type === "enumeration" && Array.isArray(p?.options) && p.options.length)
        .map((p) => ({
          objectType,
          property: String(p.name),
          fieldType: String(p.type),
          options: (p.options as any[]).map((o) => ({
            label: String(o?.label ?? o?.value ?? ""),
            value: String(o?.value ?? o?.label ?? ""),
          })),
        }));
      await upsertPropertyOptions(sb, rows);
      console.log(`[heal] cached ${rows.length} ${objectType} enum properties`);
    } catch (e) {
      console.error(`[heal] refresh ${objectType} failed:`, e);
    }
  }
}

// --- Deal-stage probability calibration (weekly cron) ---
// Set each stage's HubSpot "Deal probability" so the open-deal-weighted average equals
// the realized overall win rate W. Pre-Qualified and Awarded are pinned to their own
// observed win rates (round to ~0% / ~100%); the three middle stages are calibrated. All
// rates round to the nearest whole percent. The pure solve lives in @wac/shared; this is
// the HubSpot I/O. See docs in stageprob.ts.

const PIN_MIN_SAMPLE = 30; // below this, don't trust a thin end-stage cohort
const DEFAULT_AWARDED_PROB = 0.95; // fallback only if the Awarded cohort is too thin
const round2 = (x: number): number => Math.round(x * 100) / 100; // → nearest whole percent

type SearchFilter = { propertyName: string; operator: string; value?: string };
const stageFilter = (stageId: string): SearchFilter => ({
  propertyName: "dealstage",
  operator: "EQ",
  value: stageId,
});

/** Count deals matching one AND-group of filters via the search `total` (never throws; -1 on error). */
async function countDeals(token: string, filters: SearchFilter[], signal: AbortSignal): Promise<number> {
  const res = await hs(token, "POST", PATHS.dealSearch, { filterGroups: [{ filters }], limit: 1 }, signal);
  if (!res.ok) {
    console.error(`[stageprob] deal count failed (${res.status})`);
    return -1;
  }
  return Number(res.data?.total ?? 0);
}

/** Read-modify-write each stage's probability, preserving label/displayOrder/metadata. */
async function writeStageProbabilities(
  token: string,
  probs: { prequal: number; planning: number; db: number; bidding: number; awarded: number },
  signal: AbortSignal,
): Promise<void> {
  const res = await hs(token, "GET", PATHS.dealPipeline, undefined, signal);
  if (!res.ok) {
    console.error(`[stageprob] pipeline GET failed (${res.status}) — needs the crm.pipelines.deals scope?`);
    return;
  }
  const stages = (res.data?.stages ?? []) as any[];
  const targets: { id: string; prob: number }[] = [
    { id: DEAL_STAGES.prequal, prob: probs.prequal },
    { id: DEAL_STAGES.planning, prob: probs.planning },
    { id: DEAL_STAGES.db, prob: probs.db },
    { id: DEAL_STAGES.bidding, prob: probs.bidding },
    { id: DEAL_STAGES.awarded, prob: probs.awarded },
  ];
  for (const t of targets) {
    const stage = stages.find((s) => String(s?.id) === t.id);
    if (!stage) {
      console.error(`[stageprob] stage ${t.id} not found in pipeline`);
      continue;
    }
    const next = t.prob.toFixed(2);
    const old = stage?.metadata?.probability;
    if (String(old) === next) {
      console.log(`[stageprob] ${stage.label}: probability already ${next}, skipping`);
      continue;
    }
    const body = {
      label: stage.label,
      displayOrder: stage.displayOrder,
      metadata: { ...(stage.metadata ?? {}), probability: next },
    };
    const up = await hs(token, "PATCH", `${PATHS.dealPipelineStage}/${t.id}`, body, signal);
    if (!up.ok) {
      console.error(`[stageprob] ${stage.label} PATCH failed (${up.status})`, up.data);
      continue;
    }
    console.log(`[stageprob] ${stage.label}: probability ${old} -> ${next}`);
  }
}

/**
 * Weekly recompute of the four managed deal-stage probabilities (called by the cron).
 * Log-only unless STAGE_PROB_WRITE === "1", so the numbers can be validated before any
 * write (and so a missing crm.pipelines.deals scope can't block the computation). Pure
 * read until that flag is set. Best-effort: logs rather than throwing.
 */
export async function refreshStageProbabilities(env: Env): Promise<void> {
  const token = env.HUBSPOT_TOKEN;
  if (!token) return;
  const write = env.STAGE_PROB_WRITE === "1";
  const signal = AbortSignal.timeout(60_000);
  try {
    const closedFilter: SearchFilter = { propertyName: "hs_is_closed", operator: "EQ", value: "true" };
    const wonFilter: SearchFilter = { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" };
    const enteredFilter = (stageId: string): SearchFilter => ({
      propertyName: `hs_v2_date_entered_${stageId}`,
      operator: "HAS_PROPERTY",
    });

    // Realized overall win rate W = won / closed.
    const closed = await countDeals(token, [closedFilter], signal);
    const won = await countDeals(token, [wonFilter], signal);
    if (closed <= 0 || won < 0) {
      console.warn("[stageprob] no closed-deal data; skipping");
      return;
    }
    const winRate = won / closed;

    // End stages pinned to their own observed win rates; the solver rounds + bands them
    // to [1%, 99%] (Pre-Qualified floors at 1%, Awarded ceils at 99% — HubSpot reserves
    // 0/100 for lost/won). Thin cohort → fall back (Pre-Qualified 0, Awarded default).
    const pqEntered = enteredFilter(DEAL_STAGES.prequal);
    const pqClosed = await countDeals(token, [pqEntered, closedFilter], signal);
    const pqWon = await countDeals(token, [pqEntered, wonFilter], signal);
    const prequalProb = pqClosed >= PIN_MIN_SAMPLE && pqWon >= 0 ? round2(pqWon / pqClosed) : 0;

    const awEntered = enteredFilter(DEAL_STAGES.awarded);
    const awClosed = await countDeals(token, [awEntered, closedFilter], signal);
    const awWon = await countDeals(token, [awEntered, wonFilter], signal);
    const awardedProb =
      awClosed >= PIN_MIN_SAMPLE && awWon >= 0 ? round2(awWon / awClosed) : DEFAULT_AWARDED_PROB;

    // Current open-deal counts per stage.
    const openCounts: StageOpenCounts = {
      prequal: await countDeals(token, [stageFilter(DEAL_STAGES.prequal)], signal),
      planning: await countDeals(token, [stageFilter(DEAL_STAGES.planning)], signal),
      db: await countDeals(token, [stageFilter(DEAL_STAGES.db)], signal),
      bidding: await countDeals(token, [stageFilter(DEAL_STAGES.bidding)], signal),
      awarded: await countDeals(token, [stageFilter(DEAL_STAGES.awarded)], signal),
    };
    if (Object.values(openCounts).some((v) => v < 0)) {
      console.warn("[stageprob] open-count fetch failed; skipping");
      return;
    }

    const probs = solveStageProbabilities({ winRate, openCounts, prequalProb, awardedProb });
    if (!probs) {
      console.warn("[stageprob] insufficient open pipeline to calibrate; skipping");
      return;
    }
    const achieved = weightedAverageProbability(probs, openCounts);
    console.log(
      `[stageprob] W=${winRate.toFixed(3)} (won ${won}/${closed}) ` +
        `pPQ=${prequalProb.toFixed(3)} (won ${pqWon}/${pqClosed}) ` +
        `pAW=${awardedProb.toFixed(3)} (won ${awWon}/${awClosed}) ` +
        `open=${JSON.stringify(openCounts)} -> ` +
        `prequal=${probs.prequal} planning=${probs.planning} db=${probs.db} ` +
        `bidding=${probs.bidding} awarded=${probs.awarded} ` +
        `(weighted avg ${achieved.toFixed(3)})`,
    );

    if (!write) {
      console.log("[stageprob] STAGE_PROB_WRITE!=1 — log-only, not writing to HubSpot");
      return;
    }
    await writeStageProbabilities(token, probs, signal);
  } catch (e) {
    console.error("[stageprob] refresh failed:", e);
  }
}
