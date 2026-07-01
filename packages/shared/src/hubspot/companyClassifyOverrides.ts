/**
 * Deterministic company classification overrides — skip the AI crawl when the answer
 * is already known. Used by the product-focus (decorative vs functional) classifier.
 *
 * Two sources, checked in order:
 *   1. NAME_OVERRIDES — a Davis-curated list of company-name patterns. Seed ONLY with
 *      confirmed names; grow it deliberately (don't guess — e.g. YLighting is e-commerce,
 *      not a decorative showroom, so it's out of scope, not a decorative override).
 *   2. `account_number_` starting with "MF" — a Modern Forms account → decorative.
 */

export type ProductFocus = "Functional" | "Decorative";

/** Curated company-name → product focus. `re` is matched (case-insensitive) on the name. */
export const NAME_OVERRIDES: { re: RegExp; product: ProductFocus }[] = [
  // Electrical distributors → functional (WAC).
  { re: /\bgraybar\b/i, product: "Functional" },
  { re: /\bced\b/i, product: "Functional" }, // Consolidated Electrical Distributors
  // Decorative showrooms → decorative (Modern Forms / Schonbek).
  { re: /\bferguson\b/i, product: "Decorative" },
];

/** A Modern Forms account number (starts with "MF") → decorative. */
export function mfAccount(accountNumber: string | null | undefined): boolean {
  return /^\s*mf/i.test(accountNumber ?? "");
}

/**
 * True when a company's NAME marks it an electrical business — an electrical supply
 * house / distributor / contractor / "… Electric Co." (e.g. "City Electric Supply",
 * "Electrical Distributors", "Wholesale Electric", "Stokes Electric Company", "ABC
 * Electric"). Such a company ALWAYS carries functional product, so the classifier pins
 * Functional and only asks the AI whether it ALSO carries decorative.
 *
 * Deliberately NAME-based, not sub-type-based: the legacy `company_sub_type` (Distributor
 * / Dealer / …) is the polluted field product_focus exists to bypass — e.g. "Lighting
 * Incorporated" is tagged "Distributor" but is a decorative showroom. Decorative
 * showrooms are named "… Lighting / Gallery / Illumination", not "… Electric", so
 * matching the "Electric(al)" business token stays clear of them. The pin is additive
 * (it only guarantees Functional), so a rare decorative shop named "… Electric" just also
 * gets a WAC lead — it never loses its decorative one.
 */
export function nameIsElectricalBusiness(name: string | null | undefined): boolean {
  const n = (name ?? "").toLowerCase().trim();
  if (!n) return false;
  return (
    // "Electric(al) Supply / Distributors / Wholesale", "Wholesale Electric"
    /\belectric(al)?\s+(supply|supplies|distribut|wholesale)/.test(n) ||
    /\bwholesale\s+electric(al)?\b/.test(n) ||
    // "… Electric(al) Co./Company/Corp/Inc/Contractor(s)/Service(s)"
    /\belectric(al)?\s+(co\b|co\.|company|corp|corporation|inc\b|incorporated|contractor|contractors|service|services)/.test(n) ||
    // trailing "… Electric" / "… Electrical" (e.g. "Stokes Electric", "ABC Electrical")
    /\belectric(al)?\s*$/.test(n)
  );
}

/**
 * Deterministic product focus for a company, or null if no override applies (→ crawl).
 * Name overrides win; then the MF-account rule.
 */
export function overrideFor(input: {
  name?: string | null;
  accountNumber?: string | null;
}): ProductFocus | null {
  const name = input.name ?? "";
  for (const o of NAME_OVERRIDES) if (o.re.test(name)) return o.product;
  if (mfAccount(input.accountNumber)) return "Decorative";
  return null;
}
