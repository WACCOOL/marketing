/**
 * Shared PDP taxonomy — the brand-site vocabulary the WIES-method resolver
 * (apps/products-sync/src/pdp.ts) and the Thom web crawl both speak: brand
 * normalization, brand→domain mapping, PDP slug grammar, and the pure
 * spec-sheet URL derivations per brand.
 *
 * Everything here is PURE (no network, no Supabase). Network behavior — brand
 * `?s=` search, Modern Forms template HEAD-probing, cache policy — stays with
 * the resolver. Moved out of products-sync so the crawl's reconciliation pass
 * (plan E) provably shares one vocabulary with the nightly resolver instead of
 * drifting from a copy.
 */

// Raw Sales Layer brand code -> canonical brand (from WIES BRAND_NORMALIZATION).
export const BRAND_NORMALIZATION: Record<string, string> = {
  WAC: "WAC Lighting",
  AISPIRE: "AiSpire",
  SIGNATURE: "Schonbek",
  MOF: "Modern Forms",
  DWEL: "WAC Lighting",
  LIM: "WAC Lighting",
  LANDSCAPE: "WAC Lighting",
  BEYOND: "Schonbek",
  VENTRIX: "WAC Lighting",
  MFF: "Modern Forms",
  FAN: "WAC Lighting",
  HOME: "WAC Lighting",
  FOREVER: "Schonbek",
  COLORSCAPING: "WAC Lighting",
};

export const DOMAIN: Record<string, string> = {
  "WAC Lighting": "waclighting.com",
  "Modern Forms": "modernforms.com",
  AiSpire: "aispire.com",
  Schonbek: "schonbek.com",
};

// Brands whose sites we scrape for a canonical slug. Schonbek is search-only
// (matches WIES brandResolverConfig).
export const SCRAPEABLE = new Set(["WAC Lighting", "Modern Forms", "AiSpire"]);

export const SLUG_RE = /\/product\/([a-z0-9][a-z0-9-]*)\//gi;
export const SKIP_SLUGS = new Set([
  "all", "products", "search", "category", "blog", "support", "yoast-seo-wordpress",
]);

// Schonbek is search-only (no PDP scrape), so its spec sheet comes from a
// per-sub-brand PHP template keyed on PPID. Mirrors WIES's
// SPEC_SHEET_FALLBACK_TEMPLATES.Schonbek.
export const SCHONBEK_SUB_BRAND_SLUGS: Record<string, string> = {
  SIGNATURE: "signatureld",
  BEYOND: "led-beyond1",
  FOREVER: "forever",
};

export interface PdpProduct {
  sku: string; // PPID
  brand: string | null;
  family: string | null;
  name: string | null;
  variants: { sku: string | null }[] | null;
  // Asset URLs — the real brand-site-indexed model code lives in these filenames
  // (see deriveModelCodes). Optional so callers that don't select them still fit.
  primary_image_url?: string | null;
  image_urls?: (string | null)[] | null;
  ies_url?: string | null;
}

export function canonicalBrand(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const up = raw.trim().toUpperCase();
  return BRAND_NORMALIZATION[up] ?? null;
}

/** Canonical PDP URL for a resolved slug, else null (caller keeps its fallback). */
export function canonicalPdpUrl(brand: string, slug: string | null): string | null {
  if (slug && DOMAIN[brand]) return `https://${DOMAIN[brand]}/product/${slug}/`;
  return null;
}

/** First non-junk `/product/<slug>/` slug in an HTML document, else null. */
export function firstSlugFromHtml(html: string | null): string | null {
  if (!html) return null;
  SLUG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SLUG_RE.exec(html)) != null) {
    const slug = m[1]!.toLowerCase();
    if (!SKIP_SLUGS.has(slug)) return slug;
  }
  return null;
}

/**
 * Extract the spec-sheet URL a scrapeable brand's PDP actually links to
 * (WIES tier 2). WAC embeds a WordPress dispatcher `?download=specsN`; AiSpire
 * links a direct S3 `_SPSHT.pdf`, falling back to the install sheet (many
 * AiSpire accessories ship only the latter). Modern Forms is resolved
 * separately (its template index has to be probed live — see products-sync
 * resolveModernFormsSpecSheet).
 */
export function extractSpecSheet(
  brand: string,
  html: string | null,
  slug: string | null,
): string | null {
  if (!html) return null;
  if (brand === "WAC Lighting") {
    const m = html.match(/\?download=specs[a-z0-9]+/i);
    return m && slug ? `https://waclighting.com/product/${slug}/${m[0]}` : null;
  }
  if (brand === "AiSpire") {
    const spec = html.match(/https:\/\/aispire\.s3[^"']+_SPSHT\.pdf/i);
    if (spec) return spec[0];
    const inst = html.match(/https:\/\/aispire\.s3[^"']+_INSSHT\.pdf/i);
    return inst ? inst[0] : null;
  }
  return null;
}

/**
 * Modern Forms serves spec sheets from a dynamic endpoint keyed on the PDP's
 * `data-ppid` plus a template index (`download=specsN`). The template number
 * varies by product and is NOT in the PDP HTML; the endpoint 200s for ANY
 * index, so the caller must HEAD-probe candidates in this order (specs5 covers
 * ~96%) and keep the first that answers `application/pdf`.
 */
export const MODERN_FORMS_SPEC_TEMPLATES = [5, 1, 2, 3, 4, 6, 7, 8];

/** Extract the Modern Forms PPID from a PDP's `data-ppid` attribute. */
export function modernFormsPpid(html: string | null): string | null {
  if (!html) return null;
  const m = html.match(/data-ppid="(\d+)"/);
  return m ? m[1]! : null;
}

/** Build the Modern Forms dynamic-specsheet URL for a PPID + template index. */
export function modernFormsSpecUrl(ppid: string, template: number): string {
  return `https://modernforms.com/dynamic-specsheet/?download=specs${template}&ppid=${ppid}`;
}

/** Schonbek spec-sheet URL from its per-sub-brand PHP template (WIES tier 3).
 *  `rawBrand` is the un-normalized Sales Layer code (SIGNATURE/BEYOND/FOREVER). */
export function schonbekSpecSheet(
  rawBrand: string | null | undefined,
  ppid: string,
): string | null {
  const sub = rawBrand ? SCHONBEK_SUB_BRAND_SLUGS[rawBrand.trim().toUpperCase()] : undefined;
  return sub ? `https://schonbek.com/downloads/specsheet/${sub}.php?ppid=${ppid}` : null;
}
