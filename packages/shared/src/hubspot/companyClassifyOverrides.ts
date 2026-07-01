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
