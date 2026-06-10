/**
 * SEO structured-data builders (per the SEO field spec): JSON-LD for WAC
 * product pages. No e-commerce — the site doesn't sell, so NO offers, price,
 * availability, priceValidUntil, shippingDetails, or hasMerchantReturnPolicy
 * are ever emitted. Variants share one page URL, so variant Products carry
 * sku/mpn but never a url.
 */

import { slugifyName } from "./productinfo.js";

export interface SeoIssue {
  level: "error" | "warn";
  message: string;
}

export interface JsonLdVariantInput {
  sku: string;
  /** Distinguishing attributes appended to the product name (finish, CCT). */
  finish?: string | null;
  cct?: string | null;
  image?: string | null;
  /** Spec label → value (Lumens, Wattage, CCT, CRI, IP Rating, Voltage,
   * Dimming, Finish). Emitted as schema.org PropertyValue pairs. */
  specs: Record<string, string>;
}

export interface JsonLdPageInput {
  ppid: string;
  name: string;
  description: string | null;
  brand: string | null;
  canonicalUrl?: string | null;
  images: string[];
  category?: string | null;
  /** Site origin for breadcrumb Home / category links. */
  siteBase?: string | null;
  variants: JsonLdVariantInput[];
  /** Product-level specs, used when there are no variants. */
  productSpecs?: Record<string, string>;
}

function propertyValues(specs: Record<string, string>): object[] {
  return Object.entries(specs)
    .filter(([, v]) => v && v.trim())
    .map(([name, value]) => ({
      "@type": "PropertyValue",
      name,
      value: value.trim(),
    }));
}

function variantName(input: JsonLdPageInput, v: JsonLdVariantInput): string {
  const parts = [input.name];
  if (v.finish) parts.push(v.finish);
  if (v.cct) parts.push(v.cct);
  return parts.join(", ");
}

/**
 * Build the per-page JSON-LD payload: ProductGroup + hasVariant Products when
 * the page has variants, a plain Product otherwise (never both), plus a
 * BreadcrumbList. Returns validation issues alongside — required fields per
 * the spec are errors, missing specs are warnings (AEO target).
 */
export function buildProductPageJsonLd(input: JsonLdPageInput): {
  jsonld: object[];
  issues: SeoIssue[];
} {
  const issues: SeoIssue[] = [];
  if (!input.name?.trim()) issues.push({ level: "error", message: "missing name" });
  if (!input.description?.trim()) {
    issues.push({
      level: "error",
      message: "missing description (approve romance copy or a meta description)",
    });
  }
  if (!input.brand?.trim()) issues.push({ level: "error", message: "missing brand" });
  if (input.images.length === 0) {
    issues.push({ level: "error", message: "missing image" });
  }
  if (!input.canonicalUrl) {
    issues.push({ level: "warn", message: "no canonical URL set" });
  }

  const brand = input.brand
    ? { "@type": "Brand", name: input.brand }
    : undefined;

  let main: Record<string, unknown>;
  if (input.variants.length > 0) {
    const finishes = new Set(
      input.variants.map((v) => v.finish).filter(Boolean),
    );
    const variesBy: string[] = [];
    if (finishes.size > 1) variesBy.push("https://schema.org/color");

    let missingSpecs = 0;
    const hasVariant = input.variants.map((v) => {
      const specs = propertyValues(v.specs);
      if (specs.length === 0) missingSpecs++;
      if (!v.sku.trim()) {
        issues.push({ level: "error", message: "variant with empty sku" });
      }
      return {
        "@type": "Product",
        sku: v.sku,
        mpn: v.sku,
        name: variantName(input, v),
        ...(v.finish ? { color: v.finish } : {}),
        ...(v.image ? { image: v.image } : {}),
        ...(specs.length ? { additionalProperty: specs } : {}),
        // deliberately NO url (variants share the page) and NO offers
      };
    });
    if (missingSpecs > 0) {
      issues.push({
        level: "warn",
        message: `${missingSpecs} variant${missingSpecs === 1 ? "" : "s"} missing specs (additionalProperty) — spec queries are the main AEO target`,
      });
    }

    main = {
      "@context": "https://schema.org",
      "@type": "ProductGroup",
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      productGroupID: input.ppid,
      ...(brand ? { brand } : {}),
      ...(input.canonicalUrl ? { url: input.canonicalUrl } : {}),
      ...(input.images.length ? { image: input.images } : {}),
      ...(variesBy.length ? { variesBy } : {}),
      hasVariant,
    };
  } else {
    const specs = propertyValues(input.productSpecs ?? {});
    if (specs.length === 0) {
      issues.push({
        level: "warn",
        message: "no specs (additionalProperty) — spec queries are the main AEO target",
      });
    }
    main = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      sku: input.ppid,
      mpn: input.ppid,
      ...(brand ? { brand } : {}),
      ...(input.canonicalUrl ? { url: input.canonicalUrl } : {}),
      ...(input.images.length ? { image: input.images } : {}),
      ...(specs.length ? { additionalProperty: specs } : {}),
    };
  }

  const jsonld: object[] = [main];

  // BreadcrumbList: Home → Category → Product (item URL omitted only on the
  // final element, per Google's requirements).
  if (input.siteBase || input.canonicalUrl) {
    const elements: object[] = [];
    let position = 1;
    if (input.siteBase) {
      elements.push({
        "@type": "ListItem",
        position: position++,
        name: "Home",
        item: input.siteBase,
      });
    }
    if (input.category && input.siteBase) {
      elements.push({
        "@type": "ListItem",
        position: position++,
        name: input.category,
        item: `${input.siteBase}/${slugifyName(input.category)}`,
      });
    }
    elements.push({
      "@type": "ListItem",
      position,
      name: input.name,
      ...(input.canonicalUrl ? { item: input.canonicalUrl } : {}),
    });
    jsonld.push({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: elements,
    });
  }

  return { jsonld, issues };
}

/** Sitewide Organization payload (emitted once per site, not per page). */
export function buildOrganizationJsonLd(org: {
  name: string;
  url: string;
  logo?: string | null;
  sameAs?: string[];
}): object {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: org.name,
    url: org.url,
    ...(org.logo ? { logo: org.logo } : {}),
    ...(org.sameAs?.length ? { sameAs: org.sameAs } : {}),
  };
}
