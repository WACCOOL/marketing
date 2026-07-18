/* ════════════════════════════════════════════════════════════
   Track bill-of-materials solver (PURE)

   Given a head fixture's IES (optional) + estimator inputs + a seeded
   TrackSystem record, produce a buildable BOM (channel segments, heads,
   feeds, connectors, end caps, transformers/circuits) and a layout
   summary. The photometric layout reuses the ported WIES area-grid
   solver (solveLayout) to decide how many heads and how they tile; the
   grid ROWS become track RUNS and the grid COLS become heads-per-run.

   This function is PURE — no DB, no fetch. The Thom `plan_layout` tool
   reads the head IES + the track_systems/track_components row and passes
   them in. When no system record is supplied it degrades to a generic
   parts list (sku:null lines the model can resolve via
   get_related_products) rather than throwing.
   ──────────────────────────────────────────────────────────── */

import type { EstimatorInputs, EstimatorResult, IESParseResult } from "./types.js";
import { solveLayout } from "./layout.js";
import { M_PER_FT } from "./units.js";
import type {
  BomLine,
  TrackComponent,
  TrackComponentRole,
  TrackLayoutResult,
  TrackSystem,
} from "./trackTypes.js";

/** Options the tool supplies alongside the DB-read system record.
 *
 *  `headWattsOverride` / `lumensPerHead` / `headTrackType` come from the
 *  head product's variants + precomputed photometrics (the pure function
 *  can't read the DB itself). `maxIter` / `gridN` are accepted for
 *  forward-compat + the tool's own time-guard bookkeeping; solveLayout
 *  uses fixed internal bounds, so they don't change its result today. */
export interface TrackBomOptions {
  /** Per-head wattage when the IES header carries none (from variants[].watts). */
  headWattsOverride?: number;
  /** Per-head delivered lumens (from precomputed photometrics) — used to
   *  estimate the head count on the IES-missing degraded path. */
  lumensPerHead?: number;
  /** The head product's track type, for the head↔track compatibility warn. */
  headTrackType?: string;
  maxIter?: number;
  gridN?: number;
}

/** Greedy largest-first bin-pack: cover `runLenFt` with the buildable
 *  segment lengths, snapping UP (the last segment may overshoot). Returns
 *  the multiset of segment lengths used for ONE run. */
function binPackRun(runLenFt: number, segsFt: number[]): number[] {
  const segs = segsFt.filter((s) => s > 0).sort((a, b) => b - a);
  if (segs.length === 0 || runLenFt <= 0) return [];
  const smallest = segs[segs.length - 1]!;
  const used: number[] = [];
  const EPS = 1e-6;
  let remaining = runLenFt;
  let guard = 0;
  while (remaining > EPS && guard++ < 10000) {
    // Largest segment that still fits; if none fits (remaining smaller
    // than the smallest segment), snap UP with one smallest segment.
    const pick = segs.find((s) => s <= remaining + EPS) ?? smallest;
    used.push(pick);
    remaining -= pick;
  }
  return used;
}

function findComponent(
  system: TrackSystem | null,
  role: TrackComponentRole,
  segmentLengthFt?: number,
): TrackComponent | undefined {
  if (!system) return undefined;
  return system.components.find(
    (c) =>
      c.role === role &&
      (segmentLengthFt === undefined ||
        (c.segmentLengthFt !== undefined && Math.abs(c.segmentLengthFt - segmentLengthFt) < 1e-6)),
  );
}

