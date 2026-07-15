import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildDealDescription,
  completionDateMs,
  decideMaterialBankRouting,
  evaluateLeadOwnership,
  fullProjectAddress,
  leadFactsFromMaterialBank,
  materialBankProjectCategory,
  parseBudgetAmount,
  smartMatchToAllowedOptions,
  UNIVERSAL_PIPELINE_ID,
  DEAL_STAGE_IDS,
  type FixAction,
  type MaterialBankOrder,
  type MaterialBankProjectCategory,
} from "@wac/shared";
import type { Env } from "./env.js";
import { serviceSupabase } from "./supabase.js";
import {
  ASSOC,
  batchAssociate,
  GENERIC_DOMAINS,
  getContactByEmailExact,
  hs,
  PATHS,
  withHeal,
} from "./hubspotPush.js";
import { FALLBACK_OWNER_ID, PERSON_OWNER_ID, repCodeObject, resolveLeaf } from "./eventLead.js";
import { emailDomain, isNationalAccountDomain } from "./nationalAccounts.js";
import { classifyProjectFocusForSite } from "./projectFocus.js";
import { lookupRepCodesByZip } from "./routes/repCodes.js";
import { loadOptions } from "./hubspotHeal.js";
import { geminiTextWithUsage } from "./gemini.js";

/**
 * Material Bank order → HubSpot orchestrator (replaces the Make.com scenario
 * "Material Bank Contacts and Projects to Deals").
 *
 * The apps/material-bank-sync CLI pulls XML order files from Material Bank's
 * SFTP and POSTs one typed order at a time to /api/hubspot/material-bank/sync
 * (routes/materialBank.ts). Per order this module:
 *
 *   1. dedupes — by `material_bank_order_id`, then by dealname + project
 *      address + associated contact. A match that carries an SAP quote number
 *      is SAP's deal: skipped untouched. Any other match is UPDATED gently
 *      (blank properties filled, missing line items added, owner set only if
 *      unowned) — never overwritten;
 *   2. finds-or-creates the contact by EXACT email (the Make scenario's fuzzy
 *      `query` search + ignore-errors combo silently dropped contacts,
 *      especially gmail addresses; property validation errors now go through
 *      the shared heal loop instead of vanishing);
 *   3. routes the deal/contact owner: national-account domains → Sara Kruid,
 *      designer practices per {@link decideMaterialBankRouting} (Kalin/Rudy,
 *      with a website+Gemini residential-vs-commercial verification for
 *      both-labeled firms), everything else through the standard lead tree
 *      with rep codes resolved from the contact ZIP;
 *   4. creates the deal (Universal pipeline, Pre-Qualified) + SKU line items
 *      + associations, classifies `project_type` with Gemini against the
 *      cached HubSpot enum, and sets the contact owner only when blank.
 *
 * Everything is idempotent so the CLI can safely retry a file. `dryRun` walks
 * the entire decision path (searches, routing, classification) without writing.
 */

const KALIN = PERSON_OWNER_ID["Kalin Scott"]!;
const RUDY = PERSON_OWNER_ID["Rudy Soni"]!;
const SARA = PERSON_OWNER_ID["Sara Kruid"]!;

/** Deal property carrying Material Bank's order id (the dedupe key). */
const ORDER_ID_PROP = "material_bank_order_id";
/** Deals synced from SAP carry this — such a deal is SAP's, never ours to touch. */
const SAP_QUOTE_PROP = "sap_quote_number";

/** Deal properties we read for dedupe + fill-blanks decisions. */
const DEAL_READ_PROPS = [
  SAP_QUOTE_PROP,
  ORDER_ID_PROP,
  "dealname",
  "project_location",
  "requested_by",
  "amount",
  "estimated_onsite_date",
  "description",
  "marketing_source",
  "project_type",
  "hubspot_owner_id",
  // sales_group: a HubSpot workflow stamps the territory rep code onto new
  // deals; the repair path uses it to recognize owners set by the territory
  // re-owner (see reownActiveDealsForRepCode) as machine-set and correctable.
  "sales_group",
];

