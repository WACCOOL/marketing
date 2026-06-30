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
  CHANNEL_TO_CONTACT_PROP,
  CONTACT_REP_CODE_PROPS,
  PROJECT_FOCUS_PROP,
  type LeadFacts,
  type Leaf,
  type LeadDecision,
} from "@wac/shared";
import type { Env } from "./env.js";
import { serviceSupabase } from "./supabase.js";
import { hs, PATHS, REP_OBJECT, resolveOwnerByName } from "./hubspotPush.js";
import { emailDomain, isNationalAccountDomain, NATIONAL_ACCOUNT_PROP } from "./nationalAccounts.js";
import { classifyProjectFocus } from "./projectFocus.js";

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

/** Contact properties that drive routing. */
const CONTACT_PROPS = {
  /** Canada / International / North America bucket. `global_region` is NA-vs-Intl. */
  region: "global_region",
  /** Two-letter country code (CA distinguishes Canada). */
  countryCode: "hs_country_region_code",
  country: "country",
  /** Persona enum (Interior Designer / Architect / Contractor / …). */
  role: "your_role",
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
  pipeline: "lead-pipeline-id",
  stage: "new-stage-id",
  contactToLeadTypeId: 578,
  repCodeAssocTypeId: 194,
  /** Campaign CRM object (0-35) + native lead→campaign association (HUBSPOT_DEFINED). */
  campaignObjectType: "0-35",
  campaignAssocTypeId: 2741,
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
  /** One per distinct owner. Multiple only when the brand was unknown (fan-out). */
  leads: ResolvedLead[];
  contactOwnerAction: "set" | "skipped_existing" | "skipped_no_owner" | "skipped_multiple";
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
    ...Object.values(BRAND_SCORE_PROP),
    ...CONTACT_REP_CODE_PROPS,
  ];
  const res = await hs(
    token,
    "GET",
    `${PATHS.contactLookup}${encodeURIComponent(contactId)}?properties=${props.join(",")}`,
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
  /** Raw company props, reused to skip a refetch in the just-in-time classifier. */
  props: Record<string, string | null>;
}

/** Read the contact's primary associated company's sub_type, NA flag, and project focus. */
async function fetchCompany(
  token: string,
  contactId: string,
  signal: AbortSignal,
): Promise<CompanyFacts | null> {
  const assoc = await hs(
    token,
    "GET",
    `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/companies?limit=10`,
    undefined,
    signal,
  );
  if (!assoc.ok) return null;
  const companyId = String(assoc.data?.results?.[0]?.toObjectId ?? assoc.data?.results?.[0]?.id ?? "");
  if (!companyId) return null;
  const res = await hs(
    token,
    "GET",
    `${PATHS.companyLookup}${encodeURIComponent(companyId)}?properties=company_sub_type_simplified,company_sub_type,${NATIONAL_ACCOUNT_PROP},${PROJECT_FOCUS_PROP}`,
    undefined,
    signal,
  );
  if (!res.ok) return null;
  const p = (res.data?.properties ?? {}) as Record<string, string | null>;
  // Prefer the clean simplified taxonomy; fall back to the legacy sub_type.
  const subType = (p.company_sub_type_simplified ?? "").trim() || (p.company_sub_type ?? "").trim();
  return {
    companyId,
    subType,
    nationalAccount: (p[NATIONAL_ACCOUNT_PROP] ?? "").toLowerCase() === "true",
    projectFocus: (p[PROJECT_FOCUS_PROP] ?? "").trim(),
    props: p,
  };
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
  try {
    const r = await classifyProjectFocus(env, serviceSupabase(env), {
      companyId: company.companyId,
      source: "event-lead",
      signal,
      write: !dryRun,
      properties: company.props,
    });
    return r.value;
  } catch (e) {
    console.error("[event-lead] just-in-time project-focus classify failed:", e);
    return null;
  }
}

/** Map the contact's region/country props to the tree's Location bucket. */
function locationFact(c: ContactFacts): string {
  if (c.countryCode.toUpperCase() === "CA" || /\bcanada\b/i.test(c.country)) return "Canada";
  // global_region is "North America" / "International"; normalizeLocation handles it.
  if (c.region) return c.region;
  if (c.countryCode.toUpperCase() === "US") return "North America";
  return c.country || "";
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

  const create = await hs(token, "POST", PATHS.leadCreate, { properties, associations }, signal);
  if (!create.ok) {
    throw new Error(`lead create ${create.status}: ${JSON.stringify(create.data).slice(0, 200)}`);
  }
  const leadId = String(create.data?.id ?? "") || null;
  return { leadId, contact: !!leadId, repCode: !!(leadId && repObj.id), campaign: !!(leadId && campId) };
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

  const contact = await fetchContact(token, contactId, signal);

  // National-account override (checked first): email domain OR associated company flag.
  const naByDomain = await isNationalAccountDomain(env, emailDomain(contact.email));
  const company = await fetchCompany(token, contactId, signal);
  const nationalAccount = naByDomain.match || company?.nationalAccount === true;

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
    // Just-in-time project-focus classify: if the company is an interior designer with
    // no project_focus yet, classify it now (writes to the company unless dryRun) so the
    // first attendee routes correctly instead of defaulting to Residential.
    const projectFocus = await resolveProjectFocus(env, company, body.dryRun ?? false, signal);
    const facts: LeadFacts = {
      location: locationFact(contact),
      country: contact.country,
      role: contact.role,
      companySubType: company?.subType ?? null,
      // Brand from the campaign; fall back to the contact's top brand lead score.
      brand: body.campaignBrand ?? brandFromScores(contact.brandScores),
      projectFocus,
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
  const targets = pool.filter((e) => {
    const k = `${e.resolved.ownerId ?? ""}|${e.routingRepCode ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

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
        const r = await createLead(token, t.resolved.ownerId, body, contact, contactId, t.routingRepCode ?? "", coOwners, signal);
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

  return { contactId, nationalAccount, leads, contactOwnerAction };
}
