import sharp from "sharp";
import type { PlacedFixture } from "./composite.js";

/**
 * Classical, shape-preserving harmonization (the non-generative "make the
 * fixture fit the room" step — cf. Photoshop's Harmonize / Match Color).
 *
 * For each placed fixture we compute the color statistics (per-channel mean +
 * std) of the surrounding SCENE pixels and of the fixture's own pixels, then
 * apply a Reinhard-style transfer that pulls the fixture's white balance,
 * exposure, and contrast toward the scene. This emits a per-pixel COLOR
 * transform on the fixture's existing pixels — it never synthesizes new pixels,
 * so it cannot change the fixture's geometry (no invented arms/crystals).
 *
 * Only fixture-covered pixels are modified; the room stays byte-identical, so
 * the result is region-locked by construction.
 */

const COVERAGE_ALPHA_THRESHOLD = 8;

export interface HarmonizeArgs {
  /** The composited scene+fixtures base (PNG, opaque). */
  base: Buffer;
  width: number;
  height: number;
  placements: PlacedFixture[];
  /** 0 = leave fixture as-is, 1 = fully match the scene's color/tone. */
  strength: number;
  /** Optional soft contact-shadow radius under each fixture (px). 0 = none. */
  shadowPx?: number;
}

interface ChannelStats {
  mean: [number, number, number];
  std: [number, number, number];
  count: number;
}

