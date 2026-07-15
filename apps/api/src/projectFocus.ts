import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildProjectFocusPrompt,
  parseProjectFocus,
  projectFocusToValue,
  extractSiteSummary,
  inputsHash,
  normalizeCompanyType,
  siteLikelyUnrelated,
  PROJECT_FOCUS_PROP,
  type CompanyForClassify,
  type ProjectFocusValue,
} from "@wac/shared";
import type { Env } from "./env.js";
import { geminiTextWithUsage } from "./gemini.js";
import { hs, PATHS } from "./hubspotPush.js";

/**
 * Interior-designer "project focus" classifier (Worker side) — a simpler sibling
 * of {@link ./companyClassify}. Researches an interior-design company (fields +
 * website) and writes the multi-select `project_focus` (Residential and/or
 * Commercial), which drives the residential-vs-commercial split in lead routing.
 *
 * Differences from the sub-type classifier: gated to interior designers only,
 * fixed two-class output (no candidate set), and it ALWAYS writes a value
 * (defaults to Residential) rather than abstaining — so routing always has a value.
 *
 * Shared by the webhook (POST /api/hubspot/classify-project-focus), the backfill,
 * and the just-in-time call from the event-lead webhook.
 */

const WEBSITE_FETCH_TIMEOUT_MS = 8_000;
const WEBSITE_USER_AGENT = "WAC-Marketing-App/1.0 (+project-focus-classifier)";
const DEFAULT_MIN_CONFIDENCE = 0.6;
/** Commercial needs to be a real focus, so it's held to a higher bar than Residential. */
const DEFAULT_COMMERCIAL_MIN_CONFIDENCE = 0.8;
const DEDUP_WINDOW_MS = 2 * 60 * 1000;

const FETCH_PROPS =
  "name,description,industry,website,domain,company_sub_type_simplified,company_sub_type,project_focus";

export type ProjectFocusSource = "webhook" | "backfill" | "manual" | "event-lead" | "material-bank";

export type ProjectFocusStatus =
  | "classified"
  | "defaulted"
  | "already_set"
  | "skipped_not_designer"
  | "skipped_no_domain"
  | "skipped"
  | "error";

export interface ProjectFocusResult {
  companyId: string;
  status: ProjectFocusStatus;
  focus: ProjectFocusValue[] | null;
  /** Confident hospitality-focus verdict (null when not classified this run). */
  hospitality: boolean | null;
  value: string | null;
  confidence: number | null;
  wrote: boolean;
  promptTokens: number | null;
  outputTokens: number | null;
  reason?: string;
}

export interface ProjectFocusOptions {
  companyId: string;
  source: ProjectFocusSource;
  signal: AbortSignal;
  write?: boolean;
  /** Pre-fetched company properties (caller can pass to skip a GET). */
  properties?: Record<string, unknown>;
  scrapeWebsite?: boolean;
}

function minConfidence(env: Env): number {
  const v = Number(env.CLASSIFY_MIN_CONFIDENCE);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_MIN_CONFIDENCE;
}

/** Higher bar to mark a company Commercial — commercial must be a real focus, not a mention. */
function commercialMinConfidence(env: Env): number {
  const v = Number(env.PROJECT_FOCUS_COMMERCIAL_MIN);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_COMMERCIAL_MIN_CONFIDENCE;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}

async function fetchCompany(token: string, id: string, signal: AbortSignal) {
  const path = `${PATHS.companyLookup}${encodeURIComponent(id)}?properties=${FETCH_PROPS}`;
  const res = await hs(token, "GET", path, undefined, signal);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`company ${id} fetch ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  return (res.data?.properties ?? {}) as Record<string, unknown>;
}

async function writeFocus(token: string, id: string, value: string, signal: AbortSignal) {
  const res = await hs(
    token,
    "PATCH",
    `${PATHS.companyLookup}${encodeURIComponent(id)}`,
    { properties: { [PROJECT_FOCUS_PROP]: value } },
    signal,
  );
  if (!res.ok) throw new Error(`company ${id} patch ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
}

async function fetchWebsiteText(siteRaw: string): Promise<string | null> {
  const url = /^https?:\/\//i.test(siteRaw) ? siteRaw : `https://${siteRaw}`;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": WEBSITE_USER_AGENT, accept: "text/html" },
      signal: AbortSignal.timeout(WEBSITE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return extractSiteSummary(await res.text()) || null;
  } catch {
    return null;
  }
}

async function recentlyAttempted(sb: SupabaseClient, companyId: string): Promise<boolean> {
  const { data } = await sb
    .from("company_project_focus_classifications")
    .select("updated_at")
    .eq("company_id", companyId)
    .maybeSingle();
  if (!data?.updated_at) return false;
  return Date.now() - new Date(data.updated_at as string).getTime() < DEDUP_WINDOW_MS;
}

