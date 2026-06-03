import { describe, expect, it } from "vitest";
import {
  APPIMAGE_PARAMS_VERSION,
  AppImageParamsSchema,
} from "./types.js";

const sceneUrl = "https://cdn.example.com/room.jpg";
const cutoutUrl = "https://cdn.example.com/fixture.png";

const fixture = {
  cutoutUrl,
  dimensionsMm: { diameter: 120 },
  xPct: 0.5,
  yPct: 0.8,
};

const compositeParams = {
  sceneUrl,
  scale: { pxPerMm: 2 },
  fixtures: [fixture],
};

describe("AppImageParamsSchema", () => {
  it("accepts a legacy v1 payload and resolves it to composite mode", () => {
    const parsed = AppImageParamsSchema.parse({
      version: "appimage-v1",
      ...compositeParams,
    });
    expect(parsed.version).toBe("appimage-v1");
    expect(parsed.mode).toBe("composite");
    expect(parsed.fixtures).toHaveLength(1);
  });

  it("defaults version to v2 and mode to composite when omitted", () => {
    const parsed = AppImageParamsSchema.parse(compositeParams);
    expect(parsed.version).toBe(APPIMAGE_PARAMS_VERSION);
    expect(parsed.version).toBe("appimage-v2");
    expect(parsed.mode).toBe("composite");
    // harmonize + referenceImages defaults are populated.
    expect(parsed.harmonize.globalPass).toBe(false);
    expect(parsed.harmonize.maskDilationPx).toBe(48);
    expect(parsed.referenceImages).toEqual([]);
  });

  it("composite mode requires sceneUrl, scale, and a fixture", () => {
    expect(
      AppImageParamsSchema.safeParse({ mode: "composite", fixtures: [] }).success,
    ).toBe(false);
    const r = AppImageParamsSchema.safeParse({
      mode: "composite",
      sceneUrl,
      scale: { pxPerMm: 2 },
      fixtures: [],
    });
    expect(r.success).toBe(false);
  });

  it("hybrid mode requires a prompt on top of the composite fields", () => {
    const noPrompt = AppImageParamsSchema.safeParse({
      mode: "hybrid",
      ...compositeParams,
    });
    expect(noPrompt.success).toBe(false);

    const withPrompt = AppImageParamsSchema.safeParse({
      mode: "hybrid",
      ...compositeParams,
      prompt: "warm evening living room",
    });
    expect(withPrompt.success).toBe(true);
  });

  it("concept mode requires a prompt but no fixtures or scene", () => {
    const noPrompt = AppImageParamsSchema.safeParse({ mode: "concept" });
    expect(noPrompt.success).toBe(false);

    const ok = AppImageParamsSchema.safeParse({
      mode: "concept",
      prompt: "a modern lobby lit by pendant fixtures",
      referenceImages: [cutoutUrl],
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.fixtures).toEqual([]);
      expect(ok.data.referenceImages).toEqual([cutoutUrl]);
    }
  });

  it("rejects an unknown contract version", () => {
    const r = AppImageParamsSchema.safeParse({
      version: "appimage-v3",
      ...compositeParams,
    });
    expect(r.success).toBe(false);
  });
});
