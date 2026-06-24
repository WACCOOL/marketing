import {
  COMPANY_FIELD_MAP,
  DEAL_DATE_FIELDS,
  DEAL_FIELD_MAP,
  LINE_ITEM_DATE_FIELDS,
  LINE_ITEM_FIELD_MAP,
  extractInvalidPropertyItems,
  healProperties,
  isValidationError,
  mapFields,
  smartMatchToAllowedOptions,
  toDecimalPercent,
  toHubspotDate,
  toNumber,
  type FixAction,
} from "@wac/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env.js";
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

const PATHS = {
  dealSearch: "/crm/v3/objects/0-3/search",
  dealUpsert: "/crm/v3/objects/0-3/batch/upsert",
  dealUpdate: "/crm/v3/objects/0-3/batch/update",
  lineItemUpsert: "/crm/v3/objects/line_items/batch/upsert",
  lineItemToDeal: "/crm/v4/associations/line_items/0-3/batch/create",
  companyToDeal: "/crm/v4/associations/companies/0-3/batch/create",
  contactToDeal: "/crm/v4/associations/contacts/0-3/batch/create",
  companyUpsert: "/crm/v3/objects/companies/batch/upsert",
  companyLookup: "/crm/v3/objects/companies/",
  contactLookup: "/crm/v3/objects/contacts/",
  contactSearch: "/crm/v3/objects/contacts/search",
  owners: "/crm/v3/owners",
};