/** Solve a track bill-of-materials for one head fixture over a space. */
export function solveTrackBom(
  ies: IESParseResult | null,
  inputs: EstimatorInputs,
  system: TrackSystem | null,
  opts: TrackBomOptions = {},
): TrackLayoutResult {
  const warnings: string[] = [];

  // ── head wattage precedence ───────────────────────────────
  const headComponent = findComponent(system, "head");
  const headWatts =
    ies && ies.inputWatts > 0
      ? ies.inputWatts
      : opts.headWattsOverride ?? headComponent?.headWatts ?? 0;
  if (headWatts <= 0) {
    warnings.push(
      "Head wattage is unknown — total watts, circuits, and transformer counts are placeholders; confirm the head's rated watts.",
    );
  }

  // ── 1. photometric layout → head count + grid shape ───────
  let estimator: EstimatorResult | undefined;
  let count = 0;
  let rows = 0;
  let cols = 0;
  let actualFc = 0;
  let uniformity = 0;
  let spacingXm = 0;

  if (ies) {
    estimator = solveLayout(ies, inputs, { wattage: headWatts });
    count = estimator.count;
    rows = estimator.rows;
    cols = estimator.cols;
    actualFc = estimator.actualFc;
    uniformity = estimator.uniformity;
    spacingXm = estimator.spacingX;
    if (estimator.unreachable) {
      warnings.push(
        "This head can't reach the target illuminance in this space even at the max layout — increase the target head, lower the target fc, or add rows.",
      );
    }
  } else {
    // Degraded: no IES → estimate head count by the lumen method with a
    // conservative default CU, single run, no heatmap.
    warnings.push(
      "No IES file for the head — the layout is a lumen-method estimate (no heatmap / uniformity); verify in AGi32 or Ventrix.",
    );
    const areaFt2 = (inputs.roomLength / M_PER_FT) * (inputs.roomWidth / M_PER_FT);
    const cu = 0.7;
    const lm = opts.lumensPerHead ?? 0;
    if (lm > 0 && inputs.llf > 0 && areaFt2 > 0) {
      count = Math.max(1, Math.ceil((inputs.targetFc * areaFt2) / (lm * cu * inputs.llf)));
    } else {
      warnings.push(
        "Head lumens are unknown — head count could not be estimated; showing the system parts list only.",
      );
    }
    rows = count > 0 ? 1 : 0;
    cols = count;
  }

  // ── 2. grid → runs / heads-per-run / run length ───────────
  const runs = rows;
  const headsPerRun = cols;
  const headSpacingFt =
    ies && spacingXm > 0 ? spacingXm / M_PER_FT : system?.defaultHeadSpacingFt ?? 4;
  // Half-spacing end margin each end sums to one full spacing, mirroring
  // placeFixtures' dx*(c+0.5) placement → run length = heads × spacing.
  const runLenFt = headsPerRun * headSpacingFt;

  if (system?.maxHeadsPerRun && headsPerRun > system.maxHeadsPerRun) {
    warnings.push(
      `Heads per run (${headsPerRun}) exceeds this system's max of ${system.maxHeadsPerRun} — split the run or the feed can't carry it.`,
    );
  }

  // ── 3. snap each run up to buildable channel segments ──────
  const segmentsPerRun = binPackRun(runLenFt, system?.segmentLengthsFt ?? []);
  const segFtPerRun = segmentsPerRun.reduce((a, b) => a + b, 0);
  const totalTrackFt = runs * segFtPerRun;

  // ── 4. electrical: circuits (line) or transformers (low) ───
  const totalWatts = count * Math.max(0, headWatts);
  let circuits: number | undefined;
  let transformerCount = 0;
  if (system?.voltageClass === "line") {
    const va = system.circuitVa ?? 0;
    if (va > 0 && totalWatts > 0) {
      const usableVa = va * 0.8; // 80% continuous-load derate
      circuits = Math.ceil(totalWatts / usableVa);
      const fill = totalWatts / (circuits * usableVa);
      if (fill >= 0.8) {
        warnings.push(
          `Circuits are ${Math.round(fill * 100)}% loaded (80% continuous-load basis) — near capacity; consider an extra circuit.`,
        );
      }
    } else if (totalWatts > 0) {
      circuits = 1;
    }
  } else if (system?.voltageClass === "low") {
    const cap = system.feedCapacityW ?? 0;
    if (cap > 0 && totalWatts > 0) {
      transformerCount = Math.ceil(totalWatts / cap);
      const fill = totalWatts / (transformerCount * cap);
      if (fill >= 0.8) {
        warnings.push(
          `Transformers/feeds are ${Math.round(fill * 100)}% loaded — near capacity; consider adding a feed.`,
        );
      }
    } else if (totalWatts > 0) {
      transformerCount = 1;
    }
  }

  // ── 5. accessory counts ───────────────────────────────────
  const segCount = segmentsPerRun.length;
  const connectors = runs * Math.max(0, segCount - 1);
  const endcaps = 2 * runs;
  const feeds = runs;

  // ── 6. aggregate into BOM lines ───────────────────────────
  const rawLines: BomLine[] = [];

  // Channels — one line per distinct segment length, qty × runs.
  const segCountByLen = new Map<number, number>();
  for (const s of segmentsPerRun) segCountByLen.set(s, (segCountByLen.get(s) ?? 0) + 1);
  for (const [len, perRun] of segCountByLen) {
    const comp = findComponent(system, "channel", len);
    rawLines.push({
      sku: comp?.sku ?? null,
      description: comp?.description ?? `Track channel — ${len} ft section`,
      qty: perRun * runs,
      role: "channel",
    });
  }

  const pushLine = (role: TrackComponentRole, qty: number, fallbackDesc: string) => {
    if (qty <= 0) return;
    const comp = findComponent(system, role);
    rawLines.push({
      sku: comp?.sku ?? null,
      description: comp?.description ?? fallbackDesc,
      qty,
      role,
    });
  };

  pushLine("head", count, "Track head");
  pushLine("feed", feeds, "Power feed / live end");
  pushLine("connector", connectors, "Track connector");
  pushLine("endcap", endcaps, "Track end cap");
  pushLine("transformer", transformerCount, "Transformer / low-voltage feed");

  // Merge identical (role, sku) lines so the BOM never double-lists a SKU.
  const merged = new Map<string, BomLine>();
  for (const line of rawLines) {
    const key = `${line.role}|${line.sku ?? ""}|${line.description}`;
    const existing = merged.get(key);
    if (existing) existing.qty += line.qty;
    else merged.set(key, { ...line });
  }
  const lines = [...merged.values()];

  // ── 7. remaining warnings ─────────────────────────────────
  if (!system) {
    warnings.push(
      "No matching track system on file — this is a generic parts list; the buildable channel segments, connectors, and exact SKUs need the seeded track_systems data.",
    );
  }
  if (
    system &&
    opts.headTrackType &&
    system.compatibleHeadTrackTypes.length > 0 &&
    !system.compatibleHeadTrackTypes.includes(opts.headTrackType)
  ) {
    warnings.push(
      `The head's track type (${opts.headTrackType}) isn't listed as compatible with the ${system.label} system (${system.compatibleHeadTrackTypes.join(", ")}) — confirm the head fits this rail.`,
    );
  }

  return {
    bom: { lines },
    summary: {
      headCount: count,
      runs,
      headsPerRun,
      headSpacingFt,
      totalTrackFt,
      transformerCount,
      circuits,
      avgFc: actualFc,
      uniformity,
      totalWatts,
    },
    estimator,
    heads: [],
    warnings,
  };
}
