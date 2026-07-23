import { ANTI_FORMULAIC_RULE } from "./voiceDefaults.js";
import { truncateAtWord } from "../productinfo.js";
import type { DescVariant, SizeTuple } from "./schema.js";

/**
 * Descriptions — description + meta prompt builders (plan decision 7).
 *
 * Pure assembly: (profile, product facts, reference copy, avoid-list,
 * structure seed) → { system blocks, user message }, no env, no fetch. The
 * Worker's /generate endpoint threads the avoid-list (8 most recent openings
 * in the same brand+collection from the DB + the openings produced earlier in
 * the client run) and a rotating structure seed through these builders so
 * batch output is anti-formulaic BY CONSTRUCTION, not by hoping.
 *
 * Copy style rules baked into every prompt: ~75-word target, never invent
 * specifications, no em dashes, and the company is always "WAC Group", never
 * bare "WAC".
 */

/** Plain system block, structurally compatible with ClaudeSystemBlock. */
export interface PromptSystemBlock {
  type: "text";
  text: string;
}

export interface BuiltPrompt {
  system: PromptSystemBlock[];
  user: string;
}

/** Meta description SEO range (the docx rule: 50-160 characters). */
export const DESC_META_RANGE = { min: 50, max: 160 } as const;

// ---------------------------------------------------------------------------
// Structure seeds — rotating opening-strategy directives
// ---------------------------------------------------------------------------

/**
 * Rotating opening strategies. Each product in a batch gets the next seed, so
 * even a run of similar fixtures opens six different ways before repeating.
 */
export const STRUCTURE_SEEDS: readonly string[] = [
  "Open with the silhouette or the material it is made from.",
  "Open with the quality of the light it casts.",
  "Open with the room or setting it belongs in.",
  "Open with the collection or design heritage behind it.",
  "Open with a functional detail: how it mounts, adjusts, or performs.",
  "Open with the finish and how it plays against its surroundings.",
];

/** The seed for the Nth product of a run (wraps; negative-safe). */
export function structureSeed(index: number): string {
  const n = STRUCTURE_SEEDS.length;
  return STRUCTURE_SEEDS[((Math.trunc(index) % n) + n) % n]!;
}

// ---------------------------------------------------------------------------
// firstSentence — avoid-list entries
// ---------------------------------------------------------------------------

/**
 * The first sentence of a description, for avoid-lists. Falls back to the
 * whole (trimmed) text when there is no terminal punctuation; always capped
 * at 200 chars so a runaway sentence cannot bloat the next prompt.
 */
export function firstSentence(text: string): string {
  const t = text.trim();
  const m = t.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m ? m[0] : t).trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
// clampMetaDescription — over-length metas end on a sentence, not a fragment
// ---------------------------------------------------------------------------

/** Trailing conjunctions/prepositions stripped after a word-boundary cut so a
 * truncated meta never ends "…and" / "…with". */
const DANGLING_TAIL_RE =
  /\s+(?:and|or|but|nor|with|without|for|from|of|in|on|at|by|to|into|onto|over|under|the|a|an|as|plus|via)$/i;

/**
 * Clamp a meta description to the 160-char cap WITHOUT leaving a dangling
 * fragment: prefer cutting at the last complete sentence that fits (and is
 * not shorter than the 50-char floor); otherwise fall back to a word-boundary
 * cut with any trailing conjunction/preposition stripped.
 */
export function clampMetaDescription(text: string): string {
  const t = text.trim();
  if (t.length <= DESC_META_RANGE.max) return t;
  const window = t.slice(0, DESC_META_RANGE.max);
  for (let i = window.length - 1; i >= DESC_META_RANGE.min - 1; i--) {
    const ch = window[i]!;
    if (!".!?".includes(ch)) continue;
    const next = i + 1 < t.length ? t[i + 1]! : " ";
    if (!/\s/.test(next)) continue; // mid-number "26.5" is not a boundary
    return window.slice(0, i + 1).trim();
  }
  return truncateAtWord(t, DESC_META_RANGE.max).replace(DANGLING_TAIL_RE, "");
}

// ---------------------------------------------------------------------------
// Fact sheet
// ---------------------------------------------------------------------------

/** The product facts the description prompt consumes (ParsedProduct subset —
 * desc_products rows satisfy this structurally). */
