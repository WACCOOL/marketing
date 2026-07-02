/**
 * Marketing-event lead-ownership orchestrator.
 *
 * A HubSpot workflow enrolls an event attendee and POSTs to /api/hubspot/event-lead
 * (see routes/eventLeads.ts). This module does the work: fetch the routing facts,
 * walk the pure decision tree ({@link evaluateLeadOwnership}), resolve the leaf to a
 * HubSpot owner, create a Lead assigned to that owner, associate it to the contact
 * and the campaign, and set the contact owner only when it's currently empty.
 *
 * Three leaf resolution modes (see leadOwnership.ts):
 *   - person  → a fixed owner (by id here, falling back to name/email resolution).
 *   - repCode → read the contact's `rep_code_<channel>` value, then assign either
 *               the owner of that Rep Code object (resolve:"owner") or its
 *               Regional Manager (resolve:"rsm" → Nick/Dhane via rep_codes.rsm_tsm).
 *   - fallback / blank rep code → the global fallback owner, Lana.
 */
import {
  evaluateLeadOwnershipAll,
  normalizeCompanyType,
  normalizeLeadBrand,
  projectFocusFromSubType,
  isLatinAmerica,
  brandFromNotes,
  mfAccount,
  CHANNEL_TO_CONTACT_PROP,
  CONTACT_REP_CODE_PROPS,
  PROJECT_FOCUS_PROP,
  PRODUCT_FOCUS_PROP,
  type LeadFacts,
  type Leaf,
  type LeadDecision,
} from "@wac/shared";
import type { Env } from "./env.js";
import { serviceSupabase } from "./supabase.js";
import { hs, PATHS, REP_OBJECT, resolveOwnerByName } from "./hubspotPush.js";
import { emailDomain, isNationalAccountDomain, NATIONAL_ACCOUNT_PROP } from "./nationalAccounts.js";
import { classifyProjectFocus } from "./projectFocus.js";
import { classifyProductFocus } from "./productFocus.js";

// ---------------------------------------------------------------------------
// Config — confirmed owner ids (from HubSpot) + property names. Edit-in-one-place.
// ---------------------------------------------------------------------------

/** Fixed person → HubSpot owner id. (Discovered via search_owners.) */
const PERSON_OWNER_ID: Record<string, string> = {
  "Lana": "949674634", // Lana Anderson
  "Harry": "410841723", // Harry Moshos
  "Navita Phagoo": "1913042681",
  "Kalin Scott": "77005662",
  "Rudy Soni": "711482911",
  "Sara Kruid": "82088491",
  "Angela Yost": "94775404", // angela.yost@schonbek.com (name fields blank → must use id)
};

/** International WAC-spec owner email → owner id. */
const INTL_EMAIL_OWNER_ID: Record<string, string> = {
  "wilson.tson@waclighting.com": "94770173",
  "wijitporn.y@waclighting.com": "94770174",
  "rebekah.thompson@waclighting.com": "94770170",
  "setia.budi@waclighting.com": "94770166",
  "hemanth.raju@waclighting.com": "94770162",
  "betty.luo@waclighting.com": "82908093",
};

/** Global fallback owner (Lana) for unresolved leaves / blank rep codes. */
const FALLBACK_OWNER_ID = PERSON_OWNER_ID["Lana"]!;

/**
 * Dynamic list "Competitor Contacts Based on Domain". Members get NO lead — unless
 * they're associated with a company that has an account number (a real customer).
 */
const COMPETITOR_LIST_ID = "1966";

/**
 * How close to the event a `lead_notes` update must be to count as taken AT the show
 * (older notes are from previous shows and must not leak onto this lead).
 */
const NOTES_FRESH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Contact properties that drive routing. */
const CONTACT_PROPS = {
  /** Canada / International / North America bucket. `global_region` is NA-vs-Intl. */
  region: "global_region",
  /** Two-letter country code (CA distinguishes Canada). */
  countryCode: "hs_country_region_code",
  country: "country",
  /** Persona enum (Interior Designer / Architect / Contractor / …). */
  role: "your_role",
  /** Contact-level type (Interior Designer / Distributor / Lighting Showroom / Interior
   *  Design Firm: … / …) — the contact's own classification, used as the company sub-type
   *  fallback when the contact has no associated company. */
  leadType: "lead_type",
} as const;

/**
 * Per-brand lead-score contact properties (numbers). Used as the brand fallback
 * when the campaign carries no brand: the highest-scoring brand wins.
 */
const BRAND_SCORE_PROP: Record<string, string> = {
  "WAC Lighting": "wac_lighting",
  "WAC Architectural": "wac_architectural",
  "Modern Forms": "modern_forms",
  Schonbek: "schonbek",
};

/**
 * Native Leads object schema (confirmed via REST against portal 46455872).
 * `hs_lead_source` is a fixed enum and the drill-downs are read-only, so we use two
 * custom text properties created for this feature: `marketing_event_source` (the
 * event/campaign name) and `rep_code_routing` (the rep code that oversees the
 * account — surfaced even when the lead is assigned to a fixed person). The lead is
 * associated to the contact (Primary, 578) and, when there's a routing rep code, to
 * that Rep Code object via the "Routing Rep Code" label (typeId 194, USER_DEFINED).
 */
