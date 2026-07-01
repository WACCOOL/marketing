import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildProductFocusPrompt,
  parseProductFocus,
  productFocusToValue,
  overrideFor,
  extractSiteSummary,
  inputsHash,
  siteLikelyUnrelated,
  PRODUCT_FOCUS_PROP,
  type CompanyForClassify,
  type ProductFocusValue,
} from "@wac/shared";
import type { Env } from "./env.js";
import { geminiTextWithUsage } from "./gemini.js";
import { hs, PATHS } from "./hubspotPush.js";

/**
 * Company "product focus" classifier (decorative vs functional) — the source of truth
 * that drives the showroom-vs-distributor split and WAC-vs-MF/Schonbek routing. Gated to
 * Showroom/Distributor companies. Deterministic name/MF-account overrides skip the crawl;
 * otherwise two-pass Gemini. Always writes (defaults from the legacy sub-type hint).
 * Mirrors {@link ./projectFocus}.
 */

const WEBSITE_FETCH_TIMEOUT_MS = 8_000;
const WEBSITE_USER_AGENT = "WAC-Marketing-App/1.0 (+product-focus-classifier)";
const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEDUP_WINDOW_MS = 2 * 60 * 1000;

const FETCH_PROPS =
  "name,description,industry,website,domain,account_number_,company_sub_type_simplified,company_sub_type,product_focus";

/** Simplified buckets in scope. */
const APPLICABLE_SIMPLIFIED = new Set(["dealer / showroom / retail", "distributor / wholesaler"]);
/** Legacy sub-types that, absent AI signal, default to Decorative (rest → Functional). */
const DECORATIVE_DEFAULT_SUBTYPES = new Set([
  "lighting showroom", "dealer", "furniture store", "department store", "lightbulb specialist",
  "showroom-main retail", "boutique/specialty",
]);

export type ProductFocusSource = "webhook" | "backfill" | "manual" | "event-lead";
export type ProductFocusStatus =
  | "classified" | "override" | "defaulted" | "already_set" | "skipped_not_applicable" | "skipped" | "error";

export interface ProductFocusResult {
  companyId: string;
  status: ProductFocusStatus;
  focus: ProductFocusValue[] | null;
  value: string | null;
  confidence: number | null;
  wrote: boolean;
  promptTokens: number | null;
  outputTokens: number | null;
  reason?: string;
}

export interface ProductFocusOptions {
  companyId: string;
  source: ProductFocusSource;
  signal: AbortSignal;
  write?: boolean;
  properties?: Record<string, unknown>;
  scrapeWebsite?: boolean;
}

function minConfidence(env: Env): number {
  const v = Number(env.CLASSIFY_MIN_CONFIDENCE);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_MIN_CONFIDENCE;
}
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}

