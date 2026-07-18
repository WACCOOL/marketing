import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIES } from "./ies-parser.js";
import { solveTrackBom } from "./trackBom.js";
import type { EstimatorInputs } from "./types.js";
import type { BomLine, TrackSystem } from "./trackTypes.js";

const M_PER_FT = 0.3048;

function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
}
const head = parseIES(fixture("R2SD2T-WTWA-WT.IES"), "R2SD2T-WTWA-WT.IES"); // ~14.89 W

function space(lengthFt: number, widthFt: number): EstimatorInputs {
  return {
    mounting: "ceiling",
    aim: "down",
    target: { kind: "horizontal", heightAboveFloor: 0.76 },
    roomLength: lengthFt * M_PER_FT,
    roomWidth: widthFt * M_PER_FT,
    ceilingHeight: 9 * M_PER_FT,
    reflectances: { ceiling: 0.8, wall: 0.5, floor: 0.2 },
    targetFc: 30,
    taskKey: "office-general",
    llf: 0.85,
    unit: "fc",
    system: "imperial",
  };
}

const LOW_VOLT: TrackSystem = {
  key: "flexrail-lv",
  label: "FlexRail LV",
  trackType: "FLEXRAIL",
  voltageClass: "low",
  segmentLengthsFt: [8, 4, 2],
  feedCapacityW: 300,
  defaultHeadSpacingFt: 4,
  compatibleHeadTrackTypes: ["FLEXRAIL"],
  components: [
    { role: "channel", sku: "CH-8", segmentLengthFt: 8 },
    { role: "channel", sku: "CH-4", segmentLengthFt: 4 },
    { role: "channel", sku: "CH-2", segmentLengthFt: 2 },
    { role: "head", sku: "HEAD-LV", headWatts: 12 },
    { role: "feed", sku: "FEED-LV" },
    { role: "connector", sku: "CONN-LV" },
    { role: "endcap", sku: "END-LV" },
    { role: "transformer", sku: "XFMR-300", capacityW: 300 },
  ],
};

const LINE_VOLT: TrackSystem = {
  key: "h-track",
  label: "H Track",
  trackType: "H",
  voltageClass: "line",
  segmentLengthsFt: [8, 4, 2],
  circuitVa: 200, // small on purpose → forces >1 circuit
  defaultHeadSpacingFt: 4,
  compatibleHeadTrackTypes: ["H"],
  components: [
    { role: "channel", sku: "H-8", segmentLengthFt: 8 },
    { role: "head", sku: "H-HEAD", headWatts: 12 },
    { role: "feed", sku: "H-FEED" },
    { role: "connector", sku: "H-CONN" },
    { role: "endcap", sku: "H-END" },
  ],
};

function line(lines: BomLine[], role: string): BomLine | undefined {
  return lines.find((l) => l.role === role);
}

describe("solveTrackBom — low-voltage 20×10 ft", () => {
  const r = solveTrackBom(head, space(20, 10), LOW_VOLT);

  it("tiles the grid rows into runs and cols into heads-per-run", () => {
    expect(r.summary.headCount).toBe(18);
    expect(r.summary.runs).toBe(6);
    expect(r.summary.headsPerRun).toBe(3);
  });

  it("snaps each 10 ft run up to buildable segments (8 + 2)", () => {
    const ch8 = r.bom.lines.find((l) => l.sku === "CH-8");
    const ch2 = r.bom.lines.find((l) => l.sku === "CH-2");
    expect(ch8?.qty).toBe(6); // one 8 ft per run × 6 runs
    expect(ch2?.qty).toBe(6); // one 2 ft per run × 6 runs
    expect(r.summary.totalTrackFt).toBe(60);
  });

  it("counts connectors = Σ(segments−1), endcaps = 2×runs, feeds = runs", () => {
    expect(line(r.bom.lines, "connector")?.qty).toBe(6); // 6 runs × (2−1)
    expect(line(r.bom.lines, "endcap")?.qty).toBe(12); // 2 × 6
    expect(line(r.bom.lines, "feed")?.qty).toBe(6);
  });

  it("sizes low-voltage transformers by connected watts and warns near capacity", () => {
    // 18 heads × 14.89 W ≈ 268 W → one 300 W transformer, ~89% loaded.
    expect(r.summary.transformerCount).toBe(1);
    expect(r.summary.circuits).toBeUndefined();
    expect(r.summary.totalWatts).toBeGreaterThan(260);
    expect(r.warnings.some((w) => /near capacity/i.test(w))).toBe(true);
  });
});

describe("solveTrackBom — line-voltage sizes circuits, not transformers", () => {
  const r = solveTrackBom(head, space(20, 10), LINE_VOLT);
  it("computes circuits = ceil(totalW / (circuitVa × 0.8)) and no transformer", () => {
    // 268 W / (200 × 0.8 = 160) → 2 circuits.
    expect(r.summary.circuits).toBe(2);
    expect(r.summary.transformerCount).toBe(0);
    expect(r.warnings.some((w) => /circuits/i.test(w))).toBe(true);
  });
});

describe("solveTrackBom — degrades without a system record", () => {
  const r = solveTrackBom(head, space(20, 10), null, { headWattsOverride: 15 });
  it("still lays out heads but emits a generic, sku-null parts list", () => {
    expect(r.summary.headCount).toBe(18);
    expect(r.summary.totalTrackFt).toBe(0); // no buildable segments known
    expect(r.bom.lines.every((l) => l.sku === null)).toBe(true);
    expect(line(r.bom.lines, "channel")).toBeUndefined(); // no segment data
    expect(line(r.bom.lines, "head")?.qty).toBe(18);
    expect(r.warnings.some((w) => /no matching track system/i.test(w))).toBe(true);
  });
});

describe("solveTrackBom — degrades without an IES file (lumen method)", () => {
  const r = solveTrackBom(null, space(20, 10), LINE_VOLT, { lumensPerHead: 600 });
  it("estimates a single-run head count and warns there is no heatmap", () => {
    expect(r.summary.headCount).toBe(17);
    expect(r.summary.runs).toBe(1);
    expect(r.summary.avgFc).toBe(0);
    expect(r.estimator).toBeUndefined();
    expect(r.warnings.some((w) => /no ies file/i.test(w))).toBe(true);
  });
});
