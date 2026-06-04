import { createHash } from "node:crypto";
import sharp from "sharp";
import type { MatteAdapter } from "./ai/adapter.js";
import type { SourceImage } from "./composite.js";

/**
 * Cutout resolution (Phase 2). Sales Layer product images are not pre-cut, so a
 * fixture cutout usually arrives with a visible background (white/grey/black or
 * a full graphic). Before compositing we run background removal (BiRefNet via
 * fal.ai) to get a transparent PNG, caching the result in R2 keyed by the source
 * URL so each catalog image is matted once and reused across jobs.
 */

/** Minimal R2/S3-backed cache for matted cutouts. */
export interface CutoutCache {
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

/** Deterministic cache key for a matted cutout, namespaced by source URL. */
export function cutoutCacheKey(sourceUrl: string): string {
  const hash = createHash("sha256").update(sourceUrl).digest("hex");
  return `cutouts/birefnet/${hash}.png`;
}

/** Decode raw image bytes into the SourceImage shape the compositor expects. */
async function toSourceImage(buffer: Buffer): Promise<SourceImage> {
  const meta = await sharp(buffer).metadata();
  return {
    buffer,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    hasAlpha: Boolean(meta.hasAlpha),
  };
}

/**
 * Whether a fetched cutout needs background removal. True when it has no alpha
 * channel, or has one that is effectively fully opaque (e.g. a white-background
 * PNG that technically carries an all-255 alpha channel).
 */
async function needsMatte(image: SourceImage): Promise<boolean> {
  if (!image.hasAlpha) return true;
  try {
    const stats = await sharp(image.buffer).stats();
    const alpha = stats.channels[3];
    if (!alpha) return true;
    // No meaningful transparency anywhere -> treat as an opaque image to matte.
    return alpha.min >= 250;
  } catch {
    // If we can't read alpha stats, fall back to matting to be safe.
    return true;
  }
}

export interface ResolveCutoutArgs {
  sourceUrl: string;
  fetched: SourceImage;
  matter?: MatteAdapter;
  cache?: CutoutCache;
}

/**
 * Return a transparent cutout for compositing. If the fetched image already has
 * real transparency it is used as-is. Otherwise the matted result is served from
 * the R2 cache when present, or produced via the matte adapter and cached. When
 * no matte adapter is configured and the cutout is opaque, throws an actionable
 * error (so the failure mode is clear rather than a pasted rectangle).
 */
export async function resolveCutout(args: ResolveCutoutArgs): Promise<SourceImage> {
  const { sourceUrl, fetched, matter, cache } = args;

  if (!(await needsMatte(fetched))) return fetched;

  const key = cutoutCacheKey(sourceUrl);

  if (cache) {
    const cached = await cache.get(key).catch(() => null);
    if (cached) return toSourceImage(cached);
  }

  if (!matter) {
    throw new Error(
      `cutout ${sourceUrl} has no transparent background and background ` +
        `removal is not configured (set FAL_API_KEY to enable BiRefNet matting)`,
    );
  }

  const matted = await matter.matte({ imageUrl: sourceUrl });
  if (cache) {
    await cache.put(key, matted, "image/png").catch((e) => {
      // Caching is best-effort; a write failure shouldn't fail the generation.
      console.error(`[cutout] cache write failed for ${key}:`, e);
    });
  }
  return toSourceImage(matted);
}
