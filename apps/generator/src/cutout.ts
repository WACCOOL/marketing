import { createHash } from "node:crypto";
import sharp from "sharp";
import type { SegmentAdapter, SegmentationMask } from "./ai/adapter.js";
import type { SourceImage } from "./composite.js";

/**
 * Cutout resolution (Phase 2). Sales Layer product images are not pre-cut, so a
 * fixture cutout usually arrives with a visible background (white/grey/black or
 * a full graphic). Before compositing we remove the background and cache the
 * transparent result in R2, keyed by the source URL, so each catalog image is
 * matted once and reused across jobs.
 *
 * Background removal uses Gemini image segmentation (we only use BFL + Gemini):
 * Gemini returns a per-object mask, and we apply that mask as an alpha channel
 * with sharp. Gemini cannot emit transparency itself, so the alpha compositing
 * happens here.
 */

/** Minimal R2/S3-backed cache for matted cutouts. */
export interface CutoutCache {
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

/** Deterministic cache key for a matted cutout, namespaced by source URL. */
export function cutoutCacheKey(sourceUrl: string): string {
  const hash = createHash("sha256").update(sourceUrl).digest("hex");
  return `cutouts/gemini/${hash}.png`;
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

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Apply Gemini segmentation masks to an image as an alpha channel, producing a
 * transparent PNG. Each mask's `box2d` (0..1000) is scaled to pixels, the mask
 * probability map is resized into that box, and masks are combined with a
 * `lighten` (max) blend so overlapping fixture parts union cleanly.
 */
async function applyMasksAsAlpha(
  original: Buffer,
  width: number,
  height: number,
  masks: SegmentationMask[],
): Promise<Buffer> {
  const overlays: sharp.OverlayOptions[] = [];
  for (const m of masks) {
    const [y0, x0, y1, x1] = m.box2d;
    const left = clamp(Math.round((x0 / 1000) * width), 0, width - 1);
    const top = clamp(Math.round((y0 / 1000) * height), 0, height - 1);
    const boxW = clamp(Math.round(((x1 - x0) / 1000) * width), 1, width - left);
    const boxH = clamp(Math.round(((y1 - y0) / 1000) * height), 1, height - top);

    const maskPng = Buffer.from(m.maskPngBase64, "base64");
    const resized = await sharp(maskPng)
      .resize(boxW, boxH, { fit: "fill" })
      .greyscale()
      .png()
      .toBuffer();
    overlays.push({ input: resized, left, top, blend: "lighten" });
  }

  // Black canvas; masks paint the foreground probability. extractChannel(0)
  // yields a single-band alpha (mask pixels are greyscale, so R carries it).
  const alpha = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(overlays)
    .extractChannel(0)
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  // Decode the base to raw RGB before joining the alpha. joinChannel on an
  // encoded (PNG) pipeline silently drops the appended channel; a raw RGB base
  // reliably yields RGBA.
  const rgb = await sharp(original).removeAlpha().raw().toBuffer();
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

export interface ResolveCutoutArgs {
  sourceUrl: string;
  fetched: SourceImage;
  segmenter?: SegmentAdapter;
  cache?: CutoutCache;
}

/**
 * Return a transparent cutout for compositing. If the fetched image already has
 * real transparency it is used as-is. Otherwise the matted result is served from
 * the R2 cache when present, or produced via Gemini segmentation and cached.
 * When no segmenter is configured and the cutout is opaque, throws an actionable
 * error (so the failure mode is clear rather than a pasted rectangle).
 */
export async function resolveCutout(args: ResolveCutoutArgs): Promise<SourceImage> {
  const { sourceUrl, fetched, segmenter, cache } = args;

  if (!(await needsMatte(fetched))) return fetched;

  const key = cutoutCacheKey(sourceUrl);

  if (cache) {
    const cached = await cache.get(key).catch(() => null);
    if (cached) return toSourceImage(cached);
  }

  if (!segmenter) {
    throw new Error(
      `cutout ${sourceUrl} has no transparent background and background ` +
        `removal is not configured (set GEMINI_API_KEY to enable segmentation)`,
    );
  }

  const masks = await segmenter.segment(fetched.buffer);
  if (masks.length === 0) {
    throw new Error(
      `background removal failed: Gemini returned no segmentation mask for ${sourceUrl}`,
    );
  }

  const matted = await applyMasksAsAlpha(
    fetched.buffer,
    fetched.width,
    fetched.height,
    masks,
  );
  if (cache) {
    await cache.put(key, matted, "image/png").catch((e) => {
      // Caching is best-effort; a write failure shouldn't fail the generation.
      console.error(`[cutout] cache write failed for ${key}:`, e);
    });
  }
  return toSourceImage(matted);
}
