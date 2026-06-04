import type {
  AppImageAnchor,
  AppImagePerspective,
  AppImageWidthBasis,
  DimensionsMm,
  FixtureMount,
  Product,
} from "@wac/shared";
import { deriveFixtureKind } from "./fixtureKind.js";

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
  /** The catalog image the user picked (raw, may have a background). */
  sourceImageUrl: string;
  /**
   * Transparent PNG produced by removing `sourceImageUrl`'s background. Empty
   * until the matte completes; submit is blocked until it's set.
   */
  cutoutUrl: string;
  imageOptions: string[];
  dimensionsMm: DimensionsMm;
  anchor: AppImageAnchor;
  xPct: number;
  yPct: number;
  widthBasis: AppImageWidthBasis;
  /** Optional deterministic perspective warp (corner offsets). */
  perspective?: AppImagePerspective;
  /** Where this fixture mounts (derived from category; user-overridable). */
  mount: FixtureMount;
  /** Human-readable fixture type for fixture-aware scene generation. */
  fixtureType: string;
}

/** Build a fixture draft from a picked product, with sensible auto-placement. */
export function newFixtureFromProduct(product: Product): FixtureDraft {
  const imageOptions = dedupe(
    [product.primary_image_url ?? undefined, ...product.image_urls].filter(
      (u): u is string => Boolean(u),
    ),
  );
  // Prefer a transparent-friendly image as the default source if one exists.
  const sourceImageUrl =
    imageOptions.find((u) => !looksOpaque(u)) ?? imageOptions[0] ?? "";
  const kind = deriveFixtureKind(product.category, product.name);
  const placement = autoPlaceForMount(kind.mount);
  return {
    id: crypto.randomUUID(),
    sku: product.sku,
    name: product.name,
    sourceImageUrl,
    // Filled in by the background-removal step once it completes.
    cutoutUrl: "",
    imageOptions,
    dimensionsMm: { ...product.dimensions_mm },
    anchor: placement.anchor,
    xPct: placement.xPct,
    yPct: placement.yPct,
    widthBasis: "auto",
    mount: kind.mount,
    fixtureType: kind.fixtureType,
  };
}

/**
 * Mount-appropriate starting placement (anchor + normalized x/y). Ceiling/recessed
 * fixtures hang from the top, wall fixtures sit mid-frame, floor fixtures rest near
 * the bottom. The user fine-tunes from here.
 */
export function autoPlaceForMount(mount: FixtureMount): {
  anchor: AppImageAnchor;
  xPct: number;
  yPct: number;
} {
  switch (mount) {
    case "wall":
      return { anchor: "center", xPct: 0.5, yPct: 0.42 };
    case "floor":
      return { anchor: "bottom-center", xPct: 0.5, yPct: 0.82 };
    case "recessed":
      return { anchor: "top-center", xPct: 0.5, yPct: 0.08 };
    case "ceiling":
    default:
      return { anchor: "top-center", xPct: 0.5, yPct: 0.14 };
  }
}

/** Representative horizontal real-world size of a fixture, in mm (0 if unknown). */
export function representativeWidthMm(d: DimensionsMm): number {
  return d.width || d.diameter || d.length || d.height || 0;
}

/**
 * Seed a generated scene's real-world width (mm) so the fixture starts at a
 * sensible fraction of the scene width (default ~30%). Because pxPerMm derives
 * from sceneWidthMm, this is scene-pixel-independent: sceneWidthMm = realWidth /
 * fraction. Returns null when the fixture has no usable width.
 */
export function seedSceneWidthMm(
  fixture: FixtureDraft,
  fraction = 0.3,
): number | null {
  const w = representativeWidthMm(fixture.dimensionsMm);
  if (!w) return null;
  return Math.round(w / fraction);
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
