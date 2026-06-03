import sharp from "sharp";
import type { PlacedFixture } from "./composite.js";

/**
 * Inpaint mask builder (Phase 2d, Option C).
 *
 * FLUX.1 Fill repaints WHITE mask pixels and preserves BLACK ones. To integrate
 * lighting without destroying the real product, the mask is a dilated halo
 * around each placed fixture (the contact-shadow / glow zone) with the fixture's
 * own opaque alpha core subtracted back to black. So Fill paints shadow/glow in
 * the ring around the fixture while the actual cutout pixels are held fixed.
 *
 * Output is a single-channel grayscale PNG matching the scene dimensions.
 */

export interface BuildMaskArgs {
  width: number;
  height: number;
  placements: PlacedFixture[];
  /** Pixels to expand each fixture box by to form the lighting halo. */
  dilationPx: number;
  /** Alpha (0..255) at/above which a cutout pixel is treated as fixture core. */
  coreAlphaThreshold?: number;
  /** Gaussian feather sigma for soft mask edges; defaults to dilationPx / 3. */
  featherSigma?: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export async function buildHarmonizationMask(args: BuildMaskArgs): Promise<Buffer> {
  const { width, height, placements, dilationPx } = args;
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`invalid mask dimensions: ${width}x${height}`);
  }
  const coreThreshold = args.coreAlphaThreshold ?? 16;

  // Single-channel mask, initialised to black (preserve everything).
  const mask = Buffer.alloc(width * height, 0);

  // 1) Paint a white halo box (dilated fixture bounds) for every fixture.
  for (const p of placements) {
    const left = Math.round(clamp(p.position.left - dilationPx, 0, width));
    const top = Math.round(clamp(p.position.top - dilationPx, 0, height));
    const right = Math.round(
      clamp(p.position.left + p.computedPx.width + dilationPx, 0, width),
    );
    const bottom = Math.round(
      clamp(p.position.top + p.computedPx.height + dilationPx, 0, height),
    );
    for (let y = top; y < bottom; y++) {
      const row = y * width;
      mask.fill(255, row + left, row + right);
    }
  }

  // 2) Subtract each fixture's opaque core using the resized cutout's alpha.
  for (const p of placements) {
    const { data, info } = await sharp(p.resizedCutout)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const cw = info.width;
    const ch = info.height;
    const channels = info.channels; // RGBA after ensureAlpha => 4
    for (let y = 0; y < ch; y++) {
      const my = p.position.top + y;
      if (my < 0 || my >= height) continue;
      const rowBase = my * width;
      for (let x = 0; x < cw; x++) {
        const mx = p.position.left + x;
        if (mx < 0 || mx >= width) continue;
        const alpha = data[(y * cw + x) * channels + (channels - 1)] ?? 0;
        if (alpha >= coreThreshold) mask[rowBase + mx] = 0;
      }
    }
  }

  // 3) Encode to PNG, feathering the edges so the lighting transition is soft.
  let img = sharp(mask, { raw: { width, height, channels: 1 } });
  const sigma = args.featherSigma ?? dilationPx / 3;
  if (sigma >= 0.3) img = img.blur(sigma);
  return img.png().toBuffer();
}