const LEAD = {
  nameProp: "hs_lead_name",
  sourceProp: "marketing_event_source",
  repCodeProp: "rep_code_routing",
  /** Names of the other reps this event was also routed to (fan-out, brand unknown). */
  coOwnersProp: "lead_co_owners",
  /** Fresh at-show notes copied from the contact's `lead_notes` (timestamp-stamped). */
  notesProp: "lead_notes",
  pipeline: "lead-pipeline-id",
  stage: "new-stage-id",
  contactToLeadTypeId: 578,
  repCodeAssocTypeId: 194,
  /** Campaign CRM object (0-35) + native lead→campaign association (HUBSPOT_DEFINED). */
  campaignObjectType: "0-35",
  campaignAssocTypeId: 2741,
  /** Marketing Events object (0-54) + native lead→event association (HUBSPOT_DEFINED). */
  marketingEventObjectType: "0-54",
  marketingEventAssocTypeId: 1391,
  /** Note engagement → contact association (HUBSPOT_DEFINED). Leads can't hold their
   *  own engagements — a lead record surfaces its CONTACT's timeline, so the routing
   *  note goes on the contact and shows on every lead created for them. */
  noteToContactTypeId: 202,
};

// ---------------------------------------------------------------------------
// Result type + payload
// ---------------------------------------------------------------------------

export interface EventLeadBody {
  contactId: string;
  campaignId?: string;
  campaignName?: string;
  campaignBrand?: string;
  campaignChannel?: string;
  /** Resolve + return the decision without creating a Lead or writing the owner. */
  dryRun?: boolean;
}

/** One created (or would-be) Lead — there can be several when the brand is unknown. */
export interface ResolvedLead {
  leafLabel: string;
  decisionPath: string[];
  ownerId: string | null;
  ownerSource: string;
  /** The rep code overseeing the account (from the routing channel), if any. */
  routingRepCode: string | null;
  leadId: string | null;
  leadError: string | null;
  associations: { contact: boolean; repCode: boolean; campaign: boolean };
}

export interface EventLeadResult {
  contactId: string;
  nationalAccount: boolean;
  /** The campaign used (passed by the workflow, or auto-resolved from marketing events). */
  campaignName: string | null;
  /** Fresh at-show notes copied onto the lead(s) (date-stamped), or null. */
  leadNotes: string | null;
  /** Account-numbered associated company → Re-attempting; none → New business. */
  leadType: "NEW_BUSINESS" | "RE_ATTEMPTING" | null;
  /** Owners skipped because they already had a lead for this campaign (idempotency). */
  dedupedExisting: number;
  /** One per distinct owner. Multiple only when the brand was unknown (fan-out). */
  leads: ResolvedLead[];
  contactOwnerAction: "set" | "skipped_existing" | "skipped_no_owner" | "skipped_multiple";
  /** Set when NO leads were created on purpose (e.g. a competitor-domain contact). */
  skippedReason?: "competitor";
}

// ---------------------------------------------------------------------------
// Fact fetching
// ---------------------------------------------------------------------------

interface ContactFacts {
  email: string;
  name: string;
  ownerId: string;
  region: string;
  countryCode: string;
  country: string;
  role: string;
  /** Contact-level type (`lead_type`) — company sub-type fallback when no company. */
  leadType: string;
  /** At-show notes (`lead_notes`) + when they were last written (ms epoch, 0 = never). */
  leadNotes: string;
  leadNotesUpdatedAt: number;
  /** channel name → rep code value (only non-blank ones). */
  repCodes: Record<string, string>;
  /** canonical brand → lead score (number). */
  brandScores: Record<string, number>;
}

