import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildSubTypePrompt,
  COMPANY_SUB_TYPE_PROP,
  deriveSubTypeCandidates,
  hasClassifiableSignal,
  inputsHash,
  isJunkSubType,
  parseClassification,
  stripHtmlToText,
  validateSubType,
  type CompanyForClassify,
  type SubTypeCandidate,
} from "@wac/shared";
import type { Env } from "./env.js";
import { geminiTextWithUsage } from "./gemini.js";
import { hs, PATHS } from "./hubspotPush.js";
import { loadOptions } from "./hubspotHeal.js";

/**
 * Company sub-type auto-classifier (Worker side).
 *
 * One classification code path, shared by:
 *   - the HubSpot workflow webhook (POST /api/hubspot/classify-company), and
 *   - the territory-sync backfill (POST .../sync, which passes pre-fetched props).
 *
 * It reads a company, asks Gemini to pick the best sub-type from the curated
 * candidate set, and PATCHes it back — but ONLY when the value is currently
 * blank. Writing a known value removes the company from the workflow's
 * "is unknown" enrollment trigger, so the write never re-triggers (no loop);
 * deleting the value later re-enrolls and reclassifies.
 */

const WEBSITE_FETCH_TIMEOUT_MS = 8_000;
const WEBSITE_USER_AGENT = "WAC-Marketing-App/1.0 (+company-classifier)";
const DEFAULT_MIN_CONFIDENCE = 0.6;
/** Skip a near-duplicate webhook for the same company seen within this window. */
const DEDUP_WINDOW_MS = 2 * 60 * 1000;
/** Only bother scraping the site when the HubSpot description is this thin. */
const THIN_DESCRIPTION_CHARS = 40;

const CLASSIFY_PROPS = "name,company_sub_type,description,industry,website,domain";

export type ClassifySource = "webhook" | "backfill" | "manual";

export type ClassifyStatus =
  | "classified"
  | "no_confident_match"
  | "already_set"
  | "no_data"
  | "skipped"
  | "error";

export interface ClassifyResult {
  companyId: string;
  status: ClassifyStatus;
  subType: string | null;
  confidence: number | null;
  wrote: boolean;
  promptTokens: number | null;
  outputTokens: number | null;
  reason?: string;
}

export interface ClassifyOptions {
  companyId: string;
  source: ClassifySource;
  signal: AbortSignal;
  /** Write the result back to HubSpot (default true). false = classify + log only. */
  write?: boolean;
  /** Pre-fetched company properties (backfill passes these to skip a GET). */
  properties?: Record<string, unknown>;
  /** Best-effort website scrape (default: on for webhook, off for backfill). */
  scrapeWebsite?: boolean;
}

function minConfidence(env: Env): number {
  const v = Number(env.CLASSIFY_MIN_CONFIDENCE);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_MIN_CONFIDENCE;
}

/** Fetch the company's classify-relevant properties from HubSpot. null = 404. */
async function fetchCompany(
  token: string,
  id: string,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const path = `${PATHS.companyLookup}${encodeURIComponent(id)}?properties=${CLASSIFY_PROPS}`;
  const res = await hs(token, "GET", path, undefined, signal);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`company ${id} fetch ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  return (res.data?.properties ?? {}) as Record<string, unknown>;
}

/** PATCH a single company's sub-type by record id. */
async function writeSubType(
  token: string,
  id: string,
  value: string,
  signal: AbortSignal,
): Promise<void> {
  const res = await hs(
    token,
    "PATCH",
    `${PATHS.companyLookup}${encodeURIComponent(id)}`,
    { properties: { [COMPANY_SUB_TYPE_PROP]: value } },
    signal,
  );
  if (!res.ok) {
    throw new Error(`company ${id} patch ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
}