async function fetchCompany(token: string, id: string, signal: AbortSignal) {
  const res = await hs(token, "GET", `${PATHS.companyLookup}${encodeURIComponent(id)}?properties=${FETCH_PROPS}`, undefined, signal);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`company ${id} fetch ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  return (res.data?.properties ?? {}) as Record<string, unknown>;
}
async function writeFocus(token: string, id: string, value: string, signal: AbortSignal) {
  const res = await hs(token, "PATCH", `${PATHS.companyLookup}${encodeURIComponent(id)}`, { properties: { [PRODUCT_FOCUS_PROP]: value } }, signal);
  if (!res.ok) throw new Error(`company ${id} patch ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
}
async function fetchWebsiteText(siteRaw: string): Promise<string | null> {
  const url = /^https?:\/\//i.test(siteRaw) ? siteRaw : `https://${siteRaw}`;
  try {
    const res = await fetch(url, { headers: { "user-agent": WEBSITE_USER_AGENT, accept: "text/html" }, signal: AbortSignal.timeout(WEBSITE_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return extractSiteSummary(await res.text()) || null;
  } catch {
    return null;
  }
}
async function recentlyAttempted(sb: SupabaseClient, companyId: string): Promise<boolean> {
  const { data } = await sb.from("company_product_focus_classifications").select("updated_at").eq("company_id", companyId).maybeSingle();
  if (!data?.updated_at) return false;
  return Date.now() - new Date(data.updated_at as string).getTime() < DEDUP_WINDOW_MS;
}
async function recordAttempt(sb: SupabaseClient, row: Record<string, unknown> & { company_id: string }): Promise<void> {
  const { error } = await sb.from("company_product_focus_classifications").upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "company_id" });
  if (error) console.error("[product-focus] audit upsert failed:", error.message);
}
async function classifyPass(env: Env, company: CompanyForClassify, websiteText: string | null, model: string) {
  const { system, prompt } = buildProductFocusPrompt({ company, websiteText });
  const r = await geminiTextWithUsage(env, { prompt, system, json: true, model, temperature: 0, timeoutMs: 20_000 });
  return { parsed: parseProductFocus(r.text), promptTokens: r.usage?.promptTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0 };
}

/** Default focus from the legacy sub-type when there's no AI signal or override. */
function defaultFocus(subType: string | null): ProductFocusValue {
  return subType && DECORATIVE_DEFAULT_SUBTYPES.has(subType.toLowerCase()) ? "Decorative" : "Functional";
}

export async function classifyProductFocus(env: Env, sb: SupabaseClient, opts: ProductFocusOptions): Promise<ProductFocusResult> {
  const { companyId, source, signal } = opts;
  const write = opts.write !== false;
  const model = env.PRODUCT_FOCUS_MODEL || env.CLASSIFY_MODEL || env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
  const base: ProductFocusResult = { companyId, status: "skipped", focus: null, value: null, confidence: null, wrote: false, promptTokens: null, outputTokens: null };

  const token = env.HUBSPOT_TOKEN;
  if (!token) return { ...base, status: "error", reason: "HUBSPOT_TOKEN unset" };
  if (source === "webhook" && (await recentlyAttempted(sb, companyId))) return { ...base, status: "skipped", reason: "deduped (recent attempt)" };

  let props = opts.properties ?? null;
  if (!props) {
    props = await fetchCompany(token, companyId, signal);
    if (props === null) return { ...base, status: "skipped", reason: "company not found" };
  }

  // Gate: Showroom/Distributor companies only.
  const simplified = str(props.company_sub_type_simplified);
  const subType = str(props.company_sub_type);
  if (!(simplified && APPLICABLE_SIMPLIFIED.has(simplified))) {
    return { ...base, status: "skipped_not_applicable", reason: `simplified=${simplified ?? "∅"}` };
  }
  // Never overwrite an existing value.
  const current = str(props[PRODUCT_FOCUS_PROP]);
  if (current) {
    await recordAttempt(sb, { company_id: companyId, result: current, confidence: null, model, source, status: "already_set", wrote: false, prompt_tokens: null, output_tokens: null, inputs_hash: null });
    return { ...base, status: "already_set", value: current };
  }

  // Deterministic override (name → MF account) — skip the crawl.
  const ov = overrideFor({ name: str(props.name), accountNumber: str(props.account_number_) });
  if (ov) {
    const value = productFocusToValue([ov]);
    let wrote = false;
    if (write) {
      try { await writeFocus(token, companyId, value, signal); wrote = true; }
      catch (e) { return { ...base, status: "error", reason: e instanceof Error ? e.message : String(e) }; }
    }
    await recordAttempt(sb, { company_id: companyId, result: value, confidence: null, model, source, status: "override", wrote, prompt_tokens: null, output_tokens: null, inputs_hash: null });
    return { ...base, status: "override", focus: [ov], value, confidence: null, wrote };
  }

  const company: CompanyForClassify = { name: str(props.name), description: str(props.description), industry: str(props.industry), domain: str(props.domain), website: str(props.website) };
  const site = company.website || company.domain;
  const minConf = minConfidence(env);
  const allowScrape = opts.scrapeWebsite ?? true;
  const siteSuspect = site ? siteLikelyUnrelated(company.name ?? "", site) : true;

  let promptTokens = 0, outputTokens = 0, websiteText: string | null = null;
  let parsed: ReturnType<typeof parseProductFocus> = null;
  if (site) {
    try {
      const r = await classifyPass(env, company, null, model);
      promptTokens += r.promptTokens; outputTokens += r.outputTokens; parsed = r.parsed;
    } catch (e) {
      return { ...base, status: "error", reason: e instanceof Error ? e.message : String(e), promptTokens, outputTokens };
    }
    if (!(parsed && parsed.confidence >= minConf) && allowScrape && !siteSuspect) {
      websiteText = await fetchWebsiteText(site);
      if (websiteText) {
        try {
          const r = await classifyPass(env, company, websiteText, model);
          promptTokens += r.promptTokens; outputTokens += r.outputTokens;
          if (r.parsed && (!parsed || r.parsed.confidence > parsed.confidence)) parsed = r.parsed;
        } catch { /* non-fatal */ }
      }
    }
  }

  const hash = inputsHash(company, websiteText);
  const confident = !!parsed && parsed.confidence >= minConf;
  const focus: ProductFocusValue[] = confident ? parsed!.focus : [defaultFocus(subType)];
  const value = productFocusToValue(focus);
  const confidence = parsed?.confidence ?? null;

  let wrote = false;
  if (write) {
    try { await writeFocus(token, companyId, value, signal); wrote = true; }
    catch (e) {
      await recordAttempt(sb, { company_id: companyId, result: value, confidence, model, source, status: "error", wrote: false, prompt_tokens: promptTokens, output_tokens: outputTokens, inputs_hash: hash });
      return { ...base, status: "error", focus, value, confidence, promptTokens, outputTokens, reason: e instanceof Error ? e.message : String(e) };
    }
  }
  const status: ProductFocusStatus = confident ? "classified" : "defaulted";
  await recordAttempt(sb, { company_id: companyId, result: value, confidence, model, source, status, wrote, prompt_tokens: promptTokens, output_tokens: outputTokens, inputs_hash: hash });
  return { companyId, status, focus, value, confidence, wrote, promptTokens, outputTokens };
}
