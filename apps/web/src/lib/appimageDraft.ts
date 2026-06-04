import type {
  AppImageAnchor,
  AppImagePerspective,
  AppImageWidthBasis,
  DimensionsMm,
  Product,
} from "@wac/shared";

/**
 * UI-side model for one fixture being placed. Maps onto AppImageFixtureSchema at
 * submit time. `imageOptions` are the candidate cutout URLs from the product so
 * the user can pick a transparent PNG; `sku`/`name` are carried for tagging and
 * display only.
 */
export interface FixtureDraft {
  id: string;
  sku: string;
  name: string;
  cutoutUrl: string;
  imageOptions: string[];
  dimensionsMm: DimensionsMm;
  anchor: AppImageAnchor;
  xPct: number;
  yPct: number;
  widthBasis: AppImageWidthBasis;
  /** Optional deterministic perspective warp (corner offsets). */
  perspective?: AppImagePerspective;
}

/** Build a fixture draft from a picked product, with sensible auto-placement. */
export function newFixtureFromProduct(product: Product): FixtureDraft {
  const imageOptions = dedupe(
    [product.primary_image_url ?? undefined, ...product.image_urls].filter(
      (u): u is string => Boolean(u),
    ),
  );
  // Prefer a transparent-friendly image as the default cutout if one exists.
  const cutoutUrl =
    imageOptions.find((u) => !looksOpaque(u)) ?? imageOptions[0] ?? "";
  return {
    id: crypto.randomUUID(),
    sku: product.sku,
    name: product.name,
    cutoutUrl,
    imageOptions,
    dimensionsMm: { ...product.dimensions_mm },
    anchor: "bottom-center",
    xPct: 0.5,
    yPct: 0.65,
    widthBasis: "auto",
  };
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}

/**
 * Fast extension heuristic for the cutout-transparency warning. JPEGs can't
 * carry alpha, so a `.jpg`/`.jpeg` cutout will be rejected by the generator. A
 * pixel-level canvas check is a more reliable follow-up (adds fetch/CORS cost).
 */
export function looksOpaque(url: string): boolean {
  const path = url.split("?")[0]!.toLowerCase();
  return path.endsWith(".jpg") || path.endsWith(".jpeg");
}

export function hasUsableDimension(d: DimensionsMm): boolean {
  return Boolean(d.width || d.height || d.depth || d.diameter || d.length);
}

/**
 * Expand one fixture into a horizontal array of `count` copies centered on the
 * base fixture's x, spaced `spacingPct` of scene width apart. Models the PRD's
 * downlight/landscape arrays as multiple fixtures[] entries (the contract has no
 * native array concept).
 */
export function expandArray(
  base: FixtureDraft,
  count: number,
  spacingPct: number,
): FixtureDraft[] {
  const n = Math.max(1, Math.floor(count));
  if (n === 1) return [base];
  const totalSpan = spacingPct * (n - 1);
  const start = base.xPct - totalSpan / 2;
  return Array.from({ length: n }, (_, i) => ({
    ...base,
    id: crypto.randomUUID(),
    xPct: clamp01(start + i * spacingPct),
  }));
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
