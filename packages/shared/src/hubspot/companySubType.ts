/**
 * Company sub-type auto-classification — pure helpers (no runtime deps).
 *
 * The HubSpot `company_sub_type` property is a ~90-option dropdown that's been
 * hand-maintained for years, so it's full of junk: options labeled "UNNEEDED" /
 * "Not Use" / "Do not use", plus typo-dupes ("Destributor" for "Distributor",
 * "Contractor." for "Contractor"). We never let the model pick those.
 *
 * The candidate set the model chooses from is AUTO-DERIVED from the values
 * actually in use across companies (by frequency), intersected with the current
 * option list (so the chosen value is always writable) and minus the junk above.
 * These helpers build that set, build the prompt, and validate the model's answer.
 *
 * Used by the API Worker (apps/api/src/companyClassify.ts) and the territory-sync
 * candidate builder (apps/territory-sync/src/companySubType.ts).
 */

/** The HubSpot company property we classify. */
export const COMPANY_SUB_TYPE_PROP = "company_sub_type";

/** A HubSpot enumeration option. */
export interface SubTypeOption {
  value: string;
  label: string;
}

/** A curated candidate the model may choose from, with its usage frequency. */
export interface SubTypeCandidate {
  value: string;
  label: string;
  count: number;
}

/** Company fields fed to the classifier. */
export interface CompanyForClassify {
  name?: string | null;
  description?: string | null;
  industry?: string | null;
  domain?: string | null;
  website?: string | null;
}

/** Parsed model answer. */
export interface SubTypeClassification {
  subType: string | null;
  confidence: number;
  reasoning?: string;
}

/** Option labels/values matching any of these are junk and never offered to the model. */
export const SUBTYPE_JUNK_PATTERNS: readonly RegExp[] = [
  /unneeded/i,
  /not\s*use/i,
  /do\s*not\s*use/i,
];

/**
 * Exact option VALUES to exclude — clear typos/dupes that have a clean twin and
 * that the pattern filter wouldn't catch, plus generic catch-alls we'd rather the
 * model abstain on (return null → leave blank) than apply as a meaningless label.
 * Keep this tight; tune as needed.
 */
export const SUBTYPE_DENYLIST_VALUES: ReadonlySet<string> = new Set([
  "Destributor", // dupe of "Distributor"
  "Contractor.", // dupe of "Contractor"
  // Generic catch-alls — excluded by request so an ambiguous company stays blank
  // (and re-triggers cleanly) instead of being labeled with a useless value.
  "Other",
  "Others",
  "Owner",
  // Modern Forms ("MF") designer lines — set internally only, never auto-classified.
  "MF Designer",
  "MF Designer Rep",
]);