async function recordAttempt(
  sb: SupabaseClient,
  row: Record<string, unknown> & { company_id: string },
): Promise<void> {
  const { error } = await sb
    .from("company_project_focus_classifications")
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "company_id" });
  if (error) console.error("[project-focus] audit upsert failed:", error.message);
}

/** One Gemini classification pass. */
async function classifyPass(
  env: Env,
  company: CompanyForClassify,
  websiteText: string | null,
  model: string,
): Promise<{ parsed: ReturnType<typeof parseProjectFocus>; promptTokens: number; outputTokens: number }> {
  const { system, prompt } = buildProjectFocusPrompt({ company, websiteText });
  const r = await geminiTextWithUsage(env, { prompt, system, json: true, model, temperature: 0, timeoutMs: 20_000 });
  return {
    parsed: parseProjectFocus(r.text),
    promptTokens: r.usage?.promptTokens ?? 0,
    outputTokens: r.usage?.outputTokens ?? 0,
  };
}

export interface SiteFocusResult {
  /** null = unverifiable (site unreachable, or the model wasn't confident). */
  focus: ProjectFocusValue[] | null;
  /** True when hospitality work is a verified focus (only meaningful when focus != null). */
  hospitality: boolean;
  confidence: number | null;
  websiteFetched: boolean;
  promptTokens: number;
  outputTokens: number;
}

/**
 * Residential-vs-commercial verification for a firm that may not exist in HubSpot
 * (e.g. a Material Bank order's design firm): crawl the site and classify from its
 * actual content. The website IS the evidence here — no reachable site means no
 * verification, so `focus: null` (the caller applies its own unverifiable default).
 * Same confidence bars as {@link classifyProjectFocus}, including the higher
 * Commercial threshold.
 */
export async function classifyProjectFocusForSite(
  env: Env,
  input: { name: string | null; website: string },
): Promise<SiteFocusResult> {
  const model = env.PROJECT_FOCUS_MODEL || env.CLASSIFY_MODEL || env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
  const websiteText = await fetchWebsiteText(input.website);
  if (!websiteText) {
    return { focus: null, hospitality: false, confidence: null, websiteFetched: false, promptTokens: 0, outputTokens: 0 };
  }
  const company: CompanyForClassify = {
    name: input.name,
    description: null,
    industry: null,
    domain: null,
    website: input.website,
  };
  try {
    const r = await classifyPass(env, company, websiteText, model);
    const parsed = r.parsed;
    if (!parsed || parsed.confidence < minConfidence(env)) {
      return { focus: null, hospitality: false, confidence: parsed?.confidence ?? null, websiteFetched: true, promptTokens: r.promptTokens, outputTokens: r.outputTokens };
    }
    const focus: ProjectFocusValue[] = [];
    if (parsed.focus.includes("Commercial") && parsed.confidence >= commercialMinConfidence(env)) {
      focus.push("Commercial");
    }
    if (parsed.focus.includes("Residential") || !focus.length) focus.unshift("Residential");
    // Hospitality is held to the same higher bar as Commercial (it routes a person).
    const hospitality = parsed.hospitality && parsed.confidence >= commercialMinConfidence(env);
    return { focus, hospitality, confidence: parsed.confidence, websiteFetched: true, promptTokens: r.promptTokens, outputTokens: r.outputTokens };
  } catch {
    return { focus: null, hospitality: false, confidence: null, websiteFetched: true, promptTokens: 0, outputTokens: 0 };
  }
}

/**
 * Classify (and, unless write:false, write) one interior-designer company's project
 * focus. Always idempotent; records every attempt. Never overwrites an existing value.
 */
