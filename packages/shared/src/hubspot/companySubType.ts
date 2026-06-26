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
 * that the pattern filter wouldn't catch. Keep this tight; tune as needed.
 */
export const SUBTYPE_DENYLIST_VALUES: ReadonlySet<string> = new Set([
  "Destributor", // dupe of "Distributor"
  "Contractor.", // dupe of "Contractor"
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
 * Build the system + user prompt. The model must return strict JSON and pick
 * exactly one allowed value or null.
 */
export function buildSubTypePrompt(input: {
  company: CompanyForClassify;
  websiteText?: string | null;
  candidates: SubTypeCandidate[];
}): { system: string; prompt: string } {
  const { company, websiteText, candidates } = input;
  const system =
    'You classify a company in a lighting-industry CRM (WAC Lighting) into exactly one "company sub-type". ' +
    "Choose the single best-fitting value from the ALLOWED LIST, copied verbatim. " +
    "Base the decision on the company's name, industry, description, and any website text provided. " +
    "If the information is insufficient to choose with reasonable confidence, return null — do not guess. " +
    "Never return a value that is not in the ALLOWED LIST. " +
    'Respond with STRICT JSON only: {"sub_type": <allowed value or null>, "confidence": <number 0..1>, "reasoning": <short string>}.';

  const lines: string[] = ["COMPANY"];
  if (company.name) lines.push(`Name: ${company.name}`);
  if (company.industry) lines.push(`Industry: ${company.industry}`);
  const site = company.website || company.domain;
  if (site) lines.push(`Website: ${site}`);
  if (company.description) lines.push(`Description: ${company.description}`);
  if (websiteText && websiteText.trim()) {
    lines.push("", "WEBSITE TEXT (excerpt)", websiteText.trim());
  }
  lines.push("", "ALLOWED LIST (choose exactly one of these values, or null):");
  for (const c of candidates) lines.push(`- ${c.value}`);
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
