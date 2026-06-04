import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { AppImagePerspective } from "@wac/shared";
import { isIdentityPerspective, warpCutout } from "./warp.js";

const identity: AppImagePerspective = {
  topLeft: { dx: 0, dy: 0 },
  topRight: { dx: 0, dy: 0 },
  bottomRight: { dx: 0, dy: 0 },
  bottomLeft: { dx: 0, dy: 0 },
};

/** A solid opaque square of the given size/color. */
async function solidSquare(size: number, rgb: [number, number, number]): Promise<Buffer> {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

describe("isIdentityPerspective", () => {
  it("treats undefined and all-zero offsets as identity", () => {
    expect(isIdentityPerspective(undefined)).toBe(true);
    expect(isIdentityPerspective(identity)).toBe(true);
  });

  it("detects a non-zero offset", () => {
    expect(
      isIdentityPerspective({ ...identity, topLeft: { dx: 0.1, dy: 0 } }),
    ).toBe(false);
  });
});

describe("warpCutout", () => {
  it("preserves size and opacity for an identity warp", async () => {
    const square = await solidSquare(40, [200, 50, 50]);
    const out = await warpCutout(square, identity);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(40);
    const stats = await sharp(out).stats();
    // Alpha channel stays fully opaque.
    expect(stats.channels[3]!.min).toBe(255);
  });

  it("keystones the top edge inward and introduces transparency", async () => {
    const square = await solidSquare(40, [200, 50, 50]);
    // Pull the two top corners toward the center -> a trapezoid narrower at top.
    const persp: AppImagePerspective = {
      topLeft: { dx: 0.25, dy: 0 },
      topRight: { dx: -0.25, dy: 0 },
      bottomRight: { dx: 0, dy: 0 },
      bottomLeft: { dx: 0, dy: 0 },
    };
    const out = await warpCutout(square, persp);
    const { data, info } = await sharp(out)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Top-left output pixel is now outside the trapezoid -> transparent.
    const topLeftAlpha = data[3]!;
    expect(topLeftAlpha).toBe(0);

    // A pixel near the bottom-center is inside the shape -> opaque red.
    const bx = Math.floor(info.width / 2);
    const by = info.height - 2;
    const off = (by * info.width + bx) * 4;
    expect(data[off + 3]!).toBeGreaterThan(200);
    expect(data[off]!).toBeGreaterThan(150); // red channel
  });
});