async function fetchContact(token: string, contactId: string, signal: AbortSignal): Promise<ContactFacts> {
  const props = [
    "email",
    "firstname",
    "lastname",
    "hubspot_owner_id",
    CONTACT_PROPS.region,
    CONTACT_PROPS.countryCode,
    CONTACT_PROPS.country,
    CONTACT_PROPS.role,
    CONTACT_PROPS.leadType,
    "lead_notes",
    ...Object.values(BRAND_SCORE_PROP),
    ...CONTACT_REP_CODE_PROPS,
  ];
  const res = await hs(
    token,
    "GET",
    // propertiesWithHistory gives lead_notes' last-write timestamp, so we can tell an
    // at-show note from one left over from a previous show.
    `${PATHS.contactLookup}${encodeURIComponent(contactId)}?properties=${props.join(",")}&propertiesWithHistory=lead_notes`,
    undefined,
    signal,
  );
  if (!res.ok) {
    throw new Error(`contact ${contactId} fetch ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  const p = (res.data?.properties ?? {}) as Record<string, string | null>;
  const repCodes: Record<string, string> = {};
  for (const [channel, prop] of Object.entries(CHANNEL_TO_CONTACT_PROP)) {
    const v = (p[prop] ?? "").trim();
    if (v) repCodes[channel] = v;
  }
  const brandScores: Record<string, number> = {};
  for (const [brand, prop] of Object.entries(BRAND_SCORE_PROP)) {
    const n = Number(p[prop]);
    if (Number.isFinite(n)) brandScores[brand] = n;
  }
  return {
    email: (p.email ?? "").trim(),
    name: `${(p.firstname ?? "").trim()} ${(p.lastname ?? "").trim()}`.trim(),
    ownerId: (p.hubspot_owner_id ?? "").trim(),
    region: (p[CONTACT_PROPS.region] ?? "").trim(),
    countryCode: (p[CONTACT_PROPS.countryCode] ?? "").trim(),
    country: (p[CONTACT_PROPS.country] ?? "").trim(),
    role: (p[CONTACT_PROPS.role] ?? "").trim(),
    leadType: (p[CONTACT_PROPS.leadType] ?? "").trim(),
    leadNotes: (p.lead_notes ?? "").trim(),
    leadNotesUpdatedAt: Date.parse(
      (res.data?.propertiesWithHistory?.lead_notes?.[0]?.timestamp as string | undefined) ?? "",
    ) || 0,
    repCodes,
    brandScores,
  };
}

/** Highest-scoring brand (the brand fallback when a campaign carries no brand). */
function brandFromScores(scores: Record<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [brand, n] of Object.entries(scores)) {
    if (n > bestN) {
      best = brand;
      bestN = n;
    }
  }
  return best;
}

interface CompanyFacts {
  companyId: string;
  subType: string;
  nationalAccount: boolean;
  /** Raw `project_focus` multi-select (may be blank → classify just-in-time). */
  projectFocus: string;
  /** Raw `product_focus` multi-select (may be blank → classify just-in-time). */
  productFocus: string;
  /** Raw company props, reused to skip a refetch in the just-in-time classifier. */
  props: Record<string, string | null>;
}

/** An associated company with an account number, plus its inside sales person(s). */
interface IsrCompany {
  companyId: string;
  accountNumber: string;
  /** MF-prefixed account (Modern Forms family — can usually sell Schonbek too). */
  mf: boolean;
  /** `inside_sales_rep_from_sap`, else `inside_sales_manager_1` + `_2`. */
  isrOwnerIds: string[];
}

interface ContactCompanies {
  /** The primary associated company (routing facts), or null. */
  primary: CompanyFacts | null;
  /** Every associated company with an account number AND an inside sales person. */
  isrCompanies: IsrCompany[];
  /** Any associated company has an account number (competitor-skip exemption). */
  hasAccountCompany: boolean;
}

const COMPANY_FETCH_PROPS = [
  "company_sub_type_simplified",
  "company_sub_type",
  NATIONAL_ACCOUNT_PROP,
  PROJECT_FOCUS_PROP,
  PRODUCT_FOCUS_PROP,
  "account_number_",
  "inside_sales_rep_from_sap",
  "inside_sales_manager_1",
  "inside_sales_manager_2",
];

/** Read ALL the contact's associated companies: primary routing facts + ISR accounts. */
async function fetchCompanies(
  token: string,
  contactId: string,
  signal: AbortSignal,
): Promise<ContactCompanies> {
  const none: ContactCompanies = { primary: null, isrCompanies: [], hasAccountCompany: false };
  const assoc = await hs(
    token,
    "GET",
    `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/companies?limit=25`,
    undefined,
    signal,
  );
  if (!assoc.ok) return none;
  const ids = [
    ...new Set(
      ((assoc.data?.results ?? []) as Array<Record<string, unknown>>)
        .map((r) => String(r.toObjectId ?? r.id ?? ""))
        .filter(Boolean),
    ),
  ];
  if (!ids.length) return none;
  const res = await hs(
    token,
    "POST",
    "/crm/v3/objects/companies/batch/read",
    { properties: COMPANY_FETCH_PROPS, inputs: ids.map((id) => ({ id })) },
    signal,
  );
  if (!res.ok) return none;
  const byId = new Map<string, Record<string, string | null>>();
  for (const r of (res.data?.results ?? []) as Array<Record<string, any>>) {
    byId.set(String(r.id), (r.properties ?? {}) as Record<string, string | null>);
  }

  // Primary = the first association (HubSpot lists the primary company first).
  let primary: CompanyFacts | null = null;
  const p0 = byId.get(ids[0]!);
  if (p0) {
    const subType = (p0.company_sub_type_simplified ?? "").trim() || (p0.company_sub_type ?? "").trim();
    primary = {
      companyId: ids[0]!,
      subType,
      nationalAccount: (p0[NATIONAL_ACCOUNT_PROP] ?? "").toLowerCase() === "true",
      projectFocus: (p0[PROJECT_FOCUS_PROP] ?? "").trim(),
      productFocus: (p0[PRODUCT_FOCUS_PROP] ?? "").trim(),
      props: p0,
    };
  }

  const isrCompanies: IsrCompany[] = [];
  let hasAccountCompany = false;
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) continue;
    const accountNumber = (p.account_number_ ?? "").trim();
    if (!accountNumber) continue;
    hasAccountCompany = true;
    const fromSap = (p.inside_sales_rep_from_sap ?? "").trim();
    const isrOwnerIds = fromSap
      ? [fromSap]
      : [(p.inside_sales_manager_1 ?? "").trim(), (p.inside_sales_manager_2 ?? "").trim()].filter(Boolean);
    if (isrOwnerIds.length) {
      isrCompanies.push({ companyId: id, accountNumber, mf: mfAccount(accountNumber), isrOwnerIds });
    }
  }
  return { primary, isrCompanies, hasAccountCompany };
}

/**
 * The company's project focus for routing. Returns the stored value if present;
 * otherwise, for an unclassified interior designer, classifies just-in-time (writing
 * to the company unless dryRun). Non-designers / no company → null (→ Residential).
 */
async function resolveProjectFocus(
  env: Env,
  company: CompanyFacts | null,
  dryRun: boolean,
  signal: AbortSignal,
): Promise<string | null> {
  if (!company) return null;
  if (company.projectFocus) return company.projectFocus;
  if (normalizeCompanyType(company.subType) !== "Interior Designer") return null;
  // Some legacy sub-types embed the focus ("Interior Design Firm: Residential") —
  // authoritative, so use it instead of paying for a crawl.
  const fromSubType = projectFocusFromSubType(company.subType);
  if (fromSubType) return fromSubType;
  try {
    const r = await classifyProjectFocus(env, serviceSupabase(env), {
      companyId: company.companyId,
      source: "event-lead",
      signal,
      write: !dryRun,
      // Let the classifier fetch its own complete prop set (name, account_number_,
      // website, etc.) — our company.props is only the routing subset.
    });
    return r.value;
  } catch (e) {
    console.error("[event-lead] just-in-time project-focus classify failed:", e);
    return null;
  }
}

/**
 * The company's product focus (decorative/functional) for routing. Stored value if
 * present; otherwise, for an unclassified Showroom/Distributor, classifies just-in-time
 * (writes unless dryRun). Non-showroom/distributor / no company → null (→ Functional).
 */
async function resolveProductFocus(
  env: Env,
  company: CompanyFacts | null,
  dryRun: boolean,
  signal: AbortSignal,
): Promise<string | null> {
  if (!company) return null;
  if (company.productFocus) return company.productFocus;
  if (normalizeCompanyType(company.subType) !== "ShowroomDistributor") return null;
  try {
    const r = await classifyProductFocus(env, serviceSupabase(env), {
      companyId: company.companyId,
      source: "event-lead",
      signal,
      write: !dryRun,
      // Let the classifier fetch its own complete prop set (name, account_number_,
      // website, etc.) — our company.props is only the routing subset.
    });
    return r.value;
  } catch (e) {
    console.error("[event-lead] just-in-time product-focus classify failed:", e);
    return null;
  }
}

/** Company-level brand fallback for Showroom/Distributor: Decorative→Modern Forms, else WAC Lighting. */
function productFocusBrand(productFocus: string | null): string | null {
  if (!productFocus) return null;
  return /decorative/i.test(productFocus) ? "Modern Forms" : "WAC Lighting";
}

/** Map the contact's region/country props to the tree's Location bucket. */
function locationFact(c: ContactFacts): string {
  if (c.countryCode.toUpperCase() === "CA" || /\bcanada\b/i.test(c.country)) return "Canada";
  // Americas outside the US/Canada → Lana for manual routing (the international team
  // only covers OUTSIDE North + South America) — regardless of what global_region says.
  if (isLatinAmerica(c.countryCode) || isLatinAmerica(c.country)) return "Latin America";
  // global_region is "North America" / "International"; normalizeLocation handles it.
  if (c.region) return c.region;
  if (c.countryCode.toUpperCase() === "US") return "North America";
  return c.country || "";
}

/**
 * Owners who ALREADY have a lead for this contact + campaign. Makes processing
 * idempotent: queue retries and workflow re-enrollments never duplicate a lead —
 * they only fill in owners that are still missing one.
 */
async function existingCampaignLeadOwners(
  token: string,
  contactId: string,
  campaignName: string,
  signal: AbortSignal,
): Promise<Set<string>> {
  const owners = new Set<string>();
  if (!campaignName) return owners;
  const assoc = await hs(
    token,
    "GET",
    `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/leads`,
    undefined,
    signal,
  );
  const ids = [
    ...new Set(
      ((assoc.data?.results ?? []) as Array<Record<string, unknown>>)
        .map((r) => String(r.toObjectId ?? ""))
        .filter(Boolean),
    ),
  ];
  if (!ids.length) return owners;
  const res = await hs(
    token,
    "POST",
    "/crm/v3/objects/0-136/batch/read",
    { properties: ["hubspot_owner_id", LEAD.sourceProp], inputs: ids.map((id) => ({ id })) },
    signal,
  );
  for (const r of (res.data?.results ?? []) as Array<Record<string, any>>) {
    const p = r.properties ?? {};
    if ((p[LEAD.sourceProp] ?? "") === campaignName && p.hubspot_owner_id) {
      owners.add(String(p.hubspot_owner_id));
    }
  }
  return owners;
}

/** Is the contact in the competitor-domains list? (Dynamic list — self-updating.) */
async function inCompetitorList(token: string, contactId: string, signal: AbortSignal): Promise<boolean> {
  let after = "";
  for (let page = 0; page < 10; page++) {
    const res = await hs(
      token,
      "GET",
      `/crm/v3/lists/records/0-1/${encodeURIComponent(contactId)}/memberships${after ? `?after=${encodeURIComponent(after)}` : ""}`,
      undefined,
      signal,
    );
    if (!res.ok) return false; // fail open: a lists-API hiccup must not drop real leads
    const results = (res.data?.results ?? []) as Array<Record<string, unknown>>;
    if (results.some((r) => String(r.listId) === COMPETITOR_LIST_ID)) return true;
    after = String(res.data?.paging?.next?.after ?? "");
    if (!after) return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Leaf → owner resolution
// ---------------------------------------------------------------------------

/** A HubSpot owner's display name ("First Last", or email), by id. Best-effort. */
async function ownerName(token: string, ownerId: string, signal: AbortSignal): Promise<string> {
  const res = await hs(token, "GET", `${PATHS.owners}/${encodeURIComponent(ownerId)}`, undefined, signal);
  if (!res.ok) return "";
  const p = res.data ?? {};
  return `${(p.firstName ?? "").trim()} ${(p.lastName ?? "").trim()}`.trim() || String(p.email ?? "");
}

/** Rep Code object record id + owner, by rep code value (one batch read). */
async function repCodeObject(
  token: string,
  repCode: string,
  signal: AbortSignal,
): Promise<{ id: string; ownerId: string }> {
  const res = await hs(
    token,
    "POST",
    `/crm/v3/objects/${REP_OBJECT}/batch/read`,
    { idProperty: "rep_code", properties: ["hubspot_owner_id"], inputs: [{ id: repCode }] },
    signal,
  );
  const r = res.ok ? res.data?.results?.[0] : null;
  return { id: String(r?.id ?? ""), ownerId: String(r?.properties?.hubspot_owner_id ?? "").trim() };
}

/** The rep-code channel that oversees the account for this leaf (repCode or person). */
function leafChannel(leaf: Leaf): string | null {
  if (leaf.kind === "repCode") return leaf.channel;
  if (leaf.kind === "person") return leaf.channel ?? null;
  return null;
}

/** Resolve the campaign CRM object (0-35) id: a numeric campaignId wins, else by name. */
async function campaignId(token: string, body: EventLeadBody, signal: AbortSignal): Promise<string> {
  if (body.campaignId && /^\d+$/.test(body.campaignId)) return body.campaignId;
  if (!body.campaignName) return "";
  const res = await hs(
    token,
    "POST",
    `/crm/v3/objects/${LEAD.campaignObjectType}/search`,
    {
      filterGroups: [{ filters: [{ propertyName: "hs_name", operator: "EQ", value: body.campaignName }] }],
      properties: ["hs_name"],
      limit: 1,
    },
    signal,
  );
  return res.ok ? String(res.data?.results?.[0]?.id ?? "") : "";
}

/** A marketing event's (0-54) associated campaign (0-35), or null. */
async function eventCampaign(
  token: string,
  eventId: string,
  signal: AbortSignal,
): Promise<{ id: string; name: string } | null> {
  const a = await hs(token, "GET", `/crm/v4/objects/0-54/${encodeURIComponent(eventId)}/associations/0-35`, undefined, signal);
  const campId = a.ok ? String(a.data?.results?.[0]?.toObjectId ?? "") : "";
  if (!campId) return null;
  const c = await hs(token, "GET", `/crm/v3/objects/${LEAD.campaignObjectType}/${campId}?properties=hs_name`, undefined, signal);
  return { id: campId, name: c.ok ? String(c.data?.properties?.hs_name ?? "").trim() : "" };
}

/**
 * Auto-resolve the campaign from the contact's marketing-event history: the MOST RECENT
 * event (by occurrence) that maps to a campaign. Uses the marketing-events participations
 * API (attendance) + the native event→campaign association — no name-matching, and it
 * covers both list-enrolled and individually-enrolled attendees. Null when the contact
 * has no campaign-linked event.
 */
async function campaignFromEvents(
  token: string,
  contactId: string,
  signal: AbortSignal,
): Promise<{ id: string; name: string; eventId: string; occurredAt: number } | null> {
  const res = await hs(
    token,
    "GET",
    `/marketing/v3/marketing-events/participations/contacts/${encodeURIComponent(contactId)}/breakdown`,
    undefined,
    signal,
  );
  if (!res.ok) return null;
  const parts = ((res.data?.results ?? []) as Array<Record<string, any>>)
    .filter((p) => (p?.properties?.attendanceState ?? "") !== "CANCELLED")
    .map((p) => ({
      evId: String(p?.associations?.marketingEvent?.marketingEventId ?? ""),
      occurredAt: Number(p?.properties?.occurredAt ?? 0),
      createdAt: Date.parse(p?.createdAt ?? "") || 0,
    }))
    .filter((p) => p.evId)
    .sort((a, b) => b.occurredAt - a.occurredAt || b.createdAt - a.createdAt);
  const seen = new Set<string>();
  for (const p of parts) {
    if (seen.has(p.evId)) continue;
    seen.add(p.evId);
    const camp = await eventCampaign(token, p.evId, signal);
    if (camp?.name) return { ...camp, eventId: p.evId, occurredAt: p.occurredAt };
  }
  return null;
}

/** Regional Manager (RSM/TSM) owner for a rep code, via rep_codes.rsm_tsm → owner. */
async function repCodeRsmOwnerId(
  env: Env,
  token: string,
  repCode: string,
  signal: AbortSignal,
): Promise<string> {
  const sb = serviceSupabase(env);
  const { data } = await sb
    .from("rep_codes")
    .select("rsm_tsm")
    .eq("rep_code", repCode.toUpperCase())
    .maybeSingle();
  const rsm = (data?.rsm_tsm ?? "").trim();
  if (!rsm) return "";
  const owner = await resolveOwnerByName(token, rsm, signal);
  return owner?.id ?? "";
}

interface Resolved {
  ownerId: string | null;
  source: string;
}

async function resolveLeaf(
  env: Env,
  token: string,
  leaf: Leaf,
  contact: ContactFacts,
  campaignChannel: string | undefined,
  signal: AbortSignal,
): Promise<Resolved> {
  if (leaf.kind === "person") {
    if (leaf.email) {
      const id = INTL_EMAIL_OWNER_ID[leaf.email.toLowerCase()];
      if (id) return { ownerId: id, source: `intl:${leaf.email}` };
    }
    if (leaf.name) {
      const id = PERSON_OWNER_ID[leaf.name];
      if (id) return { ownerId: id, source: `person:${leaf.name}` };
      const owner = await resolveOwnerByName(token, leaf.name, signal);
      if (owner) return { ownerId: owner.id, source: `person-resolved:${leaf.name}` };
    }
    return { ownerId: FALLBACK_OWNER_ID, source: `fallback:unresolved-person:${leaf.label}` };
  }

  if (leaf.kind === "repCode") {
    // The contact's rep code for this channel; else fall back to the campaign channel.
    let repCode = contact.repCodes[leaf.channel] ?? "";
    let via = `contact:${leaf.channel}`;
    if (!repCode && campaignChannel && CHANNEL_TO_CONTACT_PROP[campaignChannel]) {
      repCode = contact.repCodes[campaignChannel] ?? "";
      via = `campaign-channel:${campaignChannel}`;
    }
    if (!repCode) return { ownerId: FALLBACK_OWNER_ID, source: `fallback:no-rep-code:${leaf.channel}` };
    const id =
      leaf.resolve === "rsm"
        ? await repCodeRsmOwnerId(env, token, repCode, signal)
        : (await repCodeObject(token, repCode, signal)).ownerId;
    if (id) return { ownerId: id, source: `repcode:${leaf.resolve}:${repCode}:${via}` };
    return { ownerId: FALLBACK_OWNER_ID, source: `fallback:no-owner-for:${repCode}` };
  }

  return { ownerId: FALLBACK_OWNER_ID, source: `fallback:${leaf.reason}` };
}

// ---------------------------------------------------------------------------
// Lead creation
// ---------------------------------------------------------------------------

async function createLead(
  token: string,
  ownerId: string,
  body: EventLeadBody,
  contact: ContactFacts,
  contactId: string,
  repCode: string,
  coOwners: string,
  notes: string,
  marketingEventId: string,
  leadType: string,
  signal: AbortSignal,
): Promise<{ leadId: string | null; contact: boolean; repCode: boolean; campaign: boolean }> {
  // Encode the event in the lead name so the source is visible at a glance.
  const who = contact.name || contact.email || "Lead";
  const leadName = body.campaignName ? `${who} — ${body.campaignName}` : who;
  const properties: Record<string, string> = {
    hubspot_owner_id: ownerId,
    hs_pipeline: LEAD.pipeline,
    hs_pipeline_stage: LEAD.stage,
    [LEAD.nameProp]: leadName,
  };
  if (body.campaignName) properties[LEAD.sourceProp] = body.campaignName;
  if (repCode) properties[LEAD.repCodeProp] = repCode;
  if (notes) properties[LEAD.notesProp] = notes;
  if (leadType) properties.hs_lead_type = leadType;
  // HubSpot has no lead↔lead association; instead name the other routed reps here so
  // each rep can see who else owns a sibling lead for this attendee (shared contact).
  if (coOwners) properties[LEAD.coOwnersProp] = coOwners;

  // Resolve the Rep Code object + the campaign (0-35) so we can associate both at creation.
  const repObj = repCode ? await repCodeObject(token, repCode, signal) : { id: "", ownerId: "" };
  const campId = await campaignId(token, body, signal);
  const associations: unknown[] = [
    {
      to: { id: contactId },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: LEAD.contactToLeadTypeId }],
    },
  ];
  if (repObj.id) {
    associations.push({
      to: { id: repObj.id },
      types: [{ associationCategory: "USER_DEFINED", associationTypeId: LEAD.repCodeAssocTypeId }],
    });
  }
  if (campId) {
    associations.push({
      to: { id: campId },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: LEAD.campaignAssocTypeId }],
    });
  }
  if (marketingEventId) {
    associations.push({
      to: { id: marketingEventId },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: LEAD.marketingEventAssocTypeId }],
    });
  }

  const create = await hs(token, "POST", PATHS.leadCreate, { properties, associations }, signal);
  if (!create.ok) {
    throw new Error(`lead create ${create.status}: ${JSON.stringify(create.data).slice(0, 200)}`);
  }
  const leadId = String(create.data?.id ?? "") || null;
  return { leadId, contact: !!leadId, repCode: !!(leadId && repObj.id), campaign: !!(leadId && campId) };
}

/**
 * Attach a timeline Note to the CONTACT — the visible "leads created for …" /
 * at-show-notes artifact. Leads can't hold their own engagements (the API rejects
 * note↔lead associations); a lead record surfaces its contact's activity, so a
 * contact note shows up on every lead created for this attendee.
 */
async function attachRoutingNote(
  token: string,
  contactId: string,
  bodyHtml: string,
  signal: AbortSignal,
): Promise<boolean> {
  const res = await hs(
    token,
    "POST",
    "/crm/v3/objects/notes",
    {
      properties: { hs_note_body: bodyHtml, hs_timestamp: new Date().toISOString() },
      associations: [
        {
          to: { id: contactId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: LEAD.noteToContactTypeId }],
        },
      ],
    },
    signal,
  );
  return res.ok;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function processEventLead(
  env: Env,
  body: EventLeadBody,
  signal: AbortSignal,
): Promise<EventLeadResult> {
  const token = env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN not configured");
  const { contactId } = body;

  // Campaign: honor an explicit one from the workflow; otherwise auto-resolve from the
  // contact's most recent campaign-linked marketing event (so the workflow never has to
  // pass — or be updated per event). Drives the lead name, source, and campaign assoc.
  let eventDate: number | null = null;
  let marketingEventId = "";
  const ev = await campaignFromEvents(token, contactId, signal);
  if (ev) {
    marketingEventId = ev.eventId;
    eventDate = ev.occurredAt || null;
    // An explicit campaign from the workflow still wins; the event is used regardless
    // (lead→marketing-event association + the notes freshness anchor).
    if (!body.campaignName && !body.campaignId) {
      body = { ...body, campaignName: ev.name, campaignId: ev.id };
    }
  }

  const contact = await fetchContact(token, contactId, signal);

  // National-account override: email domain OR associated company flag.
  const naByDomain = await isNationalAccountDomain(env, emailDomain(contact.email));
  const { primary: company, isrCompanies, hasAccountCompany } = await fetchCompanies(token, contactId, signal);
  const nationalAccount = naByDomain.match || company?.nationalAccount === true;

  // Competitor gate: contacts on the competitor-domains list get NO lead — unless
  // they're associated with an account-numbered company (a real customer).
  if (!hasAccountCompany && (await inCompetitorList(token, contactId, signal))) {
    return {
      contactId,
      nationalAccount,
      campaignName: body.campaignName ?? null,
      leadNotes: null,
      leadType: null,
      dedupedExisting: 0,
      leads: [],
      contactOwnerAction: "skipped_no_owner",
      skippedReason: "competitor",
    };
  }

  // At-show notes: only when `lead_notes` was written within the freshness window of
  // the event (else it's a leftover from a previous show). Stamped with its write date
  // so reps know when the note was taken; a brand ask in the note focuses routing.
  const notesAnchor = eventDate ?? Date.now();
  const notesFresh =
    !!contact.leadNotes &&
    !!contact.leadNotesUpdatedAt &&
    Math.abs(contact.leadNotesUpdatedAt - notesAnchor) <= NOTES_FRESH_WINDOW_MS;

  // Lead type: an associated company with an account number (an existing customer) →
  // Re-attempting; no account number anywhere → New business.
  const leadType: "NEW_BUSINESS" | "RE_ATTEMPTING" = hasAccountCompany ? "RE_ATTEMPTING" : "NEW_BUSINESS";
  const leadNotesText = notesFresh
    ? `[${new Date(contact.leadNotesUpdatedAt).toISOString().slice(0, 10)}] ${contact.leadNotes}`
    : "";
  const notesBrand = notesFresh ? brandFromNotes(contact.leadNotes) : null;

  type Target = {
    d: LeadDecision;
    resolved: { ownerId: string | null; source: string };
    routingRepCode: string | null;
  };
  let targets: Target[];

  // Inside-sales override (beats national account + tree): companies with an account
  // number that already have an inside sales person route straight to them. A brand ask
  // (campaign, else fresh notes) narrows multiple accounts to the matching family —
  // MF-prefixed = Modern Forms/Schonbek side, the rest = WAC side.
  let isrPool = isrCompanies;
  const isrHintBrand = normalizeLeadBrand(body.campaignBrand ?? null) ?? notesBrand;
  if (isrHintBrand && isrPool.length > 1) {
    const mfFamily = isrHintBrand === "Modern Forms" || isrHintBrand === "Schonbek";
    const wacFamily = isrHintBrand === "WAC Lighting" || isrHintBrand === "WAC Architectural";
    const filtered = mfFamily ? isrPool.filter((c) => c.mf) : wacFamily ? isrPool.filter((c) => !c.mf) : isrPool;
    if (filtered.length) isrPool = filtered;
  }

  if (isrPool.length) {
    // One lead per DISTINCT inside sales person (same ISR on several accounts → one
    // lead, accounts merged). The co-owners field tells each ISR who else got one.
    const byOwner = new Map<string, string[]>();
    for (const c of isrPool) {
      for (const oid of c.isrOwnerIds) {
        const accts = byOwner.get(oid) ?? [];
        if (!accts.includes(c.accountNumber)) accts.push(c.accountNumber);
        byOwner.set(oid, accts);
      }
    }
    targets = [...byOwner.entries()].map(([ownerId, accts]) => ({
      d: {
        leaf: { kind: "person", name: "", label: `Inside sales (acct ${accts.join(", ")})` },
        path: [`isr:${accts.join("+")}`],
      },
      resolved: { ownerId, source: `isr:${accts.join("+")}` },
      routingRepCode: null,
    }));
    // National account routed to an ISR: Sara still gets her own lead so she's aware.
    const sara = PERSON_OWNER_ID["Sara Kruid"]!;
    if (nationalAccount && !targets.some((t) => t.resolved.ownerId === sara)) {
      targets.push({
        d: {
          leaf: { kind: "person", name: "Sara Kruid", label: "National account (notified)" },
          path: ["national-account-notify"],
        },
        resolved: { ownerId: sara, source: "national-account-notify" },
        routingRepCode: null,
      });
    }
  } else {
  // Decide the leaf/leaves. National accounts → Sara (single). Otherwise evaluate the
  // tree; with an unknown brand it FANS OUT to every brand branch (multiple owners).
  let decisions: LeadDecision[];
  if (nationalAccount) {
    decisions = [
      {
        leaf: { kind: "person", name: "Sara Kruid", label: "National Account → Sara Kruid" },
        path: [`nationalAccount:${naByDomain.match ? "domain" : "company-flag"}`],
      },
    ];
  } else {
    // Just-in-time classify (writes to the company unless dryRun) so the first attendee
    // routes correctly: project_focus for interior designers, product_focus for
    // showroom/distributor companies.
    const dry = body.dryRun ?? false;
    // Sub-type for routing: the associated company's when present, else the contact's own
    // "Contact Type" (`lead_type`) — so a designer/distributor/showroom contact with no
    // company (e.g. a solo interior designer on gmail) still routes by what they are.
    const companySubType = (company?.subType && company.subType.trim()) || contact.leadType || null;
    // Project focus: the classifier/stored value, else the focus embedded in the sub-type
    // ("Interior Design Firm: Commercial") — authoritative and works without a company.
    const projectFocus =
      (await resolveProjectFocus(env, company, dry, signal)) ?? projectFocusFromSubType(companySubType);
    const productFocus = await resolveProductFocus(env, company, dry, signal);
    // Brand: campaign first, then a brand ask in fresh at-show notes. For showroom/
    // distributor, fall back to the company's decorative/functional (Decorative→Modern
    // Forms, Functional→WAC); otherwise to the contact's top brand lead score.
    const isShowroomDistributor = normalizeCompanyType(companySubType) === "ShowroomDistributor";
    const brand =
      body.campaignBrand ??
      notesBrand ??
      (isShowroomDistributor ? productFocusBrand(productFocus) : brandFromScores(contact.brandScores));
    const facts: LeadFacts = {
      location: locationFact(contact),
      country: contact.country,
      role: contact.role,
      companySubType,
      brand,
      projectFocus,
      productFocus,
    };
    decisions = evaluateLeadOwnershipAll(facts);
  }

  // Resolve every leaf to an owner + its routing rep code.
  const resolvedAll = await Promise.all(
    decisions.map(async (d) => {
      const resolved = await resolveLeaf(env, token, d.leaf, contact, body.campaignChannel, signal);
      const channel = leafChannel(d.leaf);
      const routingRepCode = channel ? contact.repCodes[channel] ?? null : null;
      return { d, resolved, routingRepCode };
    }),
  );

  // Prefer real owners; drop blind fallbacks when a real owner exists. Then dedupe by
  // (owner, rep code) so two brands that resolve to the same rep don't double up.
  const real = resolvedAll.filter((e) => !e.resolved.source.startsWith("fallback"));
  const pool = real.length ? real : resolvedAll.slice(0, 1);
  const seen = new Set<string>();
  targets = pool.filter((e) => {
    const k = `${e.resolved.ownerId ?? ""}|${e.routingRepCode ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  }

  // Contact-owner rule: if the contact already has a known owner (and it isn't the Lana
  // fallback), that owner also gets a lead — they're notified alongside the routed rep.
  if (contact.ownerId && contact.ownerId !== FALLBACK_OWNER_ID && !targets.some((t) => t.resolved.ownerId === contact.ownerId)) {
    targets.push({
      d: { leaf: { kind: "person", name: "", label: "Existing contact owner (notified)" }, path: ["contact-owner"] },
      resolved: { ownerId: contact.ownerId, source: "contact-owner" },
      routingRepCode: targets[0]?.routingRepCode ?? null,
    });
  }

  // Idempotency: owners who already have a lead for this contact + campaign are
  // skipped, so queue retries / workflow re-enrollments only fill in what's missing.
  let dedupedExisting = 0;
  const already = await existingCampaignLeadOwners(token, contactId, body.campaignName ?? "", signal);
  if (already.size) {
    const before = targets.length;
    targets = targets.filter((t) => !(t.resolved.ownerId && already.has(t.resolved.ownerId)));
    dedupedExisting = before - targets.length;
  }

  // Resolve each target owner's display name once (for the co-owners field on fan-out).
  const ownerNames = await Promise.all(
    targets.map((t) => (t.resolved.ownerId ? ownerName(token, t.resolved.ownerId, signal) : Promise.resolve(""))),
  );

  // Create a Lead per target owner (non-fatal per lead).
  const leads: ResolvedLead[] = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    // The other reps this attendee was routed to (HubSpot allows no lead↔lead link).
    const coOwners = ownerNames.filter((n, j) => j !== i && n).join(", ");
    let leadId: string | null = null;
    let leadError: string | null = null;
    let associations = { contact: false, repCode: false, campaign: false };
    if (t.resolved.ownerId && !body.dryRun) {
      try {
        const r = await createLead(token, t.resolved.ownerId, body, contact, contactId, t.routingRepCode ?? "", coOwners, leadNotesText, marketingEventId, leadType, signal);
        leadId = r.leadId;
        associations = { contact: r.contact, repCode: r.repCode, campaign: r.campaign };
      } catch (e) {
        leadError = e instanceof Error ? e.message : String(e);
        console.error(`[event-lead] ${contactId} lead create failed:`, leadError);
      }
    }
    leads.push({
      leafLabel: t.d.leaf.kind === "fallback" ? t.d.leaf.reason : t.d.leaf.label,
      decisionPath: t.d.path,
      ownerId: t.resolved.ownerId,
      ownerSource: t.resolved.source,
      routingRepCode: t.routingRepCode,
      leadId,
      leadError,
      associations,
    });
  }

  // Visible timeline note (on the contact — every lead record surfaces it): who got a
  // lead when it was shared across owners, plus the fresh at-show notes. Non-fatal.
  if (!body.dryRun && leads.some((l) => l.leadId) && (targets.length > 1 || leadNotesText)) {
    const title = body.campaignName ? `Event lead routing — ${body.campaignName}` : "Event lead routing";
    const who = targets
      .map((t, j) =>
        ownerNames[j]
          ? `${ownerNames[j]} — ${t.d.leaf.kind === "fallback" ? t.d.leaf.reason : t.d.leaf.label}`
          : null,
      )
      .filter(Boolean) as string[];
    const parts: string[] = [];
    parts.push(
      targets.length > 1
        ? `<strong>${title}</strong><br>Leads created for:<br>• ${who.join("<br>• ")}`
        : `<strong>${title}</strong>`,
    );
    if (leadNotesText) parts.push(`<strong>At-show notes</strong> ${leadNotesText}`);
    const noted = await attachRoutingNote(token, contactId, parts.join("<br><br>"), signal).catch(() => false);
    if (!noted) console.error(`[event-lead] ${contactId}: routing note failed`);
  }

  // Set the contact owner only when it's empty AND there's a single owner (an unknown-
  // brand fan-out has several reps, so there's no one contact owner to choose).
  let contactOwnerAction: EventLeadResult["contactOwnerAction"] = "skipped_no_owner";
  if (!body.dryRun) {
    if (contact.ownerId) {
      contactOwnerAction = "skipped_existing";
    } else if (targets.length > 1) {
      contactOwnerAction = "skipped_multiple";
    } else if (targets[0]?.resolved.ownerId) {
      const patch = await hs(
        token,
        "PATCH",
        `${PATHS.contactLookup}${encodeURIComponent(contactId)}`,
        { properties: { hubspot_owner_id: targets[0].resolved.ownerId } },
        signal,
      );
      contactOwnerAction = patch.ok ? "set" : "skipped_no_owner";
    }
  }

  return {
    contactId,
    nationalAccount,
    campaignName: body.campaignName ?? null,
    leadNotes: leadNotesText || null,
    leadType,
    dedupedExisting,
    leads,
    contactOwnerAction,
  };
}