export interface PromptProduct {
  name: string | null;
  brand: string;
  collection: string;
  year: number;
  family?: string | null;
  product_type?: string | null;
  diffuser_type?: string | null;
  finishes: readonly string[];
  sizes: readonly SizeTuple[];
  cct: readonly string[];
  features: readonly string[];
  model_numbers?: readonly string[];
  attributes?: {
    romance?: string;
    variants?: readonly DescVariant[];
    sheet?: Readonly<Record<string, string>>;
    [k: string]: unknown;
  };
}

export interface ReferenceCopy {
  name: string;
  copy: string;
}

const sizeLine = (s: SizeTuple): string =>
  [s.length ?? "?", s.width ?? "?", s.height ?? "?"].join(" x ");

/** A finish value that is a bare internal code (AB, BK, 26…), not a word.
 * Codes are labeled as such in the fact sheet so the model never expands
 * them into a guessed color or material name. */
export function isFinishCode(value: string): boolean {
  return /^[A-Z0-9]{1,4}$/.test(value.trim());
}

const variantLine = (v: DescVariant): string => {
  const parts = [
    v.finish
      ? isFinishCode(v.finish)
        ? `finish code ${v.finish}`
        : `finish ${v.finish}`
      : null,
    v.cct ? `CCT ${v.cct}` : null,
    v.size ? `size ${v.size}` : null,
  ].filter((p): p is string => !!p);
  return parts.length > 0 ? `${v.model}: ${parts.join(", ")}` : v.model;
};

/**
 * The complete plain-text fact sheet: every field the sheets gave us, nothing
 * else — paired with the "never invent specifications" rule, this is the
 * model's entire universe of facts.
 */
