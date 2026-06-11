import { describe, expect, it } from "vitest";
import { normalizeShotFixtures } from "./appshot.js";
import {
  AppShotFinalizeRequestSchema,
  AppShotPlacementSchema,
  AppShotPreviewRequestSchema,
} from "./types.js";

const placement = AppShotPlacementSchema.parse({});

describe("normalizeShotFixtures", () => {
  it("passes a fixtures array through untouched", () => {
    const fixtures = [
      { id: "a", sku: "SKU-1", placement },
      { id: "b", sku: "SKU-2", placement },
    ];
    expect(normalizeShotFixtures({ fixtures })).toBe(fixtures);
  });

  it("wraps a legacy sku + placement shot into a one-element array", () => {
    expect(normalizeShotFixtures({ sku: "SKU-1", placement })).toEqual([
      { sku: "SKU-1", placement },
    ]);
  });

  it("prefers fixtures when both shapes are present", () => {
    const fixtures = [{ sku: "SKU-2", placement }];
    expect(
      normalizeShotFixtures({ sku: "SKU-1", placement, fixtures }),
    ).toBe(fixtures);
  });

  it("throws when neither shape is present", () => {
    expect(() => normalizeShotFixtures({})).toThrow(/no fixtures/);
    expect(() => normalizeShotFixtures({ sku: "SKU-1" })).toThrow(/no fixtures/);
    expect(() => normalizeShotFixtures({ fixtures: [] })).toThrow(/no fixtures/);
  });
});

describe("app-shot request schemas", () => {
  const sceneUrl = "https://example.com/room.png";

  it("accepts the legacy single-fixture finalize payload", () => {
    const parsed = AppShotFinalizeRequestSchema.safeParse({
      sku: "SKU-1",
      sceneUrl,
      placement: {},
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a multi-fixture finalize payload", () => {
    const parsed = AppShotFinalizeRequestSchema.safeParse({
      sceneUrl,
      fixtures: [
        { sku: "SKU-1", placement: {} },
        { id: "f2", sku: "SKU-2", placement: { coverage: 0.2 } },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a payload with neither fixtures nor sku + placement", () => {
    expect(AppShotFinalizeRequestSchema.safeParse({ sceneUrl }).success).toBe(false);
    expect(
      AppShotPreviewRequestSchema.safeParse({ sceneUrl, sku: "SKU-1" }).success,
    ).toBe(false);
  });

  it("rejects an empty fixtures array", () => {
    expect(
      AppShotPreviewRequestSchema.safeParse({ sceneUrl, fixtures: [] }).success,
    ).toBe(false);
  });
});

describe("placement bounds", () => {
  it("allows coverage down to 1%", () => {
    expect(AppShotPlacementSchema.safeParse({ coverage: 0.01 }).success).toBe(true);
    expect(AppShotPlacementSchema.safeParse({ coverage: 0.005 }).success).toBe(false);
  });

  it("defaults brightness and light output to the calibrated 50", () => {
    expect(placement.brightness).toBe(50);
    expect(placement.lightOutput).toBe(50);
  });
});