export interface MaterialBankOutcome {
  orderId: string;
  status: "created" | "updated" | "skipped_sap" | "unchanged" | "error";
  dealId: string | null;
  contactId: string | null;
  contactCreated: boolean;
  ownerId: string | null;
  ownerSource: string;
  /** Which dedupe rule matched, when a deal already existed. */
  matchedBy: "order_id" | "name_address_contact" | null;
  projectType: string | null;
  lineItemsCreated: number;
  lineItemsExisting: number;
  contactOwnerAction: "set" | "repaired" | "skipped_existing" | "skipped_no_contact" | "skipped_no_owner" | "dry_run";
  filledProps: string[];
  fixActions: (FixAction & { scope?: string })[];
  dryRun: boolean;
  error?: string;
}

/**
 * Prior recorded outcome for an order — the ledger the repair mode trusts.
 * Repair overwrites an owner ONLY when the ledger shows this sync set it AND
 * the record still carries exactly that value (i.e. no human changed it since).
 */
interface PriorOutcome {
  ownerId: string | null;
  dealOwnerWasSetByUs: boolean;
  contactOwnerWasSetByUs: boolean;
}

async function loadPriorOutcome(sb: SupabaseClient, orderId: string): Promise<PriorOutcome | null> {
  const { data } = await sb
    .from("material_bank_outcomes")
    .select("owner_id, status, contact_owner_action, actions")
    .eq("order_id", orderId)
    .maybeSingle();
  if (!data) return null;
  const filled = (data.actions as { filledProps?: string[] } | null)?.filledProps ?? [];
  return {
    ownerId: str(data.owner_id),
    // Created deals get their owner at creation (filledProps only tracks the
    // update path), so "created" also counts as owner-set-by-us.
    dealOwnerWasSetByUs: filled.includes("hubspot_owner_id") || data.status === "created",
    contactOwnerWasSetByUs: data.contact_owner_action === "set" || data.contact_owner_action === "repaired",
  };
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}

/** Loose address identity: lowercase alphanumerics only. */
function addressKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface FoundDeal {
  id: string;
  properties: Record<string, unknown>;
  matchedBy: "order_id" | "name_address_contact";
}

/** Dedupe rule 1: a deal already carrying this Material Bank order id. */
async function findDealByOrderId(
  token: string,
  orderId: string,
  signal: AbortSignal,
): Promise<FoundDeal | null> {
  const res = await hs(
    token,
    "POST",
    PATHS.dealSearch,
    {
      filterGroups: [{ filters: [{ propertyName: ORDER_ID_PROP, operator: "EQ", value: orderId }] }],
      properties: DEAL_READ_PROPS,
      limit: 1,
    },
    signal,
  );
  if (!res.ok) throw new Error(`deal search by ${ORDER_ID_PROP} ${res.status}`);
  const r = res.data?.results?.[0];
  return r ? { id: String(r.id), properties: r.properties ?? {}, matchedBy: "order_id" } : null;
}

/**
 * Dedupe rule 2: same deal name + same project address + same associated
 * contact email. All three must line up — a name collision alone is not a match.
 */
async function findDealByNameAddressContact(
  token: string,
  order: MaterialBankOrder,
  signal: AbortSignal,
): Promise<FoundDeal | null> {
  const name = order.project.name;
  const email = order.contact.email;
  const address = fullProjectAddress(order);
  if (!name || !email || !address) return null;

  const res = await hs(
    token,
    "POST",
    PATHS.dealSearch,
    {
      filterGroups: [{ filters: [{ propertyName: "dealname", operator: "EQ", value: name }] }],
      properties: DEAL_READ_PROPS,
      limit: 10,
    },
    signal,
  );
  if (!res.ok) throw new Error(`deal search by dealname ${res.status}`);

  const wantAddress = addressKey(address);
  for (const r of res.data?.results ?? []) {
    const loc = str(r?.properties?.project_location);
    if (!loc || addressKey(loc) !== wantAddress) continue;
    // Same address + name — require the same contact too.
    const assoc = await hs(token, "GET", `/crm/v4/objects/0-3/${r.id}/associations/contacts`, undefined, signal);
    const contactIds = (assoc.ok ? assoc.data?.results ?? [] : [])
      .map((a: any) => String(a?.toObjectId ?? ""))
      .filter(Boolean);
    if (!contactIds.length) continue;
    const read = await hs(
      token,
      "POST",
      "/crm/v3/objects/contacts/batch/read",
      { properties: ["email"], inputs: contactIds.map((id: string) => ({ id })) },
      signal,
    );
    const emails = (read.ok ? read.data?.results ?? [] : []).map((c: any) =>
      String(c?.properties?.email ?? "").toLowerCase(),
    );
    if (emails.includes(email)) {
      return { id: String(r.id), properties: r.properties ?? {}, matchedBy: "name_address_contact" };
    }
  }
  return null;
}