export function buildFactSheet(product: PromptProduct): string {
  const lines: string[] = ["Product fact sheet:"];
  const add = (label: string, value: string | null | undefined) => {
    if (value && value.trim()) lines.push(`- ${label}: ${value.trim()}`);
  };
  add("Name", product.name);
  add("Brand", product.brand);
  add("Collection", product.collection);
  add("Introduction year", String(product.year));
  add("Family", product.family);
  add("Product type", product.product_type);
  add("Diffuser type", product.diffuser_type);
  if (product.finishes.length > 0 && product.finishes.every(isFinishCode)) {
    // Coded-only finishes are labeled at the source: the strongest guard
    // against the model "helpfully" expanding BK or AB into a color name.
    add(
      "Finish codes (internal codes with no stated color or material; NEVER expand or guess what they stand for)",
      product.finishes.join(", "),
    );
  } else {
    add("Finishes", product.finishes.join(", "));
  }
  add(
    "Sizes (L x W x H, inches)",
    product.sizes.map(sizeLine).join("; "),
  );
  add("Color temperatures", product.cct.join(", "));
  if (product.features.length > 0) {
    lines.push("- Features:");
    for (const f of product.features) lines.push(`  - ${f}`);
  }
  const attrs = product.attributes ?? {};
  add("Existing sheet copy (facts only, do not echo its phrasing)", attrs.romance);
  const sheet = attrs.sheet ?? {};
  for (const [key, value] of Object.entries(sheet)) {
    add(key, value);
  }
  const variants = attrs.variants ?? [];
  if (variants.length > 0) {
    lines.push("- Variants (model numbers):");
    for (const v of variants) lines.push(`  - ${variantLine(v)}`);
  } else if (product.model_numbers && product.model_numbers.length > 0) {
    add("Model numbers", product.model_numbers.join(", "));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Description prompt
// ---------------------------------------------------------------------------

export const REFERENCE_BLOCK_LABEL =
  "Examples of this brand's voice (match tone, never copy phrases):";

export interface DescriptionPromptInput {
  profile: { prompt: string; voice_guidance: string };
  product: PromptProduct;
  referenceCopy: readonly ReferenceCopy[];
  avoidOpenings: readonly string[];
  structureSeed: string;
}

/** Base copy rules appended to every description prompt (system side). */
const DESCRIPTION_RULES = [
  "Write about 75 words of flowing catalog prose. Never invent specifications: use only the facts in the fact sheet. No spec-dump sentences; weave the facts into the prose.",
  "If a fact-sheet value is a bare internal code a shopper would not understand (for example a finish given only as a number), leave it out rather than echoing the code.",
  "Never expand or guess what a finish or material code stands for, even when it seems obvious: short codes like BK, AB or WT (or bare numbers) must NEVER be turned into color or material names, because the same code means different things across product lines. When finishes are given only as codes, describe them generically, for example \"offered in two finishes\" or \"in a single finish\". Name a specific color or material ONLY when the fact sheet spells it out in words.",
  "Do not use em dashes. When referring to the company, always write WAC Group, never WAC alone.",
].join("\n");

/**
 * Assemble the description request: system = [voice guidance, reference
 * romance-copy examples, anti-formulaic rules (structure seed + avoid-list)],
 * user = the profile's task prompt + the complete fact sheet.
 */
export function buildDescriptionPrompt(input: DescriptionPromptInput): BuiltPrompt {
  const system: PromptSystemBlock[] = [];
  const guidance = input.profile.voice_guidance.trim();
  if (guidance) system.push({ type: "text", text: guidance });

  if (input.referenceCopy.length > 0) {
    const blocks = input.referenceCopy
      .map((r) => `${r.name}:\n${r.copy.trim().slice(0, 1200)}`)
      .join("\n\n");
    system.push({ type: "text", text: `${REFERENCE_BLOCK_LABEL}\n\n${blocks}` });
  }

  const anti: string[] = [
    ANTI_FORMULAIC_RULE,
    `Opening strategy for THIS product: ${input.structureSeed}`,
  ];
  if (input.avoidOpenings.length > 0) {
    anti.push(
      `Do NOT open with any pattern resembling: ${input.avoidOpenings
        .map((o) => `"${o}"`)
        .join(" | ")}`,
    );
  }
  anti.push(DESCRIPTION_RULES);
  system.push({ type: "text", text: anti.join("\n\n") });

  const user = [input.profile.prompt.trim(), buildFactSheet(input.product)].join(
    "\n\n",
  );
  return { system, user };
}

// ---------------------------------------------------------------------------
// Meta description prompt
// ---------------------------------------------------------------------------

export interface MetaPromptInput {
  product: PromptProduct;
  /** The page's HTML title (override ?? formula) for keyword alignment. */
  title: string;
  /** The CURRENT description (final ?? ai) — edits feed regenerate-meta. */
  description: string;
  avoidMetas: readonly string[];
}

const META_RULES = [
  "You write HTML meta descriptions for lighting product pages.",
  `Rules:
- ${DESC_META_RANGE.min} to ${DESC_META_RANGE.max} characters, one or two plain-text sentences.
- Start with an action-oriented verb (Discover, Explore, Elevate, Bring, Shop, Add...).
- Vary the opening verb from page to page; NEVER reuse the opening verb of any recently used meta description you are shown.
- Work in natural keywords from the product name and type; no keyword stuffing.
- Unique to this page: summarize THIS product's description, do not copy its sentences verbatim.
- No quotation marks around the output, no markdown.
- Do not use em dashes. When referring to the company, always write WAC Group, never WAC alone.
- Output ONLY the meta description text, nothing else.`,
].join("\n");

/**
 * Assemble the meta request from the docx meta rules (50-160 chars, action
 * verb, natural keywords, unique per page) referencing the current
 * description. Kept as a separate call so regenerate-meta after human edits
 * is the identical code path.
 */
export function buildMetaPrompt(input: MetaPromptInput): BuiltPrompt {
  const p = input.product;
  const productLine = [p.name, p.product_type]
    .filter((v): v is string => !!v && v.trim().length > 0)
    .join(" ");
  const userParts = [
    `Page title: ${input.title}`,
    `Product: ${productLine || p.name || "(unnamed)"} (${p.brand} ${p.collection})`,
    `Product description on the page:\n${input.description.trim()}`,
  ];
  if (input.avoidMetas.length > 0) {
    userParts.push(
      `Recently used meta descriptions on sibling pages, or their opening verbs (write something clearly different and start with a DIFFERENT verb): ${input.avoidMetas
        .map((m) => `"${m}"`)
        .join(" | ")}`,
    );
  }
  userParts.push("Write the meta description.");
  return {
    system: [{ type: "text", text: META_RULES }],
    user: userParts.join("\n\n"),
  };
}
