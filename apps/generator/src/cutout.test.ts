import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { cutoutCacheKey, resolveCutout, type CutoutCache } from "./cutout.js";
import type { SourceImage } from "./composite.js";
import type { MatteAdapter } from "./ai/adapter.js";

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

describe("resolveCutout", () => {
  const url = "https://cdn.example.com/fixture.jpg";

  it("returns a genuinely transparent cutout unchanged (no matte)", async () => {
    const fetched = await makeImage(4, 0); // fully transparent bg
    const matte = vi.fn();
    const out = await resolveCutout({
      sourceUrl: url,
      fetched,
      matter: { provider: "m", matte } as unknown as MatteAdapter,
    });
    expect(out).toBe(fetched);
    expect(matte).not.toHaveBeenCalled();
  });

  it("mattes an opaque image and caches the result", async () => {
    const fetched = await makeImage(3, 1); // no alpha channel -> opaque
    const matted = await makeImage(4, 0);
    const matte = vi.fn().mockResolvedValue(matted.buffer);
    const store = new Map<string, Buffer>();
    const cache: CutoutCache = {
      get: async (k) => store.get(k) ?? null,
      put: async (k, b) => void store.set(k, b),
    };

    const out = await resolveCutout({
      sourceUrl: url,
      fetched,
      matter: { provider: "m", matte } as unknown as MatteAdapter,
      cache,
    });
    expect(matte).toHaveBeenCalledTimes(1);
    expect(out.hasAlpha).toBe(true);
    expect(store.has(cutoutCacheKey(url))).toBe(true);
  });

  it("serves a cached cutout without calling the matte adapter", async () => {
    const fetched = await makeImage(3, 1);
    const cached = await makeImage(4, 0);
    const matte = vi.fn();
    const cache: CutoutCache = {
      get: async () => cached.buffer,
      put: async () => {},
    };

    const out = await resolveCutout({
      sourceUrl: url,
      fetched,
      matter: { provider: "m", matte } as unknown as MatteAdapter,
      cache,
    });
    expect(matte).not.toHaveBeenCalled();
    expect(out.hasAlpha).toBe(true);
  });

  it("throws on an opaque cutout when no matte adapter is configured", async () => {
    const fetched = await makeImage(3, 1);
    await expect(
      resolveCutout({ sourceUrl: url, fetched }),
    ).rejects.toThrow(/background removal is not configured/);
  });
});
