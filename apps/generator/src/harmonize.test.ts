import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { PlacedFixture } from "./composite.js";
import { harmonizeFixtures } from "./harmonize.js";

const SCENE = 100;
const FIX = 30;
const FX = 35;
const FY = 35;

/** Warm scene color; cool fixture color so a shift is easy to detect. */
const SCENE_RGB: [number, number, number] = [210, 110, 70];
const FIXTURE_RGB: [number, number, number] = [40, 60, 230];

async function solid(
  w: number,
  h: number,
  rgb: [number, number, number],
  alpha = 1,
): Promise<Buffer> {
  return sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha },
    },
  })
    .png()
    .toBuffer();
}

async function makeScene(): Promise<{ base: Buffer; placements: PlacedFixture[] }> {
  const sceneLayer = await solid(SCENE, SCENE, SCENE_RGB);
  const fixture = await solid(FIX, FIX, FIXTURE_RGB);
  const base = await sharp(sceneLayer)
    .composite([{ input: fixture, left: FX, top: FY }])
    .png()
    .toBuffer();
  const placements: PlacedFixture[] = [
    {
      cutoutUrl: "https://x/f.png",
      dimensionsMm: { width: 100 },
      computedPx: { width: FIX, height: FIX },
      position: { left: FX, top: FY },
      anchor: "center",
      resizedCutout: fixture,
    },
  ];
  return { base, placements };
}

async function pixel(buf: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(buf)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * 3;
  return [data[o]!, data[o + 1]!, data[o + 2]!];
}

/** Mean red over a rectangular region [x0,x1) x [y0,y1). */
async function meanRed(
  buf: Buffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Promise<number> {
  const { data, info } = await sharp(buf)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sum += data[(y * info.width + x) * 3]!;
      n++;
    }
  }
  return sum / n;
}

describe("harmonizeFixtures", () => {
  it("shifts the fixture's color toward the scene while leaving the room untouched", async () => {
    const { base, placements } = await makeScene();
    const before = await pixel(base, FX + FIX / 2, FY + FIX / 2);
    expect(before[2]).toBeGreaterThan(before[0]); // cool (blue > red) to start

    const out = await harmonizeFixtures({
      base,
      width: SCENE,
      height: SCENE,
      placements,
      strength: 1,
    });

    // Fixture center now leans warm (red up, blue down) toward the scene.
    const after = await pixel(out, FX + FIX / 2, FY + FIX / 2);
    expect(after[0]).toBeGreaterThan(before[0]);
    expect(after[2]).toBeLessThan(before[2]);

    // A scene corner pixel is byte-identical (region-locked).
    const corner = await pixel(out, 2, 2);
    expect(corner).toEqual(SCENE_RGB);
  });

  it("is a no-op when strength is 0 and there is no shadow", async () => {
    const { base, placements } = await makeScene();
    const out = await harmonizeFixtures({
      base,
      width: SCENE,
      height: SCENE,
      placements,
      strength: 0,
    });
    expect(out).toBe(base);
  });

  it("renders a contact shadow below the fixture when shadowPx > 0", async () => {
    const { base, placements } = await makeScene();
    const out = await harmonizeFixtures({
      base,
      width: SCENE,
      height: SCENE,
      placements,
      strength: 0,
      shadowPx: 12,
    });
    // The band just below the fixture should be darkened on average by the
    // contact shadow.
    const before = await meanRed(base, FX, FY + FIX, FX + FIX, FY + FIX + 8);
    const after = await meanRed(out, FX, FY + FIX, FX + FIX, FY + FIX + 8);
    expect(after).toBeLessThan(before);
  });
});