/** Normalize for case/spacing-insensitive comparison. */
function normSub(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** True when an option should never be offered to (or accepted from) the model. */
export function isJunkSubType(opt: { value: string; label?: string | null }): boolean {
  const value = opt.value ?? "";
  if (!value.trim()) return true;
  if (SUBTYPE_DENYLIST_VALUES.has(value)) return true;
  const hay = `${value} ${opt.label ?? ""}`;
  return SUBTYPE_JUNK_PATTERNS.some((re) => re.test(hay));
}

/**
 * Build the curated candidate list from usage tallies + the current option defs.
 *
 * `tallies` — value -> # companies using it (from a crawl of company_sub_type).
 * `options` — the property's current HubSpot options (value+label).
 *
 * A candidate must: be used at least `minCount` times, be a real current option
 * (so we can write it back), and not be junk. Values that normalize to the same
 * canonical option are merged. Sorted by frequency (most-used first).
 */
export function deriveSubTypeCandidates(
  tallies: Map<string, number>,
  options: SubTypeOption[],
  opts: { minCount?: number } = {},
): SubTypeCandidate[] {
  const minCount = opts.minCount ?? 1;
  const byNorm = new Map<string, SubTypeOption>();
  for (const o of options) byNorm.set(normSub(o.value), o);

  const out: SubTypeCandidate[] = [];
  const indexByKey = new Map<string, SubTypeCandidate>();
  for (const [rawValue, count] of tallies) {
    if (count < minCount) continue;
    const opt = byNorm.get(normSub(rawValue));
    if (!opt) continue; // used value isn't a current option → can't write it back
    if (isJunkSubType(opt)) continue;
    const key = normSub(opt.value);
    const existing = indexByKey.get(key);
    if (existing) {
      existing.count += count; // merge values that normalize together
      continue;
    }
    const cand: SubTypeCandidate = { value: opt.value, label: opt.label, count };
    indexByKey.set(key, cand);
    out.push(cand);
  }
  out.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return out;
}

/**
 * Short '— meaning' glosses for cryptic/ambiguous option values, appended to the
 * allowed list so the model interprets them correctly. Keyed by exact value.
 *
 * The "Rep" family is the big one: in this taxonomy a *Rep value means a
 * MANUFACTURERS' SALES REPRESENTATIVE AGENCY, not a company that does that kind
 * of work itself (an integrator is "Integrators", not "Integrator Rep").
 */
export const SUBTYPE_GUIDANCE: Record<string, string> = {
  Integrators:
    "designs/installs integrated AV, lighting, or building-control systems — does the integration work itself",
  "Integrator Rep":
    "a manufacturers' sales-rep agency that represents integrator/AV product lines — NOT a company that performs integration",
  "Contract Rep": "a manufacturers' sales-rep agency (contract/commercial)",
  "Principal Com. Rep": "a manufacturers' sales-rep agency (commercial)",
  "Principal Reside Rep": "a manufacturers' sales-rep agency (residential)",
  "Sub-Rep Com. Rep": "a sub-agent of a manufacturers' sales-rep agency (commercial)",
  "Sub-Rep Reside Rep": "a sub-agent of a manufacturers' sales-rep agency (residential)",
  Distributor: "buys and resells/stocks product at wholesale",
  Dealer: "resells product; typically smaller/local than a distributor",
  "Lighting Showroom": "retail showroom that displays and sells lighting",
  "Lighting Designer": "a firm/individual that designs lighting and specifies fixtures (not a manufacturer or rep)",
  "Lighting Design": "a lighting-design firm (same idea as Lighting Designer)",
  "Lighting Supplier": "supplies/sells lighting products (reseller or wholesaler)",
  "Lighting Manufacturer": "manufactures lighting products",
  "Interior Designer": "designs interior spaces and specifies furnishings/lighting",
  "Building Contractor": "general construction contractor",
  "Elect. Contractor": "electrical installation contractor",
  "M&E Consultant": "mechanical & electrical engineering consultancy",
  OEM: "original-equipment manufacturer that builds product incorporating components",
  "Internet Retailer": "sells product online (e-commerce)",
  "Furniture Store": "retailer that sells furniture (may carry lighting)",
  "Designer/Int. Decor.": "interior designer / interior decorator",
  "Elec. House w/o SHOW": "electrical distributor/wholesale house WITHOUT a showroom",
  "Elec. House w/ SHOW": "electrical distributor/wholesale house WITH a showroom",
};

/** Corporate/filler words ignored when comparing a company name to its domain. */
const NAME_STOPWORDS = new Set([
  "inc", "llc", "corp", "corporation", "co", "company", "ltd", "limited", "the", "and",
  "of", "group", "enterprises", "international", "intl", "services", "service", "supply",
  "systems", "associates", "assoc", "sales",
]);

/** The distinctive core of a domain: "https://www.ferguson.com/x" → "ferguson". */
export function domainCore(site: string): string {
  const host = (site || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
  const labels = host.split(".").filter(Boolean);
  const SUFFIX = new Set(["com", "net", "org", "co", "io", "ca", "us", "uk", "au", "biz", "info"]);
  while (labels.length > 1 && SUFFIX.has(labels[labels.length - 1]!)) labels.pop();
  return labels.join("");
}

function nameTokens(name: string): string[] {
  return (name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
}

/**
 * Conservative check: does the website domain look UNRELATED to the company
 * name? Only true when there's no meaningful token or acronym overlap — so it
 * flags clear mismatches (Hajoca↔onc.com, CED-Yakima↔jcwrightlighting.com) and
 * leaves anything plausible alone. Used as a HINT to the model (which then
 * adjudicates), so a rare false positive is harmless.
 */
export function siteLikelyUnrelated(name: string, site: string): boolean {
  const core = domainCore(site);
  if (core.length < 3) return false; // can't tell
  const raw = nameTokens(name);
  if (!raw.length) return false;
  const sig = raw.filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t));
  for (const t of sig) {
    if (core.includes(t) || t.includes(core)) return false; // token overlap → related
  }
  const acronym = raw.map((t) => t[0]).join("");
  if (acronym.length >= 2 && core.includes(acronym)) return false; // e.g. "ced" in domain
  const sigAcr = sig.map((t) => t[0]).join("");
  if (sigAcr.length >= 2 && core.includes(sigAcr)) return false;
  return true; // no overlap → likely a different company's site
}

/**
 * Build the system + user prompt. The model must return strict JSON and pick
 * exactly one allowed value or null.
 */
export function buildSubTypePrompt(input: {
  company: CompanyForClassify;
  websiteText?: string | null;
  candidates: SubTypeCandidate[];
  /** True when the website domain looks unrelated to the company name. */
  siteSuspect?: boolean;
}): { system: string; prompt: string } {
  const { company, websiteText, candidates, siteSuspect } = input;
  const system =
    'You classify a company in a lighting-industry CRM (WAC Lighting) into exactly one "company sub-type". ' +
    "Choose the single best-fitting value from the ALLOWED LIST, copied verbatim. " +
    "Base the decision on the company's name, industry, description, and any website text provided. " +
    "Classify the company by what it IS, not by who its customers are. " +
    "Treat the Website as a HINT, not ground truth: if it appears to belong to a different company than the name " +
    "indicates, ignore it and classify from the name + industry and your knowledge of known companies " +
    "(e.g. CED = Consolidated Electrical Distributors, a distributor; Hajoca = a plumbing distributor; Ferguson = a distributor). " +
    "If you cannot reconcile the name and the website, return null rather than trusting the website. " +
    'A sub-type containing "Rep" means a MANUFACTURERS\' SALES REPRESENTATIVE AGENCY — an independent firm that sells ' +
    "manufacturers' product lines on commission. Only choose a *Rep value when the company is actually such an agency; " +
    "a company that does the work itself (an integrator, contractor, designer, distributor, etc.) is NOT a Rep " +
    '(e.g. a systems integrator is "Integrators", not "Integrator Rep"). ' +
    "Some allowed values carry a short ' — meaning' note; use it to decide. " +
    "If the information is insufficient to choose with reasonable confidence, return null — do not guess. " +
    "Never return a value that is not in the ALLOWED LIST. " +
    'Respond with STRICT JSON only: {"sub_type": <allowed value or null>, "confidence": <number 0..1>, "reasoning": <short string>}.';

  const lines: string[] = ["COMPANY"];
  if (company.name) lines.push(`Name: ${company.name}`);
  if (company.industry) lines.push(`Industry: ${company.industry}`);
  const site = company.website || company.domain;
  if (site) {
    lines.push(
      siteSuspect
        ? `Website: ${site}  (⚠ this domain may belong to a DIFFERENT company — verify against the name; ignore it if it conflicts)`
        : `Website: ${site}`,
    );
  }
  if (company.description) lines.push(`Description: ${company.description}`);
  if (websiteText && websiteText.trim()) {
    lines.push("", "WEBSITE TEXT (excerpt)", websiteText.trim());
  }
  lines.push("", "ALLOWED LIST (choose exactly one of these values, or null):");
  for (const c of candidates) {
    const gloss = SUBTYPE_GUIDANCE[c.value];
    lines.push(gloss ? `- ${c.value} — ${gloss}` : `- ${c.value}`);
  }
  return { system, prompt: lines.join("\n") };
}

/** Parse the model's JSON answer, tolerating code fences / surrounding prose. */
export function parseClassification(raw: string): SubTypeClassification | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const rawSub = o.sub_type ?? o.subType ?? o.subtype ?? null;
  let subType: string | null =
    rawSub === null || rawSub === undefined
      ? null
      : typeof rawSub === "string"
        ? rawSub
        : String(rawSub);
  if (subType !== null && (normSub(subType) === "" || normSub(subType) === "null")) {
    subType = null;
  }
  let confidence = Number(o.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  const reasoning = typeof o.reasoning === "string" ? o.reasoning : undefined;
  return { subType, confidence, reasoning };
}

/**
 * Validate the model's choice against the candidate set. Returns the canonical
 * option value to write (matching by value OR label), or null if it doesn't
 * match an allowed candidate.
 */
export function validateSubType(
  value: string | null,
  candidates: SubTypeCandidate[],
): string | null {
  if (!value) return null;
  const n = normSub(value);
  if (n === "" || n === "null") return null;
  const hit = candidates.find((c) => normSub(c.value) === n || normSub(c.label) === n);
  return hit ? hit.value : null;
}

/** Strip HTML to a bounded plain-text excerpt for the prompt. */
export function stripHtmlToText(html: string, maxChars = 3500): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, maxChars);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
};
function decodeEntities(s: string): string {
  return s.replace(/&(#?\w+);/g, (_, e: string) => {
    if (e[0] === "#") {
      const code = Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCharCode(code) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? " ";
  });
}

/**
 * Lightweight site summary: page title + meta/og description — cheap and
 * concise, which is usually enough to classify. Falls back to readable body
 * text ONLY when the page has no meta description.
 */
export function extractSiteSummary(html: string, maxChars = 1200): string {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  let desc = "";
  let ogDesc = "";
  let keywords = "";
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1] ?? "").toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
    if (!content) continue;
    if (key === "description" && !desc) desc = content;
    else if (key === "og:description" && !ogDesc) ogDesc = content;
    else if (key === "keywords" && !keywords) keywords = content;
  }
  const summary = decodeEntities(desc || ogDesc).replace(/\s+/g, " ").trim();
  if (summary) {
    const parts = [title, summary];
    if (keywords) parts.push(`Keywords: ${decodeEntities(keywords).replace(/\s+/g, " ").trim()}`);
    return parts.filter(Boolean).join(" — ").slice(0, maxChars);
  }
  return stripHtmlToText(html, maxChars);
}

/** True when a company has essentially no signal to classify on. */
export function hasClassifiableSignal(company: CompanyForClassify): boolean {
  return Boolean(
    (company.name && company.name.trim()) ||
      (company.description && company.description.trim()) ||
      (company.industry && company.industry.trim()),
  );
}

/** Cheap, stable hash of the classified inputs (for the audit row / debugging). */
export function inputsHash(company: CompanyForClassify, websiteText?: string | null): string {
  const s = [
    company.name ?? "",
    company.industry ?? "",
    company.website ?? company.domain ?? "",
    company.description ?? "",
    websiteText ?? "",
  ].join(" ");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
