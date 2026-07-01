/**
 * Company "product focus" classification (pure) — does a company sell/focus on
 * **decorative** lighting (Modern Forms / Schonbek style — chandeliers, decorative &
 * fashion fixtures, decorative fans; the Ferguson-type showroom) or **functional**
 * lighting (WAC style — recessed, track, architectural, landscape, electrical supply;
 * the CED/Graybar-type distributor), or both.
 *
 * Mirrors {@link ./projectFocus}. Used for Showroom/Distributor companies: the AI
 * crawls the site and this becomes the source of truth for decorative-vs-functional,
 * which drives the showroom-vs-distributor split and the WAC-vs-MF/Schonbek brand.
 * Deterministic name/MF-account overrides (see companyClassifyOverrides.ts) short-
 * circuit the crawl.
 */

import type { CompanyForClassify } from "./companySubType.js";
import type { ProductFocus } from "./companyClassifyOverrides.js";

/** HubSpot company property (multi-select) this classifier writes. */
export const PRODUCT_FOCUS_PROP = "product_focus";

export type ProductFocusValue = ProductFocus; // "Functional" | "Decorative"

export interface ProductFocusClassification {
  /** Subset of {Functional, Decorative}; never empty after {@link parseProductFocus}. */
  focus: ProductFocusValue[];
  confidence: number;
  reasoning?: string;
}

/** Multi-select write value ("Functional", "Decorative", or "Functional;Decorative"). */
export function productFocusToValue(focus: ProductFocusValue[]): string {
  const seen = new Set<ProductFocusValue>(focus);
  if (!seen.size) seen.add("Functional");
  return [...(seen.has("Functional") ? ["Functional"] : []), ...(seen.has("Decorative") ? ["Decorative"] : [])].join(";");
}

/** Build the Gemini system+prompt for product-focus classification. */
export function buildProductFocusPrompt(input: {
  company: CompanyForClassify;
  websiteText?: string | null;
}): { system: string; prompt: string } {
  const system = [
    "You classify what kind of LIGHTING a company sells or focuses on, from its name, industry, and website.",
    "Choose any that apply from exactly these two values:",
    '- "Decorative": decorative & fashion lighting — chandeliers, pendants, sconces, decorative fixtures and',
    "  fans, interior-design-driven product (Modern Forms / Schonbek style). Retail lighting SHOWROOMS",
    "  (e.g. a Ferguson-style showroom) that display decorative fixtures are Decorative.",
    '- "Functional": architectural / functional / electrical lighting — recessed, track, downlights,',
    "  linear, landscape/outdoor, and electrical SUPPLY/DISTRIBUTION (WAC style). Electrical distributors",
    "  and supply houses (CED, Graybar, City Electric Supply and the like) and electrical contractors are Functional.",
    "",
    "RULES:",
    "- Functional and Decorative are INDEPENDENT — flag each one that the company carries; a",
    "  company can be both. The key question is usually DECORATIVE: does this company carry",
    "  decorative / fashion / chandelier product (route to Modern Forms / Schonbek)?",
    "- An electrical distributor / supply house / electrical contractor / AV integrator ALWAYS",
    "  carries functional product, so it is at least Functional even with a showroom counter;",
    "  add Decorative too if it clearly displays decorative fixtures.",
    "- Trust the website's actual product over a vague name; treat the site as a strong hint.",
    "",
    'Respond with JSON ONLY: {"focus": ["Functional"] | ["Decorative"] | ["Functional","Decorative"],',
    '"confidence": <0..1>, "reasoning": "<short>"}. Never return an empty focus array.',
  ].join("\n");

  const c = input.company;
  const lines: string[] = ["COMPANY:"];
  if (c.name) lines.push(`name: ${c.name}`);
  if (c.industry) lines.push(`industry: ${c.industry}`);
  if (c.website || c.domain) lines.push(`website: ${c.website || c.domain}`);
  if (c.description) lines.push(`description: ${c.description}`);
  if (input.websiteText) lines.push("", "WEBSITE TEXT (excerpt):", input.websiteText);
  return { system, prompt: lines.join("\n") };
}

const VALID: Record<string, ProductFocusValue> = {
  functional: "Functional",
  decorative: "Decorative",
};

/**
 * Parse the model's JSON answer. Tolerates code fences and key variants. Returns null
 * only when nothing parseable is found (caller applies a default).
 */
export function parseProductFocus(raw: string): ProductFocusClassification | null {
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

  const rawFocus = o.focus ?? o.product_focus ?? o.productFocus ?? o.value ?? null;
  const arr: unknown[] = Array.isArray(rawFocus) ? rawFocus : rawFocus != null ? [rawFocus] : [];
  const focus: ProductFocusValue[] = [];
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