/* ------------------------------ project_type ------------------------------ */

/**
 * Classify the HubSpot deal `project_type` from the order's project info,
 * against the live enum (cached daily in hubspot_property_options by
 * refreshHubspotOptions — never a hardcoded list). Ported from the Make
 * scenario's GPT prompt; abstains (null) when the enum cache is empty, the
 * model is unsure, or its answer doesn't match an allowed option.
 */
export async function classifyProjectType(
  env: Env,
  sb: SupabaseClient,
  order: MaterialBankOrder,
): Promise<string | null> {
  if (!env.GEMINI_API_KEY) return null;
  const options = (await loadOptions(sb, "deals")).get("project_type");
  const allowed = (options ?? []).map((o) => o.value);
  if (!allowed.length) return null;

  const system = [
    "You are a strict classification function: select which deal project type most closely matches the information provided.",
    "",
    `ALLOWED OPTIONS:\n${allowed.join(", ")}`,
    "",
    "How to decide (prioritize the most specific match):",
    "- RESIDENTIAL: MULTI-FAMILY for apartments/condo buildings/multifamily/student housing/dormitories; PRIVATE RESIDENCE for single-family homes/villas/private residences.",
    "- HOSPITALITY: ASSISTED LIVING (senior living, memory care, nursing homes); CASINO; HOTEL (hotels, resorts, motels, inns); BARS & RESTAURANT (restaurants, bars, cafes). If both hotel and restaurant appear, choose HOTEL unless it is clearly only a restaurant.",
    "- RETAIL: SHOPPING CENTER (malls, plazas); SUPERMARKET (grocery); DEPARTMENT STORE; DISCOUNT STORE (outlets); CLOTHING (apparel, boutiques); JEWELRY; SPECIALITY STORE (other clearly-retail stores).",
    "- COMMUNITY: ART GALLERY; MUSEUMS; LIBRARY; RELIGIOUS AUDITORIUMS (churches, temples, mosques); FIRE AND POLICE STATIONS; POST OFFICE; PARK FACILITY; SPORT ARENA / CONVENTION CEN (arenas, stadiums, convention centers); CLUB (GOLF COURSE/COUNTRY (country/golf clubs).",
    "- COMMERCIAL: MILITARY (bases, armories); MEDICAL (hospitals, clinics, healthcare); LABORATORIES; SCHOOL (schools, universities — dorms prefer RESIDENTIAL - MULTI-FAMILY); TRANSPORTATION TERMINAL (airports, stations); OFFICES (offices, HQs); BANK (banks, credit unions); GARAGE (parking structures); MANUFACTURE (factories, plants, industrial warehouses); BRIDGE AND CULVERT; AUTOMOTIVE (dealerships, auto service).",
    "",
    "Tie-breakers: choose the primary use of the building/project. Mixed-use with no clear primary use, or insufficient/ambiguous information → the OTHER option.",
    "",
    'Respond with JSON ONLY: {"project_type": "<exactly one allowed option>", "confidence": <0..1>}.',
  ].join("\n");

  const lines = [
    `Deal Name: ${order.project.name ?? ""}`,
    `Type: ${order.project.type ?? ""}`,
    `Description: ${order.project.description ?? ""}`,
    `Project Phase: ${order.project.phase ?? ""}`,
    `Company Name: ${order.company.name ?? ""}`,
    `Company Practice: ${order.company.practice ?? ""}`,
    `Location: ${fullProjectAddress(order)}`,
  ];

  try {
    const model = env.CLASSIFY_MODEL || env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
    const r = await geminiTextWithUsage(env, {
      prompt: `Classify this deal:\n${lines.join("\n")}`,
      system,
      json: true,
      model,
      temperature: 0,
      timeoutMs: 20_000,
    });
    const parsed = JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] ?? "null") as {
      project_type?: unknown;
      confidence?: unknown;
    } | null;
    const answer = str(parsed?.project_type);
    const confidence = Number(parsed?.confidence);
    if (!answer || (Number.isFinite(confidence) && confidence < 0.5)) return null;
    return smartMatchToAllowedOptions(answer, allowed);
  } catch {
    return null;
  }
}