const ASSOC = {
  category: "HUBSPOT_DEFINED",
  lineItemToDeal: 20,
  companyToDeal: 6,
  contactToDeal: 4,
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
async function hs(
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
async function withHeal(
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

interface OwnerRec {
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
async function resolveOwnerByName(
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

interface ContactByEmail {
  id: string;
  email: string;
}

async function getContactByEmailExact(
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
const GENERIC_DOMAINS = new Set([
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

async function findDealIdByQuoteNumber(
  token: string,
  quoteNumber: string,
  signal: AbortSignal,
): Promise<string | null> {
  const res = await hs(
    token,
    "POST",
    PATHS.dealSearch,
    {
      filterGroups: [
        { filters: [{ propertyName: "sap_quote_number", operator: "EQ", value: quoteNumber }] },
      ],
      limit: 1,
      properties: ["sap_quote_number"],
    },
    signal,
  );
  if (!res.ok) throw new HsError(res);
  const hit = res.data?.results?.[0];
  return hit?.id ? String(hit.id) : null;
}

/**
 * Convert SAP `MM/DD/YYYY` date strings to HubSpot's date format (midnight-UTC
 * ms) for the given target properties; drop null/invalid (e.g. `00/00/0000`) so a
 * bad value is never sent. These properties are date-typed with no options, so
 * they must not pass through the enum heal (kept out of the options map).
 */
function coerceDates(bag: Record<string, unknown>, fields: readonly string[]): void {
  for (const f of fields) {
    if (bag[f] === undefined) continue;
    const d = toHubspotDate(bag[f]);
    if (d === null) delete bag[f];
    else bag[f] = d;
  }
}

async function upsertDeal(
  token: string,
  payload: Record<string, unknown>,
  poc: ResolvedPoc,
  signal: AbortSignal,
  fixActions: (FixAction & { scope?: string })[],
  aliasMap: Map<string, string>,
  optionsByProp: Map<string, OptionDef[]>,
  learn: LearnEntry[],
): Promise<{ id: string; quoteNumber: string | null; isNew: boolean }> {
  const quoteNumber = payload.quotation_number != null ? String(payload.quotation_number).trim() : "";
  const dealIdRaw = payload.opportunity_id ?? payload.oppourtunity_id ?? null;
  const dealId = dealIdRaw != null ? String(dealIdRaw).trim() : "";
  const hasDealId = /^\d+$/.test(dealId);

  const mapped = mapFields(payload, DEAL_FIELD_MAP);
  if (poc.email) mapped.requested_by = poc.email; // self-heal SAP's truncated/name value
  coerceDates(mapped, DEAL_DATE_FIELDS); // MM/DD/YYYY -> HubSpot date (ms); drop 00/00/0000
  // Proactive: apply learned aliases + validate/auto-correct dropdowns before pushing.
  const n = normalizeWithLearning("deals", "deal", mapped, optionsByProp, aliasMap);
  for (const a of n.actions) fixActions.push(a);
  for (const e of n.learn) learn.push(e);
  const properties = n.properties;

  if (quoteNumber) {
    const existing = await findDealIdByQuoteNumber(token, quoteNumber, signal);
    if (existing) {
      await withHeal(token, signal, "deal", fixActions, properties, (props) =>
        hs(token, "POST", PATHS.dealUpdate, { inputs: [{ id: existing, properties: props }] }, signal),
      );
      return { id: existing, quoteNumber, isNew: false };
    }
  }

  if (hasDealId) {
    try {
      await withHeal(token, signal, "deal", fixActions, properties, (props) =>
        hs(token, "POST", PATHS.dealUpdate, { inputs: [{ id: dealId, properties: props }] }, signal),
      );
      return { id: dealId, quoteNumber: quoteNumber || null, isNew: false };
    } catch (err) {
      const notFound =
        err instanceof HsError &&
        (err.status === 404 ||
          err.data?.category === "OBJECT_NOT_FOUND" ||
          String(err.message).toLowerCase().includes("not exist"));
      if (!notFound) throw err;
    }
  }

  if (!quoteNumber) throw new Error("Missing quotation_number and no valid opportunity_id provided.");
  const res = await withHeal(token, signal, "deal", fixActions, properties, (props) =>
    hs(token, "POST", PATHS.dealUpsert, {
      inputs: [{ idProperty: "sap_quote_number", id: quoteNumber, properties: props }],
    }, signal),
  );
  const result = res.data?.results?.[0];
  if (!result?.id) throw new Error("HubSpot deal upsert response missing id");
  return { id: String(result.id), quoteNumber, isNew: Boolean(result?.new) };
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
      if (mapped.commission !== undefined) mapped.commission = toDecimalPercent(mapped.commission);
      if (mapped.hs_discount_percentage !== undefined) {
        mapped.hs_discount_percentage = toDecimalPercent(mapped.hs_discount_percentage);
      }
      coerceDates(mapped, LINE_ITEM_DATE_FIELDS); // MM/DD/YYYY -> HubSpot date (ms)
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

async function batchAssociate(
  token: string,
  path: string,
  typeId: number,
  pairs: { fromId: string; toId: string }[],
  signal: AbortSignal,
): Promise<void> {
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const inputs = pairs.slice(i, i + BATCH_SIZE).map((p) => ({
      types: [{ associationCategory: ASSOC.category, associationTypeId: typeId }],
      from: { id: p.fromId },
      to: { id: p.toId },
    }));
    const res = await hs(token, "POST", path, { inputs }, signal);
    if (!res.ok) throw new HsError(res);
  }
}

async function lookupCompanyId(
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
    const deal = await upsertDeal(token, payload, poc, signal, fixActions, dealAliases, dealOptions, learn);

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
  const [aliasMap, optionsByProp] = await Promise.all([
    loadAliases(sb, "companies"),
    loadOptions(sb, "companies"),
  ]);

  try {
    const mapped = mapFields(payload, COMPANY_FIELD_MAP);
    mapped.account_number_ = accountNumber;
    const n = normalizeWithLearning("companies", "company", mapped, optionsByProp, aliasMap);
    for (const a of n.actions) fixActions.push(a);
    for (const e of n.learn) learn.push(e);
    const properties = n.properties;
    const res = await withHeal(token, signal, "company", fixActions, properties, (props) =>
      hs(token, "POST", PATHS.companyUpsert, {
        inputs: [{ idProperty: "account_number_", id: accountNumber, properties: props }],
      }, signal),
    );
    const result = res.data?.results?.[0];
    if (!result?.id) throw new Error("HubSpot company upsert response missing id");
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
