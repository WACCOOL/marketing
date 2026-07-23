/**
 * Phase 2 — Product Information (PRD §6): pure logic for romance copy / SEO /
 * normalization. The API Worker and the web UI both import from here so the
 * rules (field names, SEO limits, CCT canonicalization, CSV shape) stay in one
 * place.
 */

/** Content fields stored in product_content. Open-ended by design — adding an
 * attribute here (lumens, …) needs no DB migration. */
export const PRODUCT_CONTENT_FIELDS = [
  "romance_copy",
  "seo_title",
  "seo_meta_description",
  "h1",
  "url_slug",
  "canonical_url",
  "meta_robots",
  "og_title",
  "og_description",
  "og_image",
  "cct",
  "cct_type",
  "beam",
  "voltage",
  "family_summary",
] as const;
export type ProductContentField = (typeof PRODUCT_CONTENT_FIELDS)[number];

/** The AI-generated SEO text fields (the rest are deterministic or picked). */
export const SEO_TEXT_FIELDS = [
  "seo_title",
  "seo_meta_description",
  "h1",
  "og_title",
  "og_description",
] as const;

/** All fields managed by the SEO workflow. */
export const SEO_FIELDS = [
  "seo_title",
  "seo_meta_description",
  "h1",
  "url_slug",
  "canonical_url",
  "meta_robots",
  "og_title",
  "og_description",
  "og_image",
] as const;

/** Constant head values — not stored per product, emitted on export. */
export const SEO_CONSTANTS = {
  og_type: "product",
  twitter_card: "summary_large_image",
} as const;

/** The fields the Data Normalization workflow manages. */
export const NORMALIZE_FIELDS = ["cct", "cct_type", "beam", "voltage"] as const;
export type NormalizeField = (typeof NORMALIZE_FIELDS)[number];

export type ProductContentStatus =
  | "none"
  | "generated"
  | "in_review"
  | "approved";

// ---------------------------------------------------------------------------
// SEO length rules (per the SEO field spec): title 50–60, meta 150–160,
// og:title ≤60, og:description ≤200. `max` is enforced at approval; `min`
// is a soft warning (an under-length title is weak, not invalid).
// ---------------------------------------------------------------------------

export const SEO_RULES: Record<string, { min?: number; max: number }> = {
  seo_title: { min: 50, max: 60 },
  seo_meta_description: { min: 150, max: 160 },
  h1: { max: 80 },
  og_title: { max: 60 },
  og_description: { max: 200 },
};

/** Hard per-field character caps (max of SEO_RULES) for plain-string lookups. */
export const FIELD_LIMITS: Record<string, number> = Object.fromEntries(
  Object.entries(SEO_RULES).map(([k, v]) => [k, v.max]),
);

/** Back-compat alias used by prompts/tests: the hard caps with known keys. */
export const SEO_LIMITS = {
  seo_title: 60,
  seo_meta_description: 160,
  h1: 80,
  og_title: 60,
  og_description: 200,
} as const;

// ---------------------------------------------------------------------------
// URL slug + canonical URL (deterministic, never AI)
// ---------------------------------------------------------------------------