/* ------------------------------ owner routing ------------------------------ */

/**
 * The website to verify a designer against: the contact's email domain when it
 * isn't a free-mail provider, else the unique HubSpot company (by exact name)
 * that has a domain/website.
 */
async function resolveCompanyWebsite(
  token: string,
  order: MaterialBankOrder,
  signal: AbortSignal,
): Promise<string | null> {
  const domain = emailDomain(order.contact.email);
  if (domain && !GENERIC_DOMAINS.has(domain)) return domain;

  const name = order.company.name;
  if (!name) return null;
  const res = await hs(
    token,
    "POST",
    PATHS.companySearch,
    {
      filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: name }] }],
      properties: ["domain", "website"],
      limit: 2,
    },
    signal,
  );
  const results = res.ok ? res.data?.results ?? [] : [];
  if (results.length !== 1) return null; // ambiguous or unknown company — no site to trust
  return str(results[0]?.properties?.website) ?? str(results[0]?.properties?.domain);
}

/** Per-channel rep codes covering the contact's ZIP ({} when unknown). */
async function zipRepCodes(env: Env, order: MaterialBankOrder): Promise<Record<string, string>> {
  if (!order.address.zip) return {};
  try {
    return (await lookupRepCodesByZip(env, order.address.zip)).byChannel;
  } catch (e) {
    console.error(`[material-bank] rep-code zip lookup failed:`, e);
    return {};
  }
}

/**
 * The spec rep covering the contact's ZIP (WAC Spec first — Material Bank
 * carries no brand — then MF Spec); unresolvable → Lana via resolveLeaf.
 */
async function resolveSpecOwner(
  env: Env,
  token: string,
  order: MaterialBankOrder,
  signal: AbortSignal,
): Promise<{ ownerId: string; source: string }> {
  const repCodes = await zipRepCodes(env, order);
  const channel = repCodes["WAC Spec"] ? "WAC Spec" : "MF Spec";
  const resolved = await resolveLeaf(
    env,
    token,
    { kind: "repCode", channel, resolve: "owner", label: `spec by ZIP (${channel})` },
    { repCodes },
    undefined,
    signal,
  );
  return { ownerId: resolved.ownerId ?? FALLBACK_OWNER_ID, source: `spec:${resolved.source}` };
}