/** Best-effort website text. Returns null on any error / non-OK. */
async function fetchWebsiteText(siteRaw: string): Promise<string | null> {
  const url = /^https?:\/\//i.test(siteRaw) ? siteRaw : `https://${siteRaw}`;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": WEBSITE_USER_AGENT, accept: "text/html" },
      signal: AbortSignal.timeout(WEBSITE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const text = stripHtmlToText(html);
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Load the curated candidate set: enabled rows from company_sub_type_candidates,
 * falling back to the cached HubSpot options (minus junk) if the table is empty
 * (e.g. before the candidate builder has run).
 */
export async function loadSubTypeCandidates(sb: SupabaseClient): Promise<SubTypeCandidate[]> {
  const { data, error } = await sb
    .from("company_sub_type_candidates")
    .select("value, label, count")
    .eq("enabled", true);
  if (!error && data && data.length) {
    return (data as { value: string; label: string; count: number }[])
      .map((r) => ({ value: r.value, label: r.label ?? r.value, count: r.count ?? 0 }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }
  if (error) console.error("[classify] candidates load failed:", error.message);
  // Fallback: derive from the cached option list (counts unknown → all kept).
  const options = (await loadOptions(sb, "companies")).get(COMPANY_SUB_TYPE_PROP) ?? [];
  return options
    .filter((o) => !isJunkSubType(o))
    .map((o) => ({ value: o.value, label: o.label, count: 0 }));
}

async function recordAttempt(
  sb: SupabaseClient,
  row: {
    company_id: string;
    result: string | null;
    confidence: number | null;
    model: string;
    source: ClassifySource;
    status: ClassifyStatus;
    wrote: boolean;
    prompt_tokens: number | null;
    output_tokens: number | null;
    inputs_hash: string | null;
  },
): Promise<void> {
  const { error } = await sb
    .from("company_sub_type_classifications")
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "company_id" });
  if (error) console.error("[classify] audit upsert failed:", error.message);
}

/** Has this company been attempted within the dedup window (a duplicate webhook)? */
async function recentlyAttempted(sb: SupabaseClient, companyId: string): Promise<boolean> {
  const { data } = await sb
    .from("company_sub_type_classifications")
    .select("updated_at")
    .eq("company_id", companyId)
    .maybeSingle();
  if (!data?.updated_at) return false;
  return Date.now() - new Date(data.updated_at as string).getTime() < DEDUP_WINDOW_MS;
}

/**
 * Classify (and, unless write:false, write) one company's sub-type. Always
 * idempotent and safe to retry; records every attempt to the audit table.
 */
export async function classifySubType(
  env: Env,
  sb: SupabaseClient,
  opts: ClassifyOptions,
): Promise<ClassifyResult> {
  const { companyId, source, signal } = opts;
  const write = opts.write !== false;
  const model = env.CLASSIFY_MODEL || env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";

  const base: ClassifyResult = {
    companyId,
    status: "skipped",
    subType: null,
    confidence: null,
    wrote: false,
    promptTokens: null,
    outputTokens: null,
  };

  const token = env.HUBSPOT_TOKEN;
  if (!token) return { ...base, status: "error", reason: "HUBSPOT_TOKEN unset" };

  // Dedup rapid duplicate webhooks (HubSpot retries) — but never for the backfill,
  // which legitimately processes each company once and passes its own props.
  if (source === "webhook" && (await recentlyAttempted(sb, companyId))) {
    return { ...base, status: "skipped", reason: "deduped (recent attempt)" };
  }

  let props = opts.properties ?? null;
  if (!props) {
    props = await fetchCompany(token, companyId, signal);
    if (props === null) return { ...base, status: "skipped", reason: "company not found" };
  }

  // Never overwrite an existing value.
  const current = String(props[COMPANY_SUB_TYPE_PROP] ?? "").trim();
  if (current) {
    await recordAttempt(sb, {
      company_id: companyId,
      result: current,
      confidence: null,
      model,
      source,
      status: "already_set",
      wrote: false,
      prompt_tokens: null,
      output_tokens: null,
      inputs_hash: null,
    });
    return { ...base, status: "already_set", subType: current };
  }

  const company: CompanyForClassify = {
    name: str(props.name),
    description: str(props.description),
    industry: str(props.industry),
    domain: str(props.domain),
    website: str(props.website),
  };

  if (!hasClassifiableSignal(company)) {
    await recordAttempt(sb, baseAudit(companyId, model, source, "no_data"));
    return { ...base, status: "no_data", reason: "no name/description/industry" };
  }

  const candidates = await loadSubTypeCandidates(sb);
  if (!candidates.length) {
    return { ...base, status: "error", reason: "no candidate sub-types configured" };
  }

  // Best-effort website scrape: only when asked, a site exists, and the
  // description is too thin to classify on its own.
  let websiteText: string | null = null;
  const scrape = opts.scrapeWebsite ?? source === "webhook";
  const site = company.website || company.domain;
  if (scrape && site && (company.description ?? "").trim().length < THIN_DESCRIPTION_CHARS) {
    websiteText = await fetchWebsiteText(site);
  }

  const { system, prompt } = buildSubTypePrompt({ company, websiteText, candidates });

  let text: string;
  let usage: { promptTokens: number; outputTokens: number } | null;
  try {
    const r = await geminiTextWithUsage(env, {
      prompt,
      system,
      json: true,
      model,
      temperature: 0,
      timeoutMs: 20_000,
    });
    text = r.text;
    usage = r.usage;
  } catch (e) {
    return { ...base, status: "error", reason: e instanceof Error ? e.message : String(e) };
  }

  const parsed = parseClassification(text);
  const promptTokens = usage?.promptTokens ?? null;
  const outputTokens = usage?.outputTokens ?? null;
  const hash = inputsHash(company, websiteText);

  if (!parsed) {
    await recordAttempt(sb, {
      company_id: companyId,
      result: null,
      confidence: null,
      model,
      source,
      status: "error",
      wrote: false,
      prompt_tokens: promptTokens,
      output_tokens: outputTokens,
      inputs_hash: hash,
    });
    return { ...base, status: "error", reason: "unparseable model output", promptTokens, outputTokens };
  }

  const canonical = validateSubType(parsed.subType, candidates);
  const confident = canonical !== null && parsed.confidence >= minConfidence(env);

  let wrote = false;
  let status: ClassifyStatus;
  if (confident) {
    if (write) {
      try {
        await writeSubType(token, companyId, canonical, signal);
        wrote = true;
      } catch (e) {
        await recordAttempt(sb, {
          company_id: companyId,
          result: canonical,
          confidence: parsed.confidence,
          model,
          source,
          status: "error",
          wrote: false,
          prompt_tokens: promptTokens,
          output_tokens: outputTokens,
          inputs_hash: hash,
        });
        return {
          ...base,
          status: "error",
          subType: canonical,
          confidence: parsed.confidence,
          promptTokens,
          outputTokens,
          reason: e instanceof Error ? e.message : String(e),
        };
      }
    }
    status = "classified";
  } else {
    status = "no_confident_match";
  }

  await recordAttempt(sb, {
    company_id: companyId,
    result: canonical ?? parsed.subType,
    confidence: parsed.confidence,
    model,
    source,
    status,
    wrote,
    prompt_tokens: promptTokens,
    output_tokens: outputTokens,
    inputs_hash: hash,
  });

  return {
    companyId,
    status,
    subType: canonical ?? parsed.subType,
    confidence: parsed.confidence,
    wrote,
    promptTokens,
    outputTokens,
  };
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}

function baseAudit(
  companyId: string,
  model: string,
  source: ClassifySource,
  status: ClassifyStatus,
) {
  return {
    company_id: companyId,
    result: null,
    confidence: null,
    model,
    source,
    status,
    wrote: false,
    prompt_tokens: null,
    output_tokens: null,
    inputs_hash: null,
  };
}
