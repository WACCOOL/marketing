import { describe, expect, it } from "vitest";
import { photometricsDispatch } from "./photometricsTools.js";
import type { PhotometricsCard, ToolContext } from "./types.js";

/** Minimal metric bundle for the formatter. */
function bundle(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "LM-63-2002",
    photometricType: "C",
    lumens: 1200,
    inputWatts: 15,
    efficacy: 80,
    maxCandela: 4500,
    maxAngle: 0,
    beam: { beamAngle: 24, fieldAngle: 48, beamC0: 24, beamC90: 24, fieldC0: 48, fieldC90: 48 },
    spacingCriterion: { plane0: 1.1, plane90: 1.1, average: 1.1, symmetric: true },
    zonal: { total: 1200, downward: 1200, upward: 0 },
    bug: { rating: "B1 U0 G1", B: 1, U: 0, G: 1 },
    ugr: { value: 16.2 },
    cone: [{ mountingHeightFt: 8, mountingHeightM: 2.44, beamDiaM: 1.0, fieldDiaM: 2.0, centerFc: 42, centerLux: 452 }],
    ...over,
  };
}

interface Row {
  ies_url: string | null;
  is_representative: boolean | null;
  match_confidence: number | null;
  ies_metrics: { inner_filename: string | null; metrics: Record<string, unknown> | null; warnings: unknown } | null;
}

/** Fake Supabase client: product_photometrics(...).select(...).eq(...) → rows. */
function fakeCtx(rows: Row[], error: { message: string } | null = null): ToolContext {
  const sb = {
    from() {
      return {
        select() {
          return {
            eq() {
              return Promise.resolve({ data: error ? null : rows, error });
            },
          };
        },
      };
    },
  };
  return { env: {} as ToolContext["env"], sb: sb as unknown as ToolContext["sb"] };
}

describe("get_photometrics", () => {
  it("prefers the representative distribution and enumerates other optics", async () => {
    const rows: Row[] = [
      {
        ies_url: "u",
        is_representative: false,
        match_confidence: 0.2,
        ies_metrics: { inner_filename: "OPTIC-NARROW.IES", metrics: bundle(), warnings: [] },
      },
      {
        ies_url: "u",
        is_representative: true,
        match_confidence: 0.9,
        ies_metrics: { inner_filename: "REP-WIDE.IES", metrics: bundle({ efficacy: 88 }), warnings: [] },
      },
    ];
    const out = await photometricsDispatch(fakeCtx(rows), "get_photometrics", { sku: "R2RAT-FTWA-WT" });
    expect(out.content).toContain("REP-WIDE.IES");
    expect(out.content).toContain("Beam angle 24.0°");
    expect(out.content).toContain("BUG rating: B1 U0 G1");
    expect(out.content).toContain("OPTIC-NARROW.IES"); // listed as another optic
    expect(out.cards).toHaveLength(1);
    const card = out.cards[0] as PhotometricsCard;
    expect(card.kind).toBe("photometrics");
    expect(card.sku).toBe("R2RAT-FTWA-WT");
    expect(card.source_filename).toBe("REP-WIDE.IES");
  });

  it("surfaces symmetric BUG/UGR caveats and omits them", async () => {
    const rows: Row[] = [
      {
        ies_url: "u",
        is_representative: true,
        match_confidence: 0,
        ies_metrics: {
          inner_filename: "TRACK.IES",
          metrics: bundle({ bug: null, ugr: null }),
          warnings: [
            { code: "I_SYMMETRIC", severity: "info", message: "Rotationally symmetric distribution (1 horizontal plane)." },
          ],
        },
      },
    ];
    const out = await photometricsDispatch(fakeCtx(rows), "get_photometrics", { sku: "AELS" });
    expect(out.content).toContain("BUG: not applicable");
    expect(out.content).toContain("UGR: not applicable");
    expect(out.content).toContain("Caveats:");
    expect(out.content).toContain("Rotationally symmetric");
  });

  it("is graceful when a SKU has no computed metrics (no live compute)", async () => {
    const out = await photometricsDispatch(fakeCtx([]), "get_photometrics", { sku: "UNKNOWN-1" });
    expect(out.content).toContain("haven't been computed yet");
    expect(out.cards).toHaveLength(0);
  });

  it("requires a sku", async () => {
    const out = await photometricsDispatch(fakeCtx([]), "get_photometrics", {});
    expect(out.content).toContain("sku is required");
  });
});

describe("lighting_requirement (pure)", () => {
  const ctx = fakeCtx([]); // never touches sb

  it("resolves an exact task key with fc + uniformity + LPD + source", async () => {
    const out = await photometricsDispatch(ctx, "lighting_requirement", { task: "office-general" });
    expect(out.content).toContain("30 fc");
    expect(out.content).toContain("3:1");
    expect(out.content).toContain("W/ft²");
    expect(out.content).toContain("IES RP-1");
    expect(out.cards).toHaveLength(0);
  });

  it("matches free-text queries", async () => {
    const out = await photometricsDispatch(ctx, "lighting_requirement", { query: "museum gallery wash" });
    expect(out.content.toLowerCase()).toContain("gallery");
  });

  it("filters outdoor vertical targets", async () => {
    const out = await photometricsDispatch(ctx, "lighting_requirement", {
      target: "vertical",
      environment: "outdoor",
    });
    expect(out.content.toLowerCase()).toContain("façade");
    expect(out.content).not.toContain("Office, general");
  });

  it("reports the available keys when nothing matches", async () => {
    const out = await photometricsDispatch(ctx, "lighting_requirement", { task: "nope", query: "zzzzzzz" });
    expect(out.content).toContain("office-general");
  });
});