async function routeOwner(
  env: Env,
  token: string,
  order: MaterialBankOrder,
  opts: { contactOwnerId: string | null; projectCategory: MaterialBankProjectCategory },
  signal: AbortSignal,
): Promise<{ ownerId: string; source: string }> {
  // 0. Contact-owner-first: a known contact owner ALWAYS gets the deal —
  //    unless that owner is Lana (the manual-triage bucket routes normally).
  if (opts.contactOwnerId && opts.contactOwnerId !== FALLBACK_OWNER_ID) {
    return { ownerId: opts.contactOwnerId, source: `contact-owner:${opts.contactOwnerId}` };
  }

  // 1. National-account override, like the event-lead flow.
  const domain = emailDomain(order.contact.email);
  if (domain && (await isNationalAccountDomain(env, domain)).match) {
    return { ownerId: SARA, source: `national-account:${domain}` };
  }

  // 2. Designer rules (project signal → practice label → website verify).
  const routing = decideMaterialBankRouting(order.company.practice, opts.projectCategory);
  if (routing.kind === "kalin") return { ownerId: KALIN, source: `designer:${routing.reason}` };
  if (routing.kind === "rudy") return { ownerId: RUDY, source: `designer:${routing.reason}` };
  if (routing.kind === "lana") return { ownerId: FALLBACK_OWNER_ID, source: `lana:${routing.reason}` };
  if (routing.kind === "spec") {
    const spec = await resolveSpecOwner(env, token, order, signal);
    return { ...spec, source: `${spec.source} (${routing.reason})` };
  }

  if (routing.kind === "verify") {
    const site = await resolveCompanyWebsite(token, order, signal);
    if (site) {
      const verdict = await classifyProjectFocusForSite(env, {
        name: order.company.name,
        website: site,
      });
      if (verdict.focus) {
        const conf = `conf ${verdict.confidence ?? "?"}`;
        if (verdict.hospitality) {
          return { ownerId: RUDY, source: `designer-verified:hospitality:${site} (${conf})` };
        }
        if (verdict.focus.includes("Commercial")) {
          const spec = await resolveSpecOwner(env, token, order, signal);
          return { ...spec, source: `designer-verified:commercial→${spec.source}:${site} (${conf})` };
        }
        return { ownerId: KALIN, source: `designer-verified:residential:${site} (${conf})` };
      }
    }
    // Can't tell residential vs commercial → manual triage.
    return { ownerId: FALLBACK_OWNER_ID, source: `designer-unverifiable:lana:${site ?? "no-site"}` };
  }

  // 3. Standard lead-ownership tree; rep-code leaves resolve from the contact ZIP.
  const decision = evaluateLeadOwnership(leadFactsFromMaterialBank(order, opts.projectCategory));
  const repCodes = await zipRepCodes(env, order);
  const resolved = await resolveLeaf(env, token, decision.leaf, { repCodes }, undefined, signal);
  return {
    ownerId: resolved.ownerId ?? FALLBACK_OWNER_ID,
    source: `tree:${decision.path.join(" → ")}:${resolved.source}`,
  };
}

/* --------------------------------- contact --------------------------------- */

/** Make's name split: first token → firstname, the rest → lastname. */
function splitName(name: string | null): { firstname?: string; lastname?: string } {
  const m = (name ?? "").trim().match(/^(\S+)\s+(.+)$/);
  if (!m) return name?.trim() ? { firstname: name.trim() } : {};
  return { firstname: m[1]!, lastname: m[2]! };
}

function newContactProps(order: MaterialBankOrder, ownerId: string | null): Record<string, unknown> {
  const props: Record<string, unknown> = {
    email: order.contact.email,
    ...splitName(order.contact.name),
    contact_import_source: "Material Bank",
    hs_latest_source: "REFERRALS",
  };
  if (order.contact.phone) props.phone = order.contact.phone;
  if (order.contact.mobilePhone) props.mobilephone = order.contact.mobilePhone;
  if (order.contact.preference) props.contact_preference = order.contact.preference;
  if (order.contact.title) props.jobtitle = order.contact.title;
  if (order.company.name) props.company = order.company.name;
  if (order.company.practice) props.company_sub_type = order.company.practice;
  if (order.address.street1) props.address = order.address.street1;
  if (order.address.city) props.city = order.address.city;
  if (order.address.state) props.state = order.address.state;
  if (order.address.zip) props.zip = order.address.zip;
  if (order.address.country) props.country = order.address.country;
  if (ownerId) props.hubspot_owner_id = ownerId;
  return props;
}

/* -------------------------------- line items ------------------------------- */