/** Lowercase-hyphenated URL slug from a product name. */
export function slugifyName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[®™©]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export function isValidUrlSlug(slug: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

/** Brand → production site origin. Canonical URLs are generated from these
 * and remain editable before approval (the path scheme is the website's
 * call — this produces a best-guess absolute, self-referencing URL). */
export const BRAND_SITES: Record<string, string> = {
  wac: "https://www.waclighting.com",
  "wac lighting": "https://www.waclighting.com",
  "wac landscape": "https://www.waclighting.com",
  "wac architectural": "https://www.wacarchitectural.com", // apex 301s to www
  "modern forms": "https://modernforms.com",
  schonbek: "https://schonbek.com",
};
const DEFAULT_BRAND_SITE = "https://www.waclighting.com";

/** Brands whose PDPs are not slug-addressable. wacarchitectural.com serves
 * product pages at /na/product-detail/{numericId} — the id can't be derived
 * from the product name, so the brand site itself is the best pre-approval
 * guess (editors paste the real PDP URL before approving). */
const NO_SLUG_PDP_BRANDS = new Set(["wac architectural"]);

export function brandSite(brand: string | null | undefined): string {
  return BRAND_SITES[(brand ?? "").trim().toLowerCase()] ?? DEFAULT_BRAND_SITE;
}

export function canonicalUrlFor(
  brand: string | null | undefined,
  slug: string,
): string {
  const site = brandSite(brand);
  if (NO_SLUG_PDP_BRANDS.has((brand ?? "").trim().toLowerCase())) return site;
  return `${site}/products/${slug}`;
}

// ---------------------------------------------------------------------------
// Canonical brands (SEO title tags)
// ---------------------------------------------------------------------------

/** The only brand names allowed in customer-facing SEO copy (per Davis). */
export const CANONICAL_BRANDS = [
  "WAC Lighting",
  "WAC Architectural",
  "Modern Forms",
  "Schonbek",
  "Aispire",
] as const;

export type CanonicalBrand = (typeof CANONICAL_BRANDS)[number];

/** Exact brand-field values (lowercased) → canonical brand. Sub-brand labels
 * fold into their parent: Ventrix/Limited/Dwel(ed) are WAC Lighting lines;
 * Beyond/Signature/Forever are Schonbek collections; Modern Forms Fans is
 * Modern Forms. Bare "WAC" and "WAC Landscape" are WAC Lighting (confirmed). */
const BRAND_ALIASES: Record<string, CanonicalBrand> = {
  wac: "WAC Lighting",
  "wac lighting": "WAC Lighting",
  "wac landscape": "WAC Lighting",
  "wac architectural": "WAC Architectural",
  ventrix: "WAC Lighting",
  limited: "WAC Lighting",
  dwel: "WAC Lighting",
  dweled: "WAC Lighting",
  "modern forms": "Modern Forms",
  "modern forms fans": "Modern Forms",
  schonbek: "Schonbek",
  beyond: "Schonbek",
  signature: "Schonbek",
  forever: "Schonbek",
  "schonbek beyond": "Schonbek",
  "schonbek signature": "Schonbek",
  "schonbek forever": "Schonbek",
  aispire: "Aispire",
};

// Unambiguous sub-brand tokens that may appear inside a longer brand string or
// a product name (e.g. "dwelLED Puck"). Generic words like "limited" or
// "beyond" are deliberately excluded here — they only count as exact brand
// values above, never as substrings.
const BRAND_TOKEN_HINTS: [RegExp, CanonicalBrand][] = [
  [/\bventrix\b/i, "WAC Lighting"],
  [/\bdwell?ed\b/i, "WAC Lighting"],
  [/\bdwel\b/i, "WAC Lighting"],
  [/\baispire\b/i, "Aispire"],
  [/\bschonbek\b/i, "Schonbek"],
  [/\bmodern forms\b/i, "Modern Forms"],
];

/**
 * Resolve a PIM brand value (plus optionally the product name, for sub-brand
 * lines like dwelLED that surface only in the name) to one of the canonical
 * customer-facing brands. Returns null when no rule matches — callers should
 * surface that for a human call rather than guess.
 */
export function normalizeBrand(
  brand: string | null | undefined,
  productName?: string | null,
): CanonicalBrand | null {
  const key = (brand ?? "").trim().toLowerCase();
  if (key && BRAND_ALIASES[key]) return BRAND_ALIASES[key];
  for (const [re, canonical] of BRAND_TOKEN_HINTS) {
    if (key && re.test(key)) return canonical;
    if (productName && re.test(productName)) return canonical;
  }
  return null;
}

/**
 * Deterministic title-tag default: {Product Name} – {Differentiator/Category}
 * | {Brand}. The middle segment is the category until a curated differentiator
 * exists; segments without data drop out cleanly.
 */
export function defaultSeoTitle(input: {
  name: string;
  category?: string | null;
  brand?: string | null;
}): string {
  const brand = normalizeBrand(input.brand, input.name);
  const middle = input.category?.trim();
  return [
    input.name.trim(),
    ...(middle ? [`– ${middle}`] : []),
    ...(brand ? [`| ${brand}`] : []),
  ].join(" ");
}

/**
 * og:image default: the first product image — preferring the shot whose
 * filename ends in image-number 1 (…-1.jpg / …_01.png), which is the PIM's
 * hero angle — falling back to the first URL.
 */
export function defaultOgImage(imageUrls: readonly string[]): string | null {
  const hero = imageUrls.find((u) =>
    /[-_]0*1\.(?:jpe?g|png|webp|avif)(?:\?.*)?$/i.test(u),
  );
  return hero ?? imageUrls[0] ?? null;
}

// ---------------------------------------------------------------------------
// Existing romance copy lookup (PIM raw_json)
// ---------------------------------------------------------------------------

/** WAC's connector stores romance copy in `zromnce` (confirmed against the
 * live schema); the regex is a fallback for renamed/added fields. An env
 * override (SALES_LAYER_ROMANCE_FIELD) pins it explicitly. */
const ROMANCE_FIELD_CANDIDATES = ["zromnce", "romance_copy", "romance"];
const ROMANCE_KEY_RE =
  /romance|long[ _-]?desc|marketing[ _-]?desc|web[ _-]?desc/i;

/**
 * Pull a product's existing marketing ("romance") copy out of its raw PIM
 * JSON. Shared by the Product Info SEO flow and the Descriptions voice
 * derivation (both need the same brand-voice reference text).
 */
export function extractExistingCopy(
  raw: Record<string, unknown>,
  preferredKey?: string,
): string | null {
  const get = (key: string): string | null => {
    const v = raw[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  if (preferredKey) return get(preferredKey);
  for (const key of ROMANCE_FIELD_CANDIDATES) {
    const hit = get(key);
    if (hit) return hit;
  }
  let best: string | null = null;
  for (const key of Object.keys(raw)) {
    if (!ROMANCE_KEY_RE.test(key)) continue;
    const value = get(key);
    // Prefer the longest match — long descriptions beat one-line blurbs.
    if (value && (!best || value.length > best.length)) best = value;
  }
  return best;
}

/** Truncate to `max` chars without cutting a word in half (best effort: falls
 * back to a hard cut when the first word is already longer than max). */
export function truncateAtWord(value: string, max: number): string {
  const s = value.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  const out = lastSpace > 0 ? cut.slice(0, lastSpace) : s.slice(0, max);
  return out.replace(/[\s,;:–—-]+$/, "");
}

// ---------------------------------------------------------------------------
// CCT normalization (PRD §6.3)
// ---------------------------------------------------------------------------

export type CctParse =
  | { ok: true; normalized: string; kind: "single" | "multi" | "range" }
  | { ok: false; reason: string };

/** Plausible architectural-lighting CCT bounds; anything outside is flagged
 * rather than silently "fixed" (e.g. the catalog typo `300k` is NOT assumed to
 * mean 3000K). */
const CCT_MIN = 1000;
const CCT_MAX = 10000;

/** Parse one CCT component like "3000", "3000k", "3000 K". */
function parseCctComponent(part: string): number | { reason: string } {
  // Thousands separator ("2,700K") — strip before the multi-value split has a
  // chance to misread it (handled by caller passing pre-stripped text).
  const m = part.trim().match(/^(\d+(?:\.\d+)?)\s*k?$/);
  if (!m) return { reason: `unrecognized component "${part.trim()}"` };
  const n = Number(m[1]);
  if (!Number.isInteger(n)) return { reason: `non-integer value "${part.trim()}"` };
  if (n < CCT_MIN || n > CCT_MAX) {
    return { reason: `${n} is outside the plausible CCT range (${CCT_MIN}–${CCT_MAX}K)` };
  }
  return n;
}

/**
 * Normalize a raw CCT attribute value to the canonical website format:
 *   - single value  → `3000K`
 *   - selectable    → `3000K/5000K` (ascending, de-duplicated)
 *   - range/tunable → `3000K–5000K` (en dash)
 * Anything that can't be confidently parsed returns `{ ok: false, reason }`
 * so the caller flags it for manual resolution instead of mangling it.
 */
export function normalizeCct(raw: string | null | undefined): CctParse {
  if (raw == null) return { ok: false, reason: "empty value" };
  let s = raw
    .toLowerCase()
    .replace(/kelvin/g, "k")
    .replace(/[‐-―]/g, "-") // unicode dashes → ascii
    .replace(/\s+to\s+/g, "-")
    .trim();
  if (s.length === 0) return { ok: false, reason: "empty value" };
  // Thousands separators: "2,700k" → "2700k" (digit,3-digits) so the comma
  // multi-split below doesn't shred it.
  s = s.replace(/(\d),(\d{3})(?!\d)/g, "$1$2");

  const isRange = s.includes("-");
  const multiParts = s.split(/[\/,&+]/).map((p) => p.trim()).filter(Boolean);

  if (isRange) {
    if (multiParts.length > 1) {
      return { ok: false, reason: "mixed range and multi-value separators" };
    }
    const ends = s.split("-").map((p) => p.trim()).filter(Boolean);
    if (ends.length !== 2) {
      return { ok: false, reason: "range does not have exactly two endpoints" };
    }
    const lo = parseCctComponent(ends[0]!);
    const hi = parseCctComponent(ends[1]!);
    if (typeof lo !== "number") return { ok: false, reason: lo.reason };
    if (typeof hi !== "number") return { ok: false, reason: hi.reason };
    if (lo >= hi) {
      return { ok: false, reason: `range ${lo}–${hi} is not ascending` };
    }
    return { ok: true, normalized: `${lo}K–${hi}K`, kind: "range" };
  }

  const values: number[] = [];
  for (const part of multiParts) {
    const v = parseCctComponent(part);
    if (typeof v !== "number") return { ok: false, reason: v.reason };
    values.push(v);
  }
  if (values.length === 0) return { ok: false, reason: "empty value" };

  const unique = [...new Set(values)].sort((a, b) => a - b);
  if (unique.length === 1) {
    return { ok: true, normalized: `${unique[0]}K`, kind: "single" };
  }
  return {
    ok: true,
    normalized: unique.map((v) => `${v}K`).join("/"),
    kind: "multi",
  };
}

/** True when a raw CCT field explicitly says "no value" (e.g. `N/A` on
 * drivers/accessories) — callers skip these rather than flagging them. */
export function isCctNoValue(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  return /^(n\/?a|none|tbd|-+|–+)$/i.test(raw.trim()) || raw.trim() === "";
}

/**
 * Roll variant-level CCT values up to one canonical product (PPID) value:
 *   - every variant parses to the same thing → that value
 *   - all parse to singles/multis        → combined multi (sorted, unique)
 *   - exactly one distinct range          → that range
 *   - anything else (unparseable variant, range mixed with other values,
 *     multiple distinct ranges)           → flagged for manual resolution
 */
export function combineCcts(raws: string[]): CctParse {
  const values = [...new Set(raws.filter((r) => !isCctNoValue(r)))];
  if (values.length === 0) return { ok: false, reason: "no CCT values" };

  const parsed: Extract<CctParse, { ok: true }>[] = [];
  let failed = 0;
  for (const raw of values) {
    const p = normalizeCct(raw);
    if (p.ok) parsed.push(p);
    else failed++;
  }
  if (failed > 0) {
    return {
      ok: false,
      reason: `${failed} of ${values.length} variant value${values.length === 1 ? "" : "s"} could not be parsed`,
    };
  }

  const ranges = [...new Set(parsed.filter((p) => p.kind === "range").map((p) => p.normalized))];
  const singles = new Set<number>();
  for (const p of parsed) {
    if (p.kind === "range") continue;
    for (const part of p.normalized.split("/")) singles.add(Number(part.replace(/k$/i, "")));
  }

  if (ranges.length > 1 || (ranges.length === 1 && singles.size > 0)) {
    return { ok: false, reason: "variants mix ranges and fixed CCT values" };
  }
  if (ranges.length === 1) return { ok: true, normalized: ranges[0]!, kind: "range" };

  const sorted = [...singles].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return { ok: true, normalized: `${sorted[0]}K`, kind: "single" };
  }
  return {
    ok: true,
    normalized: sorted.map((v) => `${v}K`).join("/"),
    kind: "multi",
  };
}

// ---------------------------------------------------------------------------
// Beam normalization — zbeam_descript is categorical with case/abbreviation
// drift ("Asymmetrical" vs "Asym" vs "ASYM") and comma-separated multis.
// ---------------------------------------------------------------------------

const BEAM_CANON: Record<string, string> = {
  spot: "Spot",
  flood: "Flood",
  narrow: "Narrow",
  wide: "Wide",
  "narrow flood": "Narrow Flood",
  "wide flood": "Wide Flood",
  "ultra narrow": "Ultra Narrow",
  "ultra spot": "Ultra Spot",
  asym: "Asymmetrical",
  asymmetrical: "Asymmetrical",
  elliptical: "Elliptical",
  adjustable: "Adjustable",
};

export function normalizeBeam(raw: string | null | undefined): CctParse {
  if (raw == null || !raw.trim()) return { ok: false, reason: "empty value" };
  const parts = raw
    .split(/[,\/]/)
    .map((p) => p.trim().toLowerCase().replace(/\s+/g, " "))
    .filter(Boolean);
  if (parts.length === 0) return { ok: false, reason: "empty value" };
  const out: string[] = [];
  for (const part of parts) {
    const canon = BEAM_CANON[part];
    if (!canon) return { ok: false, reason: `unrecognized beam "${part}"` };
    if (!out.includes(canon)) out.push(canon);
  }
  return {
    ok: true,
    normalized: out.join("/"),
    kind: out.length > 1 ? "multi" : "single",
  };
}

// ---------------------------------------------------------------------------
// Input-voltage normalization — zvoltin drifts between "120-277 VAC",
// "120-277V", "120 -277 VAC", etc. Canonical: "<n> VAC", "<n> VDC",
// "<n> VAC/VDC", "<lo>-<hi> VAC".
// ---------------------------------------------------------------------------

export function normalizeVoltage(raw: string | null | undefined): CctParse {
  if (raw == null || !raw.trim()) return { ok: false, reason: "empty value" };
  const s = raw
    .trim()
    .toUpperCase()
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ");
  const m = s.match(
    /^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?\s*(VAC\/(?:V?DC)|VAC|VDC|V\s*AC|V\s*DC|V)$/,
  );
  if (!m) return { ok: false, reason: `unrecognized voltage "${raw.trim()}"` };
  const lo = Number(m[1]);
  const hi = m[2] !== undefined ? Number(m[2]) : null;
  if (hi !== null && lo >= hi) {
    return { ok: false, reason: `range ${lo}-${hi} is not ascending` };
  }
  let unit = m[3]!.replace(/\s+/g, "");
  if (unit.startsWith("VAC/")) unit = "VAC/VDC";
  else if (unit === "VAC" || unit === "VDC") {
    // already canonical
  } else if (unit === "V") {
    // Bare "V" at mains voltage is AC in this catalog; low-voltage bare "V"
    // is ambiguous (12V landscape is AC, 24V is often DC) — flag it.
    if (lo >= 100) unit = "VAC";
    else return { ok: false, reason: `ambiguous unit in "${raw.trim()}" (AC or DC?)` };
  } else {
    unit = "V" + unit.slice(1).replace(/\s/g, ""); // "V AC" -> "VAC"
  }
  const range = hi !== null ? `${lo}-${hi}` : `${lo}`;
  return { ok: true, normalized: `${range} ${unit}`, kind: hi !== null ? "range" : "single" };
}

// ---------------------------------------------------------------------------
// Normalization registry — one entry per managed field: how to read the raw
// value off a variant, how to parse it, and how to roll variants up to the
// product (PPID) level.
// ---------------------------------------------------------------------------

export interface NormalizerSpec {
  label: string;
  /** Key on the synced variant row holding the raw value. */
  variantKey: string;
  parse: (raw: string | null | undefined) => CctParse;
  /** Roll distinct variant raw values up to one product-level value. */
  combine: (raws: string[]) => CctParse;
}

/** Generic roll-up for categorical fields: parse every distinct value, union
 * the resulting components, flag if anything fails to parse. */
function combineCategorical(
  parse: (raw: string | null | undefined) => CctParse,
): (raws: string[]) => CctParse {
  return (raws) => {
    const values = [...new Set(raws.filter((r) => !isCctNoValue(r)))];
    if (values.length === 0) return { ok: false, reason: "no values" };
    const out: string[] = [];
    for (const raw of values) {
      const p = parse(raw);
      if (!p.ok) {
        return { ok: false, reason: `variant value "${raw}" could not be parsed` };
      }
      for (const part of p.normalized.split("/")) {
        if (!out.includes(part)) out.push(part);
      }
    }
    return {
      ok: true,
      normalized: out.join("/"),
      kind: out.length > 1 ? "multi" : "single",
    };
  };
}

/** Voltage roll-up: variants should agree; differing electrical specs across
 * finishes are a data problem a human should look at. */
function combineVoltage(raws: string[]): CctParse {
  const values = [...new Set(raws.filter((r) => !isCctNoValue(r)))];
  if (values.length === 0) return { ok: false, reason: "no values" };
  const parsed = values.map(normalizeVoltage);
  const bad = parsed.find((p) => !p.ok);
  if (bad && !bad.ok) return bad;
  const distinct = [...new Set(parsed.map((p) => (p as { normalized: string }).normalized))];
  if (distinct.length > 1) {
    return { ok: false, reason: `variants differ: ${distinct.join(" vs ")}` };
  }
  return { ok: true, normalized: distinct[0]!, kind: "single" };
}

export const NORMALIZERS: Record<NormalizeField, NormalizerSpec> = {
  cct: {
    label: "CCT",
    variantKey: "cct_desc",
    parse: normalizeCct,
    combine: combineCcts,
  },
  beam: {
    label: "Beam",
    variantKey: "beam_desc",
    parse: normalizeBeam,
    combine: combineCategorical(normalizeBeam),
  },
  voltage: {
    label: "Input voltage",
    variantKey: "volt_in",
    parse: normalizeVoltage,
    combine: combineVoltage,
  },
  // cct_type classifies from BOTH the zcct code and zcct_desc; `parse` covers
  // the registry contract (code only), but the API calls classifyCctType with
  // both signals where it has the full variant in hand.
  cct_type: {
    label: "CCT Type",
    variantKey: "cct_code",
    parse: (raw) => classifyCctType(raw, null),
    combine: combineCctTypes,
  },
};

// ---------------------------------------------------------------------------
// CCT type classification — Fixed CCT vs CCT Selectable vs CCT Tunable vs
// Color Changing. The PIM encodes this in the zcct code (CS = color select,
// TWA/TWB = tunable white, numeric = fixed); the parsed zcct_desc is the
// fallback signal (multi → selectable, range → tunable, single → fixed).
// ---------------------------------------------------------------------------

export const CCT_TYPES = [
  "Fixed CCT",
  "CCT Selectable",
  "CCT Tunable",
  "Color Changing",
] as const;

export function classifyCctType(
  code: string | null | undefined,
  desc: string | null | undefined,
): CctParse {
  const c = (code ?? "").trim().toUpperCase();
  if (c.startsWith("TW")) {
    return { ok: true, normalized: "CCT Tunable", kind: "single" };
  }
  if (c.endsWith("CS")) {
    return { ok: true, normalized: "CCT Selectable", kind: "single" };
  }
  if (c === "CC" || c.includes("RGB")) {
    return { ok: true, normalized: "Color Changing", kind: "single" };
  }
  const d = (desc ?? "").trim();
  // "RGB", "Color Changing", and spelled-out channel lists like "R, G, B, …".
  if (/rgb|color.?changing|(^|[^a-z])r\s*,\s*g\s*,\s*b([^a-z]|$)/i.test(d)) {
    return { ok: true, normalized: "Color Changing", kind: "single" };
  }
  const parsed = normalizeCct(d);
  if (parsed.ok) {
    const type =
      parsed.kind === "range"
        ? "CCT Tunable"
        : parsed.kind === "multi"
          ? "CCT Selectable"
          : "Fixed CCT";
    return { ok: true, normalized: type, kind: "single" };
  }
  return {
    ok: false,
    reason: `cannot classify CCT type from code "${code ?? ""}" / "${desc ?? ""}"`,
  };
}

/** Product-level CCT type: variants must agree, else a human decides. */
export function combineCctTypes(types: string[]): CctParse {
  const distinct = [...new Set(types.filter((t) => t && !isCctNoValue(t)))];
  if (distinct.length === 0) return { ok: false, reason: "no values" };
  if (distinct.length > 1) {
    return { ok: false, reason: `variants mix CCT types: ${distinct.join(", ")}` };
  }
  return { ok: true, normalized: distinct[0]!, kind: "single" };
}

/** Keys in upstream PIM records that plausibly hold a CCT value. */
const CCT_KEY_RE = /(^|[^a-z])(cct|colou?r[ _-]?temp(erature)?s?|kelvin)/i;

/**
 * Find the raw CCT value in an upstream PIM record (products.raw_json). Key
 * match is heuristic because Sales Layer field names are tenant-defined; pass
 * `preferredKey` (e.g. from an env override) to pin the exact field. Returns
 * de-duplicated values joined with "/" when several CCT-ish keys exist.
 */
export function extractRawCct(
  record: Record<string, unknown>,
  preferredKey?: string,
): string | null {
  const asText = (v: unknown): string | null => {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (Array.isArray(v)) {
      const parts = v
        .map(asText)
        .filter((p): p is string => p !== null);
      return parts.length ? [...new Set(parts)].join("/") : null;
    }
    return null;
  };

  if (preferredKey) {
    const direct = asText(record[preferredKey]);
    return direct;
  }
  const found: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (!CCT_KEY_RE.test(key)) continue;
    const text = asText(value);
    if (text) found.push(text);
  }
  if (found.length === 0) return null;
  return [...new Set(found)].join("/");
}

// ---------------------------------------------------------------------------
// CSV export (PRD §6: Excel/CSV is the interim hand-off to other systems)
// ---------------------------------------------------------------------------

function csvCell(value: string | null | undefined): string {
  const s = value ?? "";
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC-4180-ish CSV (CRLF rows). Callers prepend a UTF-8 BOM when the file is
 * destined for Excel. */
export function toCsv(
  headers: string[],
  rows: (string | null | undefined)[][],
): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Family copy comparison — sibling PPIDs in a family (e.g. CALLIOPE's four
// products) should share a base story and differ only where the products
// differ. Sentences shared by EVERY member render as common; the rest are
// the per-product differences the UI highlights.
// ---------------------------------------------------------------------------

export interface DiffSentence {
  text: string;
  common: boolean;
}

export function diffFamilyCopies(copies: string[]): DiffSentence[][] {
  const split = (c: string) =>
    c
      .split(/(?<=[.!?])\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
  const norm = (t: string) =>
    t.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
  const all = copies.map(split);
  const counts = new Map<string, number>();
  for (const sentences of all) {
    for (const n of new Set(sentences.map(norm))) {
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }
  return all.map((sentences) =>
    sentences.map((text) => ({
      text,
      common: copies.length > 1 && (counts.get(norm(text)) ?? 0) === copies.length,
    })),
  );
}
