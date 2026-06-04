import { describe, expect, it } from "vitest";
import { computeCutoutPixelSize } from "./scale.js";

/**
 * QA for PRD §6 acceptance criteria that are deterministically verifiable from
 * the scale engine (the authoritative sizing math the compositor uses):
 *   - A known fixture in a known-size room renders within scale tolerance.
 *   - Multi-fixture arrays place the right count without overlap.
 *
 * Product recognizability (hybrid) and tag-on-save are exercised by the
 * pipeline/UI; they're covered in the QA notes, not here.
 */

// Scene scale from a known room: a 6000 mm wide wall photographed at 4000 px.
const ROOM_WIDTH_MM = 6000;
const SCENE_WIDTH_PX = 4000;
const pxPerMm = SCENE_WIDTH_PX / ROOM_WIDTH_MM; // 0.6667 px/mm

// Engine error is pure integer rounding, so it stays well under 1%.
const SCALE_TOLERANCE = 0.01;

describe("scale QA — known fixture in a known-size room", () => {
  it("sizes a 1200 mm linear fixture to the expected fraction of the scene", () => {
    const size = computeCutoutPixelSize({
      dimensionsMm: { length: 1200 },
      pxPerMm,
      scaleAdjust: 1,
      cutoutAspect: 4, // wide linear fixture
      widthBasis: "auto",
    });
    // 1200 mm of a 6000 mm room == 20% of the 4000 px scene == 800 px.
    const expectedPx = (1200 / ROOM_WIDTH_MM) * SCENE_WIDTH_PX;
    expect(Math.abs(size.width - expectedPx) / expectedPx).toBeLessThan(
      SCALE_TOLERANCE,
    );
    expect(size.width).toBe(800);
  });

  it("sizes a 300 mm round downlight by diameter within tolerance", () => {
    const size = computeCutoutPixelSize({
      dimensionsMm: { diameter: 300 },
      pxPerMm,
      scaleAdjust: 1,
      cutoutAspect: 1,
      widthBasis: "auto",
    });
    const expectedPx = (300 / ROOM_WIDTH_MM) * SCENE_WIDTH_PX; // 200 px
    expect(Math.abs(size.width - expectedPx) / expectedPx).toBeLessThan(
      SCALE_TOLERANCE,
    );
    expect(size.width).toBe(200);
  });

  it("applies the user's scaleAdjust correction multiplicatively", () => {
    const base = computeCutoutPixelSize({
      dimensionsMm: { width: 600 },
      pxPerMm,
      scaleAdjust: 1,
      cutoutAspect: 1,
      widthBasis: "auto",
    });
    const bumped = computeCutoutPixelSize({
      dimensionsMm: { width: 600 },
      pxPerMm,
      scaleAdjust: 1.25,
      cutoutAspect: 1,
      widthBasis: "auto",
    });
    expect(Math.abs(bumped.width - base.width * 1.25)).toBeLessThanOrEqual(1);
  });
});

describe("scale QA — multi-fixture array placement", () => {
  /**
   * Mirror the UI's expandArray model: `count` copies centered on the base x,
   * spaced `spacingPct` of scene width apart. With each copy sized by the scale
   * engine, the array is overlap-free iff the center spacing exceeds the copy
   * width. (anchorToTopLeft clamps to the scene; this checks the pre-clamp model
   * that governs whether neighbors collide.)
   */
  function arrayCenters(count: number, baseXPct: number, spacingPct: number) {
    const totalSpan = spacingPct * (count - 1);
    const start = baseXPct - totalSpan / 2;
    return Array.from({ length: count }, (_, i) => start + i * spacingPct);
  }

  it("places the right count with no horizontal overlap at adequate spacing", () => {
    const count = 4;
    const spacingPct = 0.15;
    const centers = arrayCenters(count, 0.5, spacingPct).map(
      (c) => c * SCENE_WIDTH_PX,
    );
    expect(centers).toHaveLength(count);

    // 300 mm round fixture -> 200 px wide; 0.15 * 4000 = 600 px spacing.
    const size = computeCutoutPixelSize({
      dimensionsMm: { diameter: 300 },
      pxPerMm,
      scaleAdjust: 1,
      cutoutAspect: 1,
      widthBasis: "auto",
    });

    for (let i = 1; i < centers.length; i++) {
      const gap = centers[i]! - centers[i - 1]!;
      expect(gap).toBeGreaterThan(size.width); // centers farther apart than width => no overlap
    }
  });

  it("detects overlap when spacing is too tight (guards the no-overlap check)", () => {
    const spacingPct = 0.03; // 120 px spacing < 200 px fixture width
    const centers = arrayCenters(3, 0.5, spacingPct).map(
      (c) => c * SCENE_WIDTH_PX,
    );
    const size = computeCutoutPixelSize({
      dimensionsMm: { diameter: 300 },
      pxPerMm,
      scaleAdjust: 1,
      cutoutAspect: 1,
      widthBasis: "auto",
    });
    const gap = centers[1]! - centers[0]!;
    expect(gap).toBeLessThan(size.width); // confirms the assertion above is meaningful
  });
});