/** SKUs already on the deal (so an update run only adds what's missing). */
async function existingDealSkus(token: string, dealId: string, signal: AbortSignal): Promise<Set<string>> {
  const assoc = await hs(token, "GET", `/crm/v4/objects/0-3/${dealId}/associations/line_items`, undefined, signal);
  const ids = (assoc.ok ? assoc.data?.results ?? [] : [])
    .map((a: any) => String(a?.toObjectId ?? ""))
    .filter(Boolean);
  if (!ids.length) return new Set();
  const read = await hs(
    token,
    "POST",
    "/crm/v3/objects/line_items/batch/read",
    { properties: ["hs_sku", "name"], inputs: ids.map((id: string) => ({ id })) },
    signal,
  );
  const skus = new Set<string>();
  for (const r of read.ok ? read.data?.results ?? [] : []) {
    const sku = str(r?.properties?.hs_sku) ?? str(r?.properties?.name);
    if (sku) skus.add(sku);
  }
  return skus;
}

async function createLineItems(
  token: string,
  dealId: string,
  lines: MaterialBankOrder["lines"],
  signal: AbortSignal,
): Promise<number> {
  if (!lines.length) return 0;
  const inputs = lines.map((l) => ({
    properties: {
      name: l.sku,
      hs_sku: l.sku,
      ...(l.quantity != null ? { quantity: String(l.quantity) } : {}),
      ...(l.color ? { description: l.color } : {}),
      material_description: [l.sku, l.color].filter(Boolean).join(" "),
    },
  }));
  const res = await hs(token, "POST", "/crm/v3/objects/line_items/batch/create", { inputs }, signal);
  if (!res.ok) throw new Error(`line-item batch create ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  const created = (res.data?.results ?? []).map((r: any) => String(r.id));
  await batchAssociate(
    token,
    PATHS.lineItemToDeal,
    ASSOC.lineItemToDeal,
    created.map((id: string) => ({ fromId: id, toId: dealId })),
    signal,
  );
  return created.length;
}

/* -------------------------------- orchestrator ----------------------------- */

async function recordOutcome(sb: SupabaseClient, o: MaterialBankOutcome): Promise<void> {
  if (o.dryRun) return;
  const { error } = await sb.from("material_bank_outcomes").upsert(
    {
      order_id: o.orderId,
      status: o.status,
      deal_id: o.dealId,
      contact_id: o.contactId,
      contact_created: o.contactCreated,
      owner_id: o.ownerId,
      owner_source: o.ownerSource,
      matched_by: o.matchedBy,
      project_type: o.projectType,
      line_items_created: o.lineItemsCreated,
      contact_owner_action: o.contactOwnerAction,
      actions: { filledProps: o.filledProps, fixActions: o.fixActions },
      error: o.error ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "order_id" },
  );
  if (error) console.error("[material-bank] outcome upsert failed:", error.message);
}

export async function processMaterialBankOrder(
  env: Env,
  order: MaterialBankOrder,
  opts: { dryRun?: boolean; repair?: boolean },
  signal: AbortSignal,
): Promise<MaterialBankOutcome> {
  const dryRun = !!opts.dryRun;
  const repair = !!opts.repair && !dryRun;
  const sb = serviceSupabase(env);
  const outcome: MaterialBankOutcome = {
    orderId: order.orderId,
    status: "error",
    dealId: null,
    contactId: null,
    contactCreated: false,
    ownerId: null,
    ownerSource: "",
    matchedBy: null,
    projectType: null,
    lineItemsCreated: 0,
    lineItemsExisting: 0,
    contactOwnerAction: dryRun ? "dry_run" : "skipped_no_contact",
    filledProps: [],
    fixActions: [],
    dryRun,
  };

  const token = env.HUBSPOT_TOKEN;
  if (!token) {
    outcome.error = "HUBSPOT_TOKEN not configured";
    return outcome;
  }

  try {
    // 1. Dedupe.
    const existing =
      (await findDealByOrderId(token, order.orderId, signal)) ??
      (await findDealByNameAddressContact(token, order, signal));
    if (existing) {
      outcome.matchedBy = existing.matchedBy;
      outcome.dealId = existing.id;
      if (str(existing.properties[SAP_QUOTE_PROP])) {
        outcome.status = "skipped_sap";
        outcome.ownerSource = "skipped: deal has an SAP quote number";
        await recordOutcome(sb, outcome);
        return outcome;
      }
    }

    // 2. Contact (exact email; create through the heal loop when missing).
    const email = order.contact.email;
    let contactId: string | null = null;
    let contactOwnerId: string | null = null;
    if (email) {
      const found = await getContactByEmailExact(token, email, signal);
      if (found) {
        contactId = found.id;
        const rec = await hs(
          token,
          "GET",
          `${PATHS.contactLookup}${encodeURIComponent(contactId)}?properties=hubspot_owner_id`,
          undefined,
          signal,
        );
        contactOwnerId = rec.ok ? str(rec.data?.properties?.hubspot_owner_id) : null;
      }
    }
    outcome.contactId = contactId;

    // 3. project_type — classified BEFORE routing (the project's category
    // drives the designer rules). An existing deal's value is reused; Gemini
    // only runs when there's nothing on record.
    const existingProjectType = existing ? str(existing.properties.project_type) : null;
    if (!existingProjectType) {
      outcome.projectType = await classifyProjectType(env, sb, order);
    }
    const projectCategory = materialBankProjectCategory(
      order,
      existingProjectType ?? outcome.projectType,
    );

    // 4. Owner routing (used by contact create, deal create, and gentle update).
    const { ownerId, source } = await routeOwner(
      env,
      token,
      order,
      { contactOwnerId, projectCategory },
      signal,
    );
    outcome.ownerId = ownerId;
    outcome.ownerSource = source;

    if (email && !contactId && !dryRun) {
      const res = await withHeal(token, signal, "contact", outcome.fixActions, newContactProps(order, ownerId), (p) =>
        hs(token, "POST", "/crm/v3/objects/contacts", { properties: p }, signal),
      ).catch(async (e) => {
        // 409 = created concurrently — re-fetch by email.
        const again = await getContactByEmailExact(token, email, signal);
        if (again) return { ok: true, status: 200, data: { id: again.id } };
        throw e;
      });
      contactId = str(res.data?.id);
      outcome.contactId = contactId;
      outcome.contactCreated = !!contactId;
      contactOwnerId = ownerId; // set at creation
      outcome.contactOwnerAction = "set";
    }

    // 5. Deal write.
    const dealProps: Record<string, unknown> = {
      dealname: order.project.name ?? `Material Bank ${order.orderId}`,
      project_location: fullProjectAddress(order) || undefined,
      requested_by: email ?? undefined,
      amount: parseBudgetAmount(order.project.budgetRaw) ?? undefined,
      estimated_onsite_date:
        completionDateMs(order.project.completionMonth, order.project.completionYear) ?? undefined,
      description: buildDealDescription(order) || undefined,
      marketing_source: "Material Bank",
      [ORDER_ID_PROP]: order.orderId,
      project_type: outcome.projectType ?? undefined,
      hubspot_owner_id: ownerId,
    };
    for (const k of Object.keys(dealProps)) dealProps[k] === undefined && delete dealProps[k];

    if (!existing) {
      // CREATE
      if (!dryRun) {
        const res = await withHeal(
          token,
          signal,
          "deal",
          outcome.fixActions,
          {
            ...dealProps,
            pipeline: UNIVERSAL_PIPELINE_ID,
            dealstage: DEAL_STAGE_IDS.prequal,
            hs_analytics_source: "OTHER_CAMPAIGNS", // settable at create only
          },
          (p) => hs(token, "POST", "/crm/v3/objects/0-3", { properties: p }, signal),
        );
        outcome.dealId = str(res.data?.id);
        if (outcome.dealId) {
          outcome.lineItemsCreated = await createLineItems(token, outcome.dealId, order.lines, signal);
          if (contactId) {
            await batchAssociate(
              token,
              PATHS.contactToDeal,
              ASSOC.contactToDeal,
              [{ fromId: contactId, toId: outcome.dealId }],
              signal,
            );
          }
        }
      }
      outcome.status = "created";
    } else {
      // GENTLE UPDATE — fill only blank properties; owner only when unowned.
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(dealProps)) {
        if (k === "dealname") continue; // never rename an existing deal
        if (!str(existing.properties[k])) patch[k] = v;
      }
      // REPAIR: overwrite a machine-set owner with the current routing
      // decision. Machine-set means the deal still carries EITHER the value
      // the ledger shows this sync wrote, OR the current owner of the rep
      // code in the deal's sales_group (the territory re-owner's value — see
      // reownActiveDealsForRepCode, which used to sweep MB deals). A value a
      // human picked matches neither and is never touched.
      const prior = repair ? await loadPriorOutcome(sb, order.orderId) : null;
      if (prior?.dealOwnerWasSetByUs && prior.ownerId && ownerId !== prior.ownerId) {
        const current = str(existing.properties.hubspot_owner_id);
        let machineSet = current === prior.ownerId;
        const salesGroup = str(existing.properties.sales_group);
        if (!machineSet && current && salesGroup) {
          const rep = await repCodeObject(token, salesGroup, signal).catch(() => null);
          machineSet = !!rep?.ownerId && current === rep.ownerId;
        }
        if (machineSet && current !== ownerId) patch.hubspot_owner_id = ownerId;
      }
      // Rudy-owned (hospitality) deals carry NO sales_group: hospitality stays
      // his even after an SAP quote number lands (territory ownership follows
      // sales_group from that moment — see reownActiveDealsForRepCode). The
      // stamping workflow fires at creation, so this clears it on revisits.
      if (
        ownerId === RUDY &&
        str(existing.properties.sales_group) &&
        (str(existing.properties.hubspot_owner_id) === RUDY || patch.hubspot_owner_id === RUDY)
      ) {
        patch.sales_group = "";
      }
      outcome.filledProps = Object.keys(patch);
      const existingSkus = await existingDealSkus(token, existing.id, signal);
      const missingLines = order.lines.filter((l) => !existingSkus.has(l.sku));
      outcome.lineItemsExisting = existingSkus.size;

      if (!dryRun) {
        if (Object.keys(patch).length) {
          await withHeal(token, signal, "deal", outcome.fixActions, patch, (p) =>
            hs(token, "PATCH", `/crm/v3/objects/0-3/${existing.id}`, { properties: p }, signal),
          );
        }
        outcome.lineItemsCreated = await createLineItems(token, existing.id, missingLines, signal);
        if (contactId) {
          await batchAssociate(
            token,
            PATHS.contactToDeal,
            ASSOC.contactToDeal,
            [{ fromId: contactId, toId: existing.id }],
            signal,
          );
        }
      } else if (missingLines.length) {
        outcome.lineItemsCreated = missingLines.length; // would-create count
      }
      outcome.status = outcome.filledProps.length || missingLines.length ? "updated" : "unchanged";
    }

    // 6. Contact owner — only when the contact exists and is unowned, plus the
    // repair case: the ledger shows we set it and it still holds our value.
    if (!dryRun && contactId && !outcome.contactCreated) {
      let repairContactOwner = false;
      if (contactOwnerId && repair) {
        const prior = await loadPriorOutcome(sb, order.orderId);
        repairContactOwner =
          !!prior?.contactOwnerWasSetByUs &&
          !!prior.ownerId &&
          contactOwnerId === prior.ownerId &&
          ownerId !== prior.ownerId;
      }
      if (contactOwnerId && !repairContactOwner) {
        outcome.contactOwnerAction = "skipped_existing";
      } else {
        const patch = await hs(
          token,
          "PATCH",
          `${PATHS.contactLookup}${encodeURIComponent(contactId)}`,
          { properties: { hubspot_owner_id: ownerId } },
          signal,
        );
        outcome.contactOwnerAction = patch.ok ? (repairContactOwner ? "repaired" : "set") : "skipped_no_owner";
      }
    }

    await recordOutcome(sb, outcome);
    return outcome;
  } catch (e) {
    outcome.status = "error";
    outcome.error = e instanceof Error ? e.message : String(e);
    await recordOutcome(sb, outcome);
    return outcome;
  }
}
