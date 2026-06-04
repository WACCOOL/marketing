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

/**
 * Deterministic cache key for a matted cutout, namespaced by source URL.
 * Bumped to `v3` to invalidate ghosted cutouts cached before the segmentation
 * probability map was thresholded (soft masks made fixtures semi-transparent).
 */
export function cutoutCacheKey(sourceUrl: string): string {
  const hash = createHash("sha256").update(sourceUrl).digest("hex");
  return `cutouts/v3/${hash}.png`;
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
 * Classical background removal fallback for when Gemini returns no usable mask.
 * Most Sales Layer catalog shots sit on a solid (white/grey/black) background, so
 * a border-seeded flood fill reliably removes the background-connected region
 * without touching the fixture — even same-colored fixture parts survive because
 * they're not connected to the border. Graphic/cluttered backgrounds won't matte
 * well here, but those are the cases Gemini usually handles; this only runs when
 * segmentation has already failed.
 */
async function classicalMatte(
  original: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  // Tolerance for "same as background", in squared-distance over RGB (0..255).
  // ~24/channel: tight enough to keep near-white fixture parts (crystal accents,
  // frosted glass) that a looser threshold would erase, while still clearing a
  // solid white/grey/black backdrop with normal JPEG noise.
  const TOL_SQ = 24 * 24 * 3;
  const { data } = await sharp(original)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = width * height;
  if (data.length < n * 3) {
    throw new Error("classical matte: unexpected raw buffer size");
  }

  // Reference background color = average of the four corner pixels.
  const corners = [0, (width - 1) * 3, (height - 1) * width * 3, (n - 1) * 3];
  let br = 0;
  let bg = 0;
  let bb = 0;
  for (const c of corners) {
    br += data[c]!;
    bg += data[c + 1]!;
    bb += data[c + 2]!;
  }
  br /= corners.length;
  bg /= corners.length;
  bb /= corners.length;

  const isBg = (i: number): boolean => {
    const p = i * 3;
    const dr = data[p]! - br;
    const dg = data[p + 1]! - bg;
    const db = data[p + 2]! - bb;
    return dr * dr + dg * dg + db * db <= TOL_SQ;
  };

  // Flood fill from every border pixel; only background-connected pixels become
  // transparent. Stack-based to avoid recursion limits on large images.
  const bgMask = new Uint8Array(n);
  const stack: number[] = [];
  const pushIfBg = (i: number): void => {
    if (i >= 0 && i < n && !bgMask[i] && isBg(i)) {
      bgMask[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x++) {
    pushIfBg(x);
    pushIfBg((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    pushIfBg(y * width);
    pushIfBg(y * width + (width - 1));
  }
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % width;
    if (x > 0) pushIfBg(i - 1);
    if (x < width - 1) pushIfBg(i + 1);
    if (i - width >= 0) pushIfBg(i - width);
    if (i + width < n) pushIfBg(i + width);
  }

  const foreground = n - bgMask.reduce((acc, v) => acc + v, 0);
  // If almost nothing (or everything) was removed, the background wasn't a solid
  // color the flood fill could latch onto — don't return a garbage cutout.
  if (foreground < n * 0.01 || foreground > n * 0.99) {
    throw new Error("classical matte: no solid background detected");
  }

  const alpha = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) alpha[i] = bgMask[i] ? 0 : 255;

  // Soften the hard edge by 0.6px so the cutout doesn't look stamped.
  // CRITICAL: blur() promotes a 1-channel raw input back to 3 channels, so we
  // must force it back to single-channel ("b-w") before joining it as alpha —
  // otherwise joinChannel reads RGB-interleaved bytes as alpha and shreds the
  // cutout into scanlines (which silently destroyed every classical matte).
  const softAlpha = await sharp(alpha, { raw: { width, height, channels: 1 } })
    .blur(0.6)
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  const rgb = await sharp(original).removeAlpha().raw().toBuffer();
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .joinChannel(softAlpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
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

    // Decode each mask defensively: a malformed/empty PNG from Gemini must not
    // crash the whole cutout ("unsupported image format"). Skip the bad one.
    try {
      const maskPng = Buffer.from(m.maskPngBase64, "base64");
      const resized = await sharp(maskPng)
        .resize(boxW, boxH, { fit: "fill" })
        .greyscale()
        .png()
        .toBuffer();
      overlays.push({ input: resized, left, top, blend: "lighten" });
    } catch (e) {
      console.error(`[cutout] skipping undecodable segmentation mask:`, e);
    }
  }
  if (overlays.length === 0) {
    throw new Error("no decodable segmentation mask");
  }

  // Black canvas; masks paint the foreground probability. extractChannel(0)
  // yields a single-band probability map (mask pixels are greyscale, R carries it).
  const prob = await sharp({
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

  // Gemini masks are PROBABILITY maps, not binary masks. Using them directly as
  // alpha makes the whole fixture semi-transparent ("ghosted"). Threshold at 0.5
  // so foreground is fully opaque, then feather 0.6px for a soft (not stamped)
  // edge. blur() promotes a 1-channel raw back to 3 channels, so force it back to
  // single-channel ("b-w") before joining or joinChannel shreds it into scanlines.
  const alpha = await sharp(prob, { raw: { width, height, channels: 1 } })
    .threshold(128)
    .blur(0.6)
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

/**
 * Run segmentation with one retry. Gemini's segmentation is occasionally flaky
 * (a transient timeout or an empty/garbled response), and a single retry
 * recovers most of those without failing the whole job.
 */
async function segmentWithRetry(
  segmenter: SegmentAdapter,
  buffer: Buffer,
): Promise<SegmentationMask[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const masks = await segmenter.segment(buffer);
      if (masks.length > 0) return masks;
    } catch (e) {
      lastErr = e;
      console.error(`[cutout] segmentation attempt ${attempt} failed:`, e);
    }
  }
  if (lastErr) {
    const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`Gemini segmentation failed: ${detail}`);
  }
  return [];
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

  // Primary path: Gemini segmentation. On any failure (no mask, or an
  // undecodable mask), fall back to the classical border flood-fill matte so a
  // solid-background catalog shot still produces a usable cutout instead of a
  // hard job failure.
  let matted: Buffer | undefined;
  let primaryErr: unknown;
  try {
    const masks = await segmentWithRetry(segmenter, fetched.buffer);
    if (masks.length > 0) {
      matted = await applyMasksAsAlpha(
        fetched.buffer,
        fetched.width,
        fetched.height,
        masks,
      );
    } else {
      primaryErr = new Error("Gemini returned no segmentation mask");
    }
  } catch (e) {
    primaryErr = e;
  }

  if (!matted) {
    console.error(
      `[cutout] segmentation unusable for ${sourceUrl} (${
        primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
      }); trying classical matte`,
    );
    try {
      matted = await classicalMatte(fetched.buffer, fetched.width, fetched.height);
    } catch (fallbackErr) {
      const detail =
        fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(
        `background removal failed for ${sourceUrl}: segmentation produced no ` +
          `mask and classical fallback also failed (${detail})`,
      );
    }
  }
  if (cache) {
    await cache.put(key, matted, "image/png").catch((e) => {
      // Caching is best-effort; a write failure shouldn't fail the generation.
      console.error(`[cutout] cache write failed for ${key}:`, e);
    });
  }
  return toSourceImage(matted);
}
