import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { buildHarmonizationMask } from "./mask.js";
import type { PlacedFixture } from "./composite.js";

/** A fully-opaque WxH RGBA PNG — stands in for a resized cutout's core. */
async function opaqueCutout(w: number, h: number): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 4, background: { r: 200, g: 200, b: 200, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

/** Read a mask PNG and expose a luminance accessor (channel-count agnostic). */
async function readMask(
  png: Buffer,
): Promise<{ width: number; at: (x: number, y: number) => number }> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  return {
    width: info.width,
    at: (x: number, y: number) => data[(y * info.width + x) * ch]!,
  };
}

describe("buildHarmonizationMask", () => {
  it("whites the dilated halo and preserves (blacks) the fixture core", async () => {
    const placement: PlacedFixture = {
      cutoutUrl: "https://cdn.example.com/f.png",
      dimensionsMm: { width: 20 },
      computedPx: { width: 20, height: 20 },
      position: { left: 40, top: 40 },
      anchor: "center",
      resizedCutout: await opaqueCutout(20, 20),
    };

    const png = await buildHarmonizationMask({
      width: 100,
      height: 100,
      placements: [placement],
      dilationPx: 10,
      featherSigma: 0, // crisp edges for assertions
    });

    const { at } = await readMask(png);

    // Centre of the fixture (40..60) is core => preserved (black).
    expect(at(50, 50)).toBe(0);
    // Halo ring: inside the dilated box (30..70) but outside the core => white.
    expect(at(34, 50)).toBe(255);
    expect(at(50, 34)).toBe(255);
    // Far outside any fixture => black.
    expect(at(5, 5)).toBe(0);
  });

  it("rejects invalid dimensions", async () => {
    await expect(
      buildHarmonizationMask({ width: 0, height: 10, placements: [], dilationPx: 4 }),
    ).rejects.toThrow(/invalid mask dimensions/);
  });
});
