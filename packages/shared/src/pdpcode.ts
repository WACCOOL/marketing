/**
 * Model-code extraction from WAC Group asset filenames.
 *
 * The PIM feed carries no product-page URL and its variant "material numbers"
 * are internal numeric SKUs (e.g. 2095) that brand sites don't index — so a
 * `?s=<sku>` search never resolves. The real, brand-site-indexed model code
 * lives in the asset filenames instead: an image `A1RD-D571F-CCBK_IMRO_1.png`
 * or an IES `A1RD-D571-V0_IESF.zip` both encode the model code `A1RD-D571(F)`.
 *
 * `deriveModelCodes` turns a product's asset URLs into an ordered, de-duped list
 * of candidate model codes to search the brand site with. It intentionally does
 * NOT apply the length/letter usability filter (that lives in the resolver,
 * `apps/products-sync/src/pdp.ts`, and is applied where these candidates are
 * merged with variant SKUs / family / name).
 */

/**
 * Extract the model code from a single asset URL's filename.
 *
 * Asset tags are underscore-delimited (`_IMRO_1`, `_IESF`, `_SPSHT`, `_INSSHT`,
 * `_LINDR`); model codes use hyphens — so the code is everything BEFORE the
 * first underscore of the (extension-stripped) basename.
 */
export function codeFromAssetUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const noQuery = url.split("?")[0] ?? "";
  const rawBasename = noQuery.split("/").pop() ?? "";
  let basename = rawBasename;
  try {
    basename = decodeURIComponent(rawBasename); // handles %28%29 → ()
  } catch {
    basename = rawBasename;
  }
  const noExt = basename.replace(/\.[a-z0-9]+$/i, "");
  const beforeTag = noExt.split("_")[0] ?? "";
  const code = beforeTag.trim().toUpperCase();
  return code || null;
}

/**
 * Gated truncation of a color/finish suffix.
 *
 * Strips the trailing hyphen segment ONLY when it is a color/finish token —
 * finishes come in 2-letter units (WT/BK/BN/CL), optionally doubled for dual
 * finishes (BNWT) or CC-prefixed (CCBK) — AND the truncated stem still carries a
 * digit AND is long enough to stay specific (>= 6). This produces a useful
 * finish-agnostic fallback (`A1RD-D571F-CCBK` → `A1RD-D571F`, `HHT-8145LED-BNWT`
 * → `HHT-8145LED`) while refusing to:
 *   - strip a numeric segment (`-072`, `-96`) — those aren't finishes,
 *   - strip a 3-letter/odd suffix that isn't a finish pair (`LENS-11-HLD`),
 *   - shorten fragile short stems (`A2L30-CL` → `A2L30`, len 5) that mis-resolve.
 */
function gatedTruncate(code: string): string | null {
  const idx = code.lastIndexOf("-");
  if (idx <= 0) return null;
  const trailing = code.slice(idx + 1);
  const stem = code.slice(0, idx);
  if (!/^(CC)?([A-Z]{2}){1,2}$/.test(trailing)) return null; // finish token only
  if (!/\d/.test(stem)) return null;
  if (stem.length < 6) return null;
  return stem;
}

export interface ModelCodeInput {
  primary_image_url?: string | null;
  image_urls?: (string | null)[] | null;
  ies_url?: string | null;
}

/**
 * Ordered, de-duped (case-insensitive) list of candidate model codes to search
 * a brand site with, derived from a product's asset filenames. Image-derived
 * codes rank first (full code, then a gated finish-agnostic truncation), then
 * the IES-derived code (with a trailing `-V<n>` variant marker stripped). Capped
 * at 4 candidates.
 */
export function deriveModelCodes(input: ModelCodeInput): string[] {
  const candidates: string[] = [];
  const push = (c: string | null): void => {
    if (c) candidates.push(c);
  };

  const imageUrls = [input.primary_image_url, ...(input.image_urls ?? [])];
  for (const url of imageUrls) {
    const full = codeFromAssetUrl(url);
    if (!full) continue;
    push(full);
    push(gatedTruncate(full));
  }

  const iesCode = codeFromAssetUrl(input.ies_url);
  if (iesCode) push(iesCode.replace(/-V\d+$/i, "")); // strip variant marker

  // De-dupe case-insensitively, preserving first occurrence; cap at 4.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const key = c.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= 4) break;
  }
  return out;
}
