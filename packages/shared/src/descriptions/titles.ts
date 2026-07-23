import { SEO_RULES } from "../productinfo.js";

/**
 * Descriptions — deterministic HTML title formulas (plan decision 6).
 *
 * Titles are NEVER AI-generated and NEVER stored: they are computed at
 * read/export time from the product's fields, with `desc_content.
 * title_override` taking precedence when an editor saved a manual title.
 * Formulas are pinned to the "2026 Title Tag Prompt" docx examples:
 *
 *   Schonbek       Bordeaux | 5770 | Luxury Crystal Chandelier | Schonbek
 *   WAC Lighting   CAPULET PENDANT | WAC LIGHTING
 *   Modern Forms   Austen Pendant - Modern Forms     (hyphen, never a dash)
 *
 * The Schonbek item number is the docx's "Item # (Do not use Letters)": the
 * primary model base stripped to digits. Anything else (WAC Architectural,
 * Aispire, unknown brands) falls back to `{name} {type} | {brand}` until a
 * formula is provided.
 *
 * Length is soft: the 50-60 SEO range drives a badge in the UI, but the
 * formula output is never truncated (a truncated title tag is worse than a
 * long one; the editor overrides instead).
 */

/** Soft SEO title length range (drives the green/amber badge, no truncation).
 * Kept equal to SEO_RULES.seo_title — titles.test.ts enforces the tie. */
export const DESC_TITLE_RANGE = { min: 50, max: 60 } as const;

/** True when the title length sits inside the soft SEO range. */
export function titleLengthOk(title: string): boolean {
  return title.length >= DESC_TITLE_RANGE.min && title.length <= DESC_TITLE_RANGE.max;
}

/** Title Case: capitalize after start, whitespace, hyphen and slash;
 * everything else lowercased ("BORDEAUX" → "Bordeaux", "SEMI-FLUSH" →
 * "Semi-Flush"). Tokens containing a digit pass through VERBATIM so
 * temp-base names ("41KJ0808") and codes never get case-mangled. */
export function titleCaseName(value: string): string {
  return value.replace(/[^\s\-\/(]+/g, (token) =>
    /\d/.test(token)
      ? token
      : token
          .toLowerCase()
          .replace(/^[a-z]/, (ch) => ch.toUpperCase()),
  );
}

/**
 * The docx "Item # (Do not use Letters)": the digits of the model base's
 * first separator-delimited segment. Covers the real shapes —
 *   `BXX55401O`  → `55401`  (letters stripped, including the trailing O)
 *   `31MM0612`   → `310612` (letter-interleaved temp numbers keep ALL digits)
 *   `S6320-401H` → `6320`   (the leading item number, not a mashed 6320401)
 */
export function itemNumberDigits(modelBase: string | null | undefined): string {
  const segment = (modelBase ?? "").trim().split(/[^A-Za-z0-9]/, 1)[0] ?? "";
  return segment.replace(/[^0-9]/g, "");
}

export interface TitleInput {
  brand: string;
  collection?: string | null;
  name: string | null;
  productType?: string | null;
  /** Ordered model bases; the FIRST is the primary (Schonbek item number). */
  modelBases: readonly string[];
}

const joinPresent = (parts: (string | null | undefined)[], sep: string): string =>
  parts.filter((p): p is string => !!p && p.trim().length > 0).join(sep);

/**
 * Deterministic per-brand title formula. Missing pieces (no product type yet,
 * no model base) drop out of the formula cleanly rather than leaving dangling
 * separators. Output is never truncated — the UI shows a length badge against
 * DESC_TITLE_RANGE instead.
 */
export function titleFor(input: TitleInput): string {
  const brand = input.brand.trim();
  const name = input.name?.trim() ?? "";
  const type = input.productType?.trim() ?? "";
  const brandKey = brand.toLowerCase();

  if (brandKey === "schonbek") {
    const digits = itemNumberDigits(input.modelBases[0]);
    return joinPresent(
      [
        titleCaseName(name),
        digits,
        joinPresent(["Luxury Crystal", titleCaseName(type)], " "),
        "Schonbek",
      ],
      " | ",
    );
  }

  if (brandKey === "wac lighting") {
    return joinPresent(
      [joinPresent([name.toUpperCase(), type.toUpperCase()], " "), "WAC LIGHTING"],
      " | ",
    );
  }

  if (brandKey === "modern forms") {
    // Hyphen by the copy style rule — never an em or en dash.
    return joinPresent(
      [joinPresent([titleCaseName(name), titleCaseName(type)], " "), "Modern Forms"],
      " - ",
    );
  }

  // Fallback (WAC Architectural / Aispire / unknown) until a formula exists.
  return joinPresent([joinPresent([name, type], " "), brand], " | ");
}
