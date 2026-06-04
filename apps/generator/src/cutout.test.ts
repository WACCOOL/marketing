import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { cutoutCacheKey, resolveCutout, type CutoutCache } from "./cutout.js";
import type { SourceImage } from "./composite.js";
import type { SegmentAdapter, SegmentationMask } from "./ai/adapter.js";

async function makeImage(
  channels: 3 | 4,
  alpha: number,
): Promise<SourceImage> {
  const buffer = await sharp({
    create: {
      width: 8,
      height: 8,
      channels,
      background: { r: 255, g: 255, b: 255, alpha },
    },
  })
    .png()
    .toBuffer();
  const meta = await sharp(buffer).metadata();
  return {
    buffer,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    hasAlpha: Boolean(meta.hasAlpha),
  };
}

/**
 * A center-patch mask (white box over the middle ~75% of the image), leaving a
 * transparent border so the matted result has genuine alpha to assert on.
 */
async function centerMask(): Promise<SegmentationMask> {
  const maskPng = await sharp({
    create: {
      width: 6,
      height: 6,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png()
    .toBuffer();
  return {
    box2d: [125, 125, 875, 875],
    maskPngBase64: maskPng.toString("base64"),
    label: "fixture",
  };
}

function segmenterReturning(masks: SegmentationMask[]): {
  adapter: SegmentAdapter;
  segment: ReturnType<typeof vi.fn>;
} {
  const segment = vi.fn().mockResolvedValue(masks);
  return { adapter: { provider: "gemini", segment }, segment };
}

describe("resolveCutout", () => {
  const url = "https://cdn.example.com/fixture.jpg";

  it("returns a genuinely transparent cutout unchanged (no segmentation)", async () => {
    const fetched = await makeImage(4, 0); // fully transparent bg
    const { adapter, segment } = segmenterReturning([]);
    const out = await resolveCutout({ sourceUrl: url, fetched, segmenter: adapter });
    expect(out).toBe(fetched);
    expect(segment).not.toHaveBeenCalled();
  });

  it("segments an opaque image into a transparent cutout and caches it", async () => {
    const fetched = await makeImage(3, 1); // no alpha channel -> opaque
    const { adapter, segment } = segmenterReturning([await centerMask()]);
    const store = new Map<string, Buffer>();
    const cache: CutoutCache = {
      get: async (k) => store.get(k) ?? null,
      put: async (k, b) => void store.set(k, b),
    };

    const out = await resolveCutout({
      sourceUrl: url,
      fetched,
      segmenter: adapter,
      cache,
    });
    expect(segment).toHaveBeenCalledTimes(1);
    expect(out.hasAlpha).toBe(true);
    expect(store.has(cutoutCacheKey(url))).toBe(true);
    // The matted output should carry the segmentation alpha (some transparency).
    const stats = await sharp(out.buffer).stats();
    expect(stats.channels[3]?.min).toBe(0);
  });

  it("serves a cached cutout without calling the segmenter", async () => {
    const fetched = await makeImage(3, 1);
    const cached = await makeImage(4, 0);
    const { adapter, segment } = segmenterReturning([]);
    const cache: CutoutCache = {
      get: async () => cached.buffer,
      put: async () => {},
    };

    const out = await resolveCutout({
      sourceUrl: url,
      fetched,
      segmenter: adapter,
      cache,
    });
    expect(segment).not.toHaveBeenCalled();
    expect(out.hasAlpha).toBe(true);
  });

  it("throws on an opaque cutout when no segmenter is configured", async () => {
    const fetched = await makeImage(3, 1);
    await expect(resolveCutout({ sourceUrl: url, fetched })).rejects.toThrow(
      /background removal is not configured/,
    );
  });

  it("throws when segmentation AND the classical fallback both fail", async () => {
    // A 3x1 noise image has no solid border background, so the flood-fill
    // fallback also bails — the error reports both failures.
    const fetched = await makeImage(3, 1);
    const { adapter } = segmenterReturning([]);
    await expect(
      resolveCutout({ sourceUrl: url, fetched, segmenter: adapter }),
    ).rejects.toThrow(/classical fallback also failed/);
  });

  it("falls back to a classical matte on a solid background when segmentation finds nothing", async () => {
    // White canvas with an opaque black square in the middle: no real alpha, so
    // it needs matting; segmentation returns nothing, so the flood fill removes
    // the connected white border and keeps the square.
    const w = 40;
    const h = 40;
    const raw = Buffer.alloc(w * h * 3, 255);
    for (let y = 12; y < 28; y++) {
      for (let x = 12; x < 28; x++) {
        const p = (y * w + x) * 3;
        raw[p] = 0;
        raw[p + 1] = 0;
        raw[p + 2] = 0;
      }
    }
    const png = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
      .png()
      .toBuffer();
    const meta = await sharp(png).metadata();
    const fetched = {
      buffer: png,
      width: meta.width ?? w,
      height: meta.height ?? h,
      hasAlpha: Boolean(meta.hasAlpha),
    };
    const { adapter } = segmenterReturning([]);
    const out = await resolveCutout({ sourceUrl: url, fetched, segmenter: adapter });
    expect(out.hasAlpha).toBe(true);
    // The transparent border + opaque square means alpha is no longer all-255.
    const stats = await sharp(out.buffer).stats();
    expect(stats.channels[3]!.min).toBe(0);
  });
});