export async function classifyProjectFocus(
  env: Env,
  sb: SupabaseClient,
  opts: ProjectFocusOptions,
): Promise<ProjectFocusResult> {
  const { companyId, source, signal } = opts;
  const write = opts.write !== false;
  const model = env.PROJECT_FOCUS_MODEL || env.CLASSIFY_MODEL || env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
  const base: ProjectFocusResult = {
    companyId,
    status: "skipped",
    focus: null,
    hospitality: null,
    value: null,
    confidence: null,
    wrote: false,
    promptTokens: null,
    outputTokens: null,
  };

  const token = env.HUBSPOT_TOKEN;
  if (!token) return { ...base, status: "error", reason: "HUBSPOT_TOKEN unset" };

  if (source === "webhook" && (await recentlyAttempted(sb, companyId))) {
    return { ...base, status: "skipped", reason: "deduped (recent attempt)" };
  }

  let props = opts.properties ?? null;
  if (!props) {
    props = await fetchCompany(token, companyId, signal);
    if (props === null) return { ...base, status: "skipped", reason: "company not found" };
  }

  // Gate: interior designers only.
  const subType = str(props.company_sub_type_simplified) || str(props.company_sub_type);
  if (normalizeCompanyType(subType) !== "Interior Designer") {
    return { ...base, status: "skipped_not_designer", reason: `sub_type=${subType ?? "∅"}` };
  }

  // Never overwrite an existing value.
  const current = str(props[PROJECT_FOCUS_PROP]);
  if (current) {
    await recordAttempt(sb, { company_id: companyId, result: current, confidence: null, model, source, status: "already_set", wrote: false, prompt_tokens: null, output_tokens: null, inputs_hash: null });
    return { ...base, status: "already_set", value: current };
  }

  const company: CompanyForClassify = {
    name: str(props.name),
    description: str(props.description),
    industry: str(props.industry),
    domain: str(props.domain),
    website: str(props.website),
  };
  const site = company.website || company.domain;
  const minConf = minConfidence(env);
  const allowScrape = opts.scrapeWebsite ?? true;

  // No domain/website → assign nothing (leave project_focus blank). Routing treats a
  // blank value as Residential at event time, so nothing is lost by not guessing here.
  if (!site) {
    await recordAttempt(sb, { company_id: companyId, result: null, confidence: null, model, source, status: "skipped_no_domain", wrote: false, prompt_tokens: null, output_tokens: null, inputs_hash: null });
    return { ...base, status: "skipped_no_domain", reason: "no domain" };
  }
  // A domain that looks unrelated to the name (bad CRM data) → don't scrape that site.
  const siteSuspect = siteLikelyUnrelated(company.name ?? "", site);

  // Pass 1 (fields). Pass 2 (scrape) only if pass 1 wasn't confident and the site looks trustworthy.
  let promptTokens = 0;
  let outputTokens = 0;
  let websiteText: string | null = null;
  let parsed: ReturnType<typeof parseProjectFocus> = null;
  try {
    const r = await classifyPass(env, company, null, model);
    promptTokens += r.promptTokens;
    outputTokens += r.outputTokens;
    parsed = r.parsed;
  } catch (e) {
    return { ...base, status: "error", reason: e instanceof Error ? e.message : String(e), promptTokens, outputTokens };
  }
  if (!(parsed && parsed.confidence >= minConf) && allowScrape && !siteSuspect) {
    websiteText = await fetchWebsiteText(site);
    if (websiteText) {
      try {
        const r = await classifyPass(env, company, websiteText, model);
        promptTokens += r.promptTokens;
        outputTokens += r.outputTokens;
        if (r.parsed && (!parsed || r.parsed.confidence > parsed.confidence)) parsed = r.parsed;
      } catch {
        /* non-fatal */
      }
    }
  }

  const hash = inputsHash(company, websiteText);
  const confident = !!parsed && parsed.confidence >= minConf;
  // Commercial must be a REAL FOCUS: mark it only at a higher confidence bar, so a
  // borderline description mention (e.g. "boutique commercial") stays Residential.
  const commMin = commercialMinConfidence(env);
  const modelFocus = confident ? parsed!.focus : [];
  const focus: ProjectFocusValue[] = [];
  if (modelFocus.includes("Commercial") && parsed!.confidence >= commMin) focus.push("Commercial");
  if (modelFocus.includes("Residential") || !focus.length) focus.unshift("Residential");
  const value = projectFocusToValue(focus);
  const confidence = parsed?.confidence ?? null;

  let wrote = false;
  if (write) {
    try {
      await writeFocus(token, companyId, value, signal);
      wrote = true;
    } catch (e) {
      await recordAttempt(sb, { company_id: companyId, result: value, confidence, model, source, status: "error", wrote: false, prompt_tokens: promptTokens, output_tokens: outputTokens, inputs_hash: hash });
      return { ...base, status: "error", focus, value, confidence, promptTokens, outputTokens, reason: e instanceof Error ? e.message : String(e) };
    }
  }
  const status: ProjectFocusStatus = confident ? "classified" : "defaulted";
  // Hospitality is held to the Commercial bar (it routes to a person, not a channel).
  const hospitality = confident ? parsed!.hospitality && parsed!.confidence >= commMin : null;
  await recordAttempt(sb, { company_id: companyId, result: value, confidence, model, source, status, wrote, prompt_tokens: promptTokens, output_tokens: outputTokens, inputs_hash: hash });
  return { companyId, status, focus, hospitality, value, confidence, wrote, promptTokens, outputTokens };
}
