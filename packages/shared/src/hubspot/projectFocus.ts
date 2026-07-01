/**
 * Interior-designer "project focus" classification (pure logic).
 *
 * A parallel of the company sub-type classifier ({@link ./companySubType}), but
 * far simpler: a fixed two-class, multi-select answer — does this interior-design
 * firm do **Residential** projects, **Commercial** projects, or both. Drives the
 * residential-vs-commercial split in the lead-ownership tree.
 *
 * Rules (per the product owner): default to Residential when unsure; mark Commercial
 * ONLY with specific evidence of commercial/contract work (hotels, restaurants,
 * offices, retail, hospitality, institutional, multifamily/condo developments). A
 * firm can be both.
 */

import type { CompanyForClassify } from "./companySubType.js";

/** HubSpot company property (multi-select) this classifier writes. */
export const PROJECT_FOCUS_PROP = "project_focus";

export type ProjectFocusValue = "Residential" | "Commercial";

export interface ProjectFocusClassification {
  /** Subset of {Residential, Commercial}; never empty after {@link parseProjectFocus}. */
  focus: ProjectFocusValue[];
  confidence: number;
  reasoning?: string;
}

/** Multi-select write value: HubSpot joins enum values with ";". */
export function projectFocusToValue(focus: ProjectFocusValue[]): string {
  const seen = new Set<ProjectFocusValue>();
  for (const f of focus) seen.add(f);
  if (!seen.size) seen.add("Residential");
  // Stable order: Residential first.
  return [...(seen.has("Residential") ? ["Residential"] : []), ...(seen.has("Commercial") ? ["Commercial"] : [])].join(";");
}

/** Build the Gemini system+prompt for project-focus classification. */
export function buildProjectFocusPrompt(input: {
  company: CompanyForClassify;
  websiteText?: string | null;
}): { system: string; prompt: string } {
  const system = [
    "You classify what kind of projects an INTERIOR DESIGN firm focuses on, based on its name, industry, and website.",
    "Choose any that apply from exactly these two values:",
    '- "Residential": homes, apartments/condos as private residences, model homes, private clients.',
    '- "Commercial": hospitality (hotels, resorts, restaurants, bars), retail/showrooms, offices/workplace,',
    "  healthcare, senior living, education/institutional, multifamily or condo DEVELOPMENTS, public/contract spaces.",
    "",
    "RULES:",
    '- Default to ["Residential"]. Most interior-design firms are residential — choose Residential unless',
    "  commercial work is clearly a REAL FOCUS of the business.",
    '- Include "Commercial" ONLY when commercial/contract work is a genuine focus: a dedicated commercial',
    "  practice/service line, OR a portfolio of specific commercial projects (named hotels, restaurants,",
    "  offices, retail, hospitality, healthcare, senior living, institutional, or multifamily developments).",
    '- Do NOT mark Commercial for a passing mention or a qualifier — e.g. "boutique commercial",',
    '  "some commercial", "residential and commercial" with no commercial projects shown. When residential',
    "  clearly dominates, return [\"Residential\"] even if the word 'commercial' appears.",
    "- A firm can do both — return both ONLY when each has real, focus-level evidence.",
    "- Prefer the website's actual project portfolio over a one-line self-description.",
    "",
    'Respond with JSON ONLY: {"focus": ["Residential"] | ["Commercial"] | ["Residential","Commercial"], "confidence": <0..1>, "reasoning": "<short>"}.',
    'Never return an empty focus array — if unsure, return ["Residential"] with low confidence.',
  ].join("\n");

  const c = input.company;
  const lines: string[] = ["COMPANY:"];
  if (c.name) lines.push(`name: ${c.name}`);
  if (c.industry) lines.push(`industry: ${c.industry}`);
  if (c.website || c.domain) lines.push(`website: ${c.website || c.domain}`);
  if (c.description) lines.push(`description: ${c.description}`);
  if (input.websiteText) {
    lines.push("", "WEBSITE TEXT (excerpt):", input.websiteText);
  }
  return { system, prompt: lines.join("\n") };
}

const VALID: Record<string, ProjectFocusValue> = {
  residential: "Residential",
  commercial: "Commercial",
};

/**
 * Parse the model's JSON answer. Tolerates code fences and key variants. Returns
 * null only when nothing parseable is found (caller defaults to Residential).
 */
export function parseProjectFocus(raw: string): ProjectFocusClassification | null {
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

  const rawFocus = o.focus ?? o.project_focus ?? o.projectFocus ?? o.value ?? null;
  const arr: unknown[] = Array.isArray(rawFocus) ? rawFocus : rawFocus != null ? [rawFocus] : [];
  const focus: ProjectFocusValue[] = [];
  for (const item of arr) {
    const v = VALID[String(item).trim().toLowerCase()];
    if (v && !focus.includes(v)) focus.push(v);
  }
  if (!focus.length) return null;

  let confidence = Number(o.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  const reasoning = typeof o.reasoning === "string" ? o.reasoning : undefined;
  return { focus, confidence, reasoning };
}