function clamp8(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/**
 * Rasterize every fixture's alpha into a scene-sized coverage map (max alpha
 * where fixtures overlap). Used to know which pixels are "fixture" vs "scene".
 */
async function buildCoverage(
  width: number,
  height: number,
  placements: PlacedFixture[],
): Promise<Uint8Array> {
  const coverage = new Uint8Array(width * height);
  for (const p of placements) {
    const { data, info } = await sharp(p.resizedCutout)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const cw = info.width;
    const ch = info.height;
    const channels = info.channels;
    for (let y = 0; y < ch; y++) {
      const sy = p.position.top + y;
      if (sy < 0 || sy >= height) continue;
      for (let x = 0; x < cw; x++) {
        const sx = p.position.left + x;
        if (sx < 0 || sx >= width) continue;
        const alpha = data[(y * cw + x) * channels + (channels - 1)] ?? 0;
        const idx = sy * width + sx;
        if (alpha > coverage[idx]!) coverage[idx] = alpha;
      }
    }
  }
  return coverage;
}

/** Per-channel mean/std over the pixels selected by `accept(idx)`. */
function channelStats(
  rgb: Buffer,
  width: number,
  height: number,
  box: { left: number; top: number; right: number; bottom: number },
  accept: (idx: number) => boolean,
): ChannelStats {
  const sum = [0, 0, 0];
  const sumSq = [0, 0, 0];
  let count = 0;
  for (let y = box.top; y < box.bottom; y++) {
    for (let x = box.left; x < box.right; x++) {
      const idx = y * width + x;
      if (!accept(idx)) continue;
      const o = idx * 3;
      for (let c = 0; c < 3; c++) {
        const v = rgb[o + c]!;
        sum[c]! += v;
        sumSq[c]! += v * v;
      }
      count++;
    }
  }
  const mean: [number, number, number] = [0, 0, 0];
  const std: [number, number, number] = [1, 1, 1];
  if (count > 0) {
    for (let c = 0; c < 3; c++) {
      mean[c] = sum[c]! / count;
      const variance = Math.max(0, sumSq[c]! / count - mean[c]! * mean[c]!);
      std[c] = Math.sqrt(variance);
    }
  }
  return { mean, std, count };
}

/**
 * Recolor each fixture's pixels toward the surrounding scene statistics. Mutates
 * a copy of `base`'s RGB and returns a fresh PNG. Pure color transform — never
 * touches geometry, never touches non-fixture pixels.
 */
export async function harmonizeFixtures(args: HarmonizeArgs): Promise<Buffer> {
  const { width, height, placements, strength } = args;
  const shadowPx = args.shadowPx ?? 0;
  if (strength <= 0 && shadowPx <= 0) return args.base;

  const coverage = await buildCoverage(width, height, placements);

  // Optional soft contact shadow first, so harmonized fixtures sit on top of it.
  let working = args.base;
  if (shadowPx > 0) {
    working = await renderContactShadow(working, width, height, coverage, shadowPx);
  }

  if (strength <= 0) return working;

  const rgb = Buffer.from(
    await sharp(working).removeAlpha().raw().toBuffer(),
  );

  for (const p of placements) {
    const left = Math.max(0, p.position.left);
    const top = Math.max(0, p.position.top);
    const right = Math.min(width, p.position.left + p.computedPx.width);
    const bottom = Math.min(height, p.position.top + p.computedPx.height);
    if (right <= left || bottom <= top) continue;

    // Source = this fixture's own pixels; target = nearby scene (background)
    // pixels in a dilated window around the fixture.
    const margin = Math.max(
      24,
      Math.round(Math.max(p.computedPx.width, p.computedPx.height) * 0.6),
    );
    const ctxBox = {
      left: Math.max(0, left - margin),
      top: Math.max(0, top - margin),
      right: Math.min(width, right + margin),
      bottom: Math.min(height, bottom + margin),
    };
    const fixtureBox = { left, top, right, bottom };

    const src = channelStats(rgb, width, height, fixtureBox, (idx) =>
      coverage[idx]! >= COVERAGE_ALPHA_THRESHOLD,
    );
    const tgt = channelStats(rgb, width, height, ctxBox, (idx) =>
      coverage[idx]! < COVERAGE_ALPHA_THRESHOLD,
    );

    // Need enough of both to estimate a stable transform; otherwise skip.
    if (src.count < 16 || tgt.count < 64) continue;

    for (let y = fixtureBox.top; y < fixtureBox.bottom; y++) {
      for (let x = fixtureBox.left; x < fixtureBox.right; x++) {
        const idx = y * width + x;
        const a = coverage[idx]!;
        if (a < COVERAGE_ALPHA_THRESHOLD) continue;
        // Feather by the fixture's alpha so anti-aliased edges blend smoothly.
        const blend = strength * (a / 255);
        const o = idx * 3;
        for (let c = 0; c < 3; c++) {
          const v = rgb[o + c]!;
          const ratio = src.std[c]! > 1 ? tgt.std[c]! / src.std[c]! : 1;
          // Keep the ratio sane so a flat fixture region can't blow up.
          const safeRatio = Math.min(2.5, Math.max(0.4, ratio));
          const matched = (v - src.mean[c]!) * safeRatio + tgt.mean[c]!;
          rgb[o + c] = clamp8(v * (1 - blend) + matched * blend);
        }
      }
    }
  }

  return sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/**
 * Render a soft, offset contact shadow beneath the fixtures and composite it
 * onto the base. Deterministic and content-free (just a blurred, darkened copy
 * of the coverage silhouette), so it grounds the fixture without inventing
 * anything. Offset slightly down to read as a cast shadow.
 */
async function renderContactShadow(
  base: Buffer,
  width: number,
  height: number,
  coverage: Uint8Array,
  shadowPx: number,
): Promise<Buffer> {
  const offsetY = Math.round(shadowPx * 0.4);
  const shadowAlpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = coverage[y * width + x]!;
      if (a < COVERAGE_ALPHA_THRESHOLD) continue;
      const ty = y + offsetY;
      if (ty >= height) continue;
      const ti = ty * width + x;
      // Shadow opacity ~45% of the silhouette alpha.
      const val = Math.round(a * 0.45);
      if (val > shadowAlpha[ti]!) shadowAlpha[ti] = val;
    }
  }

  // blur() can promote a 1-band image to 3 channels on raw output, so force it
  // back to a single greyscale band before reading the alpha bytes.
  const blurred = await sharp(Buffer.from(shadowAlpha), {
    raw: { width, height, channels: 1 },
  })
    .blur(Math.max(0.3, shadowPx / 2))
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  // Black RGBA layer using the blurred alpha as its transparency.
  const rgba = Buffer.alloc(width * height * 4, 0);
  for (let i = 0; i < width * height; i++) rgba[i * 4 + 3] = blurred[i]!;
  const shadowLayer = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();

  return sharp(base).composite([{ input: shadowLayer, left: 0, top: 0 }]).png().toBuffer();
}
