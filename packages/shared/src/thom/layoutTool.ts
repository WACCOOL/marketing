// =============================================================================
// Thom layout tool — plan_layout. Ports the WIES layout solver (+ the track
// bill-of-materials machinery) in @wac/shared onto Thom as a tool. Split out of
// tools.ts (mirroring photometricsTools.ts) and composed onto the tool set by
// agent.ts only when THOM_LAYOUT === "1" (dark-launch).
//
//  - plan_layout: given a space, a product (track head / downlight / tape), and
//    an optional target task/fc, computes how many heads/fixtures are needed,
//    lays them out, and — for a TRACK system — assembles a buildable bill of
//    materials (channel segments, feeds, connectors, end caps, transformers or
//    circuits). It's an ESTIMATE to verify in AGi32/Ventrix.
//
// The heavy math is PURE and lives in @wac/shared (solveLayout / solveTrackBom /
// solveLinearLayout); this file does the DB reads + the (bounded) IES fetch and
// shapes a LayoutCard.
// =============================================================================

import {
  M_PER_FT,
  findTask,
  parseIES,
  solveLayout,
  solveLinearLayout,
  solveTrackBom,
  type EstimatorInputs,
  type EstimatorResult,
  type IESParseResult,
  type LinearEstimatorInputs,
  type PlacedFixture,
  type TrackComponent,
  type TrackComponentRole,
  type TrackSystem,
} from "../index.js";
import type { ClaudeTool } from "./transport.js";
import type { LayoutBomLine, LayoutCard, ToolContext, ToolOutput } from "./types.js";

export const LAYOUT_TOOLS: ClaudeTool[] = [
  {
    name: "plan_layout",
    description:
      "Estimate a lighting LAYOUT and (for track) a BILL OF MATERIALS for a space: how many track heads / downlights / feet of tape are needed to hit a target light level, how they lay out, and — for a track system — the full parts list (channel sections, power feeds, connectors, end caps, and transformers or circuits). Use this for 'how much / how many heads / lay out / what do I need for a NxM room' questions. It's an ESTIMATE to verify in AGi32 / Ventrix — hand off the full track config to the Ventrix configurator.",
    input_schema: {
      type: "object",
      properties: {
        space: {
          type: "object",
          description: "The room / area to light.",
          properties: {
            length_ft: { type: "number", description: "Room length in feet." },
            width_ft: { type: "number", description: "Room width in feet." },
            mounting_height_ft: {
              type: "number",
              description: "Ceiling / mounting height in feet (default 9).",
            },
          },
          required: ["length_ft", "width_ft"],
        },
        product: {
          type: "object",
          description: "The fixture to lay out (a track head, downlight, or tape). Give a SKU when known.",
          properties: {
            sku: { type: "string", description: "The head/fixture SKU / PPID." },
            family: { type: "string", description: "Product family, when no SKU." },
            category: { type: "string", description: "Product category, when no SKU/family." },
          },
        },
        target: {
          type: "object",
          description: "Desired light level.",
          properties: {
            task_key: {
              type: "string",
              description: "A task key (e.g. 'office-general', 'retail-merchandise') to set the target footcandles.",
            },
            target_fc: { type: "number", description: "Explicit target maintained footcandles (overrides task_key)." },
          },
        },
      },
      required: ["space", "product"],
    },
  },
];

// --- helpers ---------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function numOr(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Classify the layout at tool time from the product's family/category text.
 *  Track is a multi-product relationship (head + system), not a single
 *  product's LayoutKind, so it's decided here. */
export function classifyLayoutKind(family: string | null, category: string | null): "track" | "linear" | "area-grid" {
  const hay = `${family ?? ""} ${category ?? ""}`.toLowerCase();
  if (hay.includes("track")) return "track";
  if (/\b(tape|strip|invisiled)\b/.test(hay)) return "linear";
  return "area-grid";
}

/** Parse a wattage number out of a variant `watts` field (string or number). */
function parseWatts(variants: unknown): number | undefined {
  if (!Array.isArray(variants)) return undefined;
  for (const v of variants as Record<string, unknown>[]) {
    const w = v?.watts;
    if (typeof w === "number" && Number.isFinite(w) && w > 0) return w;
    if (typeof w === "string") {
      const m = w.match(/[\d.]+/);
      if (m) {
        const n = Number(m[0]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  }
  return undefined;
}

interface ResolvedProduct {
  sku: string | null;
  name: string | null;
  family: string | null;
  category: string | null;
  variants: unknown;
}

/** Resolve the product record from a sku / family / category. */
async function resolveProduct(ctx: ToolContext, product: Record<string, unknown>): Promise<ResolvedProduct | null> {
  const sku = str(product.sku);
  const family = str(product.family);
  const category = str(product.category);
  const cols = "sku, name, family, category, variants";
  if (sku) {
    const { data } = await ctx.sb.from("products").select(cols).eq("sku", sku).maybeSingle();
    if (data) return data as ResolvedProduct;
    return { sku, name: null, family, category, variants: null };
  }
  if (family) {
    const { data } = await ctx.sb.from("products").select(cols).eq("family", family).limit(1).maybeSingle();
    if (data) return data as ResolvedProduct;
    return { sku: null, name: null, family, category, variants: null };
  }
  if (category) {
    const { data } = await ctx.sb.from("products").select(cols).eq("category", category).limit(1).maybeSingle();
    if (data) return data as ResolvedProduct;
    return { sku: null, name: null, family: null, category, variants: null };
  }
  return null;
}

interface HeadPhotometrics {
  lumens?: number;
  watts?: number;
  ies?: IESParseResult;
}

/** Fetch precomputed lumens/watts (product_photometrics/ies_metrics) and — when
 *  the IES is a directly fetchable .ies url — parse it for the candela grid the
 *  solver needs. Bounded: a single representative optic, a short fetch timeout,
 *  and a size cap; any failure falls back to the lumen-method degrade path. */
async function getHeadPhotometrics(ctx: ToolContext, sku: string | null): Promise<HeadPhotometrics> {
  if (!sku) return {};
  const { data } = await ctx.sb
    .from("product_photometrics")
    .select("ies_url, is_representative, ies_metrics(metrics)")
    .eq("product_sku", sku);
  const rows = (data ?? []) as unknown as {
    ies_url: string | null;
    is_representative: boolean | null;
    ies_metrics: { metrics: Record<string, unknown> | null } | null;
  }[];
  const usable = rows.filter((r) => r.ies_metrics?.metrics);
  if (!usable.length) return {};
  const repr = usable.find((r) => r.is_representative) ?? usable[0]!;
  const metrics = repr.ies_metrics!.metrics as Record<string, unknown>;
  const out: HeadPhotometrics = {
    lumens: num(metrics.lumens) ?? undefined,
    watts: num(metrics.inputWatts) ?? undefined,
  };

  // Only fetch+parse a plain, directly addressable .ies url (skip zip refs).
  const url = repr.ies_url;
  if (url && /^https?:\/\//i.test(url) && !url.includes("#") && /\.ies($|\?)/i.test(url)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const text = await res.text();
        if (text.length < 2_000_000) {
          out.ies = parseIES(text, sku);
        }
      }
    } catch {
      // fetch/parse failure → degrade to lumen-method (out.ies stays undefined)
    }
  }
  return out;
}

/** Map space + target → EstimatorInputs (canonical metres, fc). */
function toEstimatorInputs(
  space: { lengthFt: number; widthFt: number; mountingHeightFt: number },
  target: { taskKey: string | null; targetFc: number | null },
): EstimatorInputs {
  const task = target.taskKey ? findTask(target.taskKey) : undefined;
  const targetFc = target.targetFc ?? task?.fc ?? 30;
  return {
    mounting: "ceiling",
    aim: "down",
    target: { kind: "horizontal", heightAboveFloor: 0.76 }, // 30" working plane
    roomLength: space.lengthFt * M_PER_FT,
    roomWidth: space.widthFt * M_PER_FT,
    ceilingHeight: space.mountingHeightFt * M_PER_FT,
    reflectances: { ceiling: 0.8, wall: 0.5, floor: 0.2 },
    targetFc,
    taskKey: target.taskKey ?? (task ? task.key : "office-general"),
    llf: 0.85,
    unit: "fc",
    system: "imperial",
  };
}

/** DB row → TrackSystem. */
function toTrackSystem(sysRow: Record<string, unknown>, compRows: Record<string, unknown>[]): TrackSystem {
  const components: TrackComponent[] = compRows.map((c) => ({
    role: String(c.role) as TrackComponentRole,
    sku: String(c.sku),
    description: str(c.description) ?? undefined,
    segmentLengthFt: num(c.segment_length_ft) ?? undefined,
    headWatts: num(c.head_watts) ?? undefined,
    capacityW: num(c.capacity_w) ?? undefined,
  }));
  return {
    key: String(sysRow.key),
    label: String(sysRow.label),
    trackType: String(sysRow.track_type),
    voltageClass: sysRow.voltage_class === "low" ? "low" : "line",
    segmentLengthsFt: Array.isArray(sysRow.segment_lengths_ft) ? (sysRow.segment_lengths_ft as unknown[]).map(Number) : [],
    circuitVa: num(sysRow.circuit_va) ?? undefined,
    feedCapacityW: num(sysRow.feed_capacity_w) ?? undefined,
    maxHeadsPerRun: num(sysRow.max_heads_per_run) ?? undefined,
    defaultHeadSpacingFt: num(sysRow.default_head_spacing_ft) ?? undefined,
    compatibleHeadTrackTypes: Array.isArray(sysRow.compatible_head_track_types)
      ? (sysRow.compatible_head_track_types as unknown[]).map(String)
      : [],
    components,
  };
}

/** Best-effort match a seeded track system to the head's family/category text.
 *  Returns null when the tables are empty or nothing matches (the tool then
 *  degrades to a generic parts list). */
async function resolveTrackSystem(ctx: ToolContext, product: ResolvedProduct): Promise<TrackSystem | null> {
  const { data: systems } = await ctx.sb.from("track_systems").select("*");
  const sysRows = (systems ?? []) as Record<string, unknown>[];
  if (!sysRows.length) return null;
  const hay = `${product.family ?? ""} ${product.category ?? ""}`.toLowerCase();
  const match = sysRows.find((s) => {
    const key = String(s.key).toLowerCase();
    const label = String(s.label).toLowerCase();
    const type = String(s.track_type).toLowerCase();
    return (key && hay.includes(key)) || (label && hay.includes(label)) || (type && hay.includes(`${type} track`));
  });
  if (!match) return null;
  const { data: comps } = await ctx.sb.from("track_components").select("*").eq("system_key", match.key);
  return toTrackSystem(match, (comps ?? []) as Record<string, unknown>[]);
}

/** Downsample a fc heatmap grid to at most maxN×maxN cells (block average). */
export function downsampleHeatmap(
  values: number[][],
  maxN = 16,
): { cols: number; rows: number; values: number[][]; min: number; max: number } | undefined {
  const rows = values.length;
  if (!rows) return undefined;
  const cols = values[0]?.length ?? 0;
  if (!cols) return undefined;
  const outRows = Math.min(maxN, rows);
  const outCols = Math.min(maxN, cols);
  const out: number[][] = [];
  let min = Infinity;
  let max = -Infinity;
  for (let r = 0; r < outRows; r++) {
    const row: number[] = [];
    const sr = Math.floor((r * rows) / outRows);
    const er = Math.max(sr + 1, Math.floor(((r + 1) * rows) / outRows));
    for (let c = 0; c < outCols; c++) {
      const sc = Math.floor((c * cols) / outCols);
      const ec = Math.max(sc + 1, Math.floor(((c + 1) * cols) / outCols));
      let sum = 0;
      let n = 0;
      for (let i = sr; i < er; i++) {
        for (let j = sc; j < ec; j++) {
          const v = values[i]?.[j];
          if (typeof v === "number" && Number.isFinite(v)) {
            sum += v;
            n++;
          }
        }
      }
      const avg = n ? sum / n : 0;
      row.push(avg);
      if (avg < min) min = avg;
      if (avg > max) max = avg;
    }
    out.push(row);
  }
  return { cols: outCols, rows: outRows, values: out, min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max };
}

/** Build the normalized (0..1) plan from an estimator result. Heads are the
 *  fixture centres; runs are the rows of heads (constant y) drawn as rails. */
function buildPlan(est: EstimatorResult, roomWidthM: number, roomLengthM: number): LayoutCard["plan"] {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const heads = est.fixtures.map((f: PlacedFixture) => ({
    x: clamp(f.x / roomWidthM),
    y: clamp(f.y / roomLengthM),
  }));
  // Group heads into runs by their (rounded) normalized y.
  const byRow = new Map<string, { x1: number; x2: number; y: number }>();
  for (const h of heads) {
    const key = h.y.toFixed(3);
    const cur = byRow.get(key);
    if (cur) {
      cur.x1 = Math.min(cur.x1, h.x);
      cur.x2 = Math.max(cur.x2, h.x);
    } else {
      byRow.set(key, { x1: h.x, x2: h.x, y: h.y });
    }
  }
  const runs = [...byRow.values()].map((r) => ({ x1: r.x1, y1: r.y, x2: r.x2, y2: r.y }));
  const heatmap = downsampleHeatmap(est.grid.values, 16);
  return { runs, heads, heatmap };
}

function fmt(n: number, dp = 1): string {
  return Number.isFinite(n) ? n.toFixed(dp) : "n/a";
}

// --- main -------------------------------------------------------------------

export async function planLayout(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutput> {
  const spaceIn = (input.space ?? {}) as Record<string, unknown>;
  const productIn = (input.product ?? {}) as Record<string, unknown>;
  const targetIn = (input.target ?? {}) as Record<string, unknown>;

  const lengthFt = num(spaceIn.length_ft);
  const widthFt = num(spaceIn.width_ft);
  if (!lengthFt || !widthFt || lengthFt <= 0 || widthFt <= 0) {
    return { content: "plan_layout: space.length_ft and space.width_ft (positive numbers) are required.", cards: [], citations: [] };
  }
  const space = { lengthFt, widthFt, mountingHeightFt: numOr(spaceIn.mounting_height_ft, 9) };

  const resolved = await resolveProduct(ctx, productIn);
  if (!resolved) {
    return { content: "plan_layout: provide a product sku, family, or category to lay out.", cards: [], citations: [] };
  }

  const target = { taskKey: str(targetIn.task_key), targetFc: num(targetIn.target_fc) };
  const inputs = toEstimatorInputs(space, target);
  const layoutKind = classifyLayoutKind(resolved.family, resolved.category);

  const photo = await getHeadPhotometrics(ctx, resolved.sku);
  const headWattsOverride = photo.watts ?? parseWatts(resolved.variants);

  const productCard = {
    sku: resolved.sku,
    name: resolved.name,
    family: resolved.family,
  };
  const citations = [] as ToolOutput["citations"];

  // ── TRACK: solve a full bill of materials ─────────────────
  if (layoutKind === "track") {
    let system: TrackSystem | null = null;
    try {
      system = await resolveTrackSystem(ctx, resolved);
    } catch {
      system = null;
    }
    // Head track type hint (best-effort) from the product family/category.
    const headTrackType = detectTrackType(resolved.family, resolved.category);

    let result;
    try {
      result = solveTrackBom(photo.ies ?? null, inputs, system, {
        headWattsOverride,
        lumensPerHead: photo.lumens,
        headTrackType,
        gridN: 17,
        maxIter: 60,
      });
    } catch {
      // Time/other guard: fall back to the no-IES (BOM-without-heatmap) path.
      result = solveTrackBom(null, inputs, system, { headWattsOverride, lumensPerHead: photo.lumens, headTrackType });
    }

    const card: LayoutCard = {
      kind: "layout",
      space,
      product: productCard,
      layoutKind: "track",
      summary: {
        headCount: result.summary.headCount,
        runs: result.summary.runs,
        headsPerRun: result.summary.headsPerRun,
        headSpacingFt: result.summary.headSpacingFt,
        totalTrackFt: result.summary.totalTrackFt,
        transformerCount: result.summary.transformerCount,
        circuits: result.summary.circuits,
        avgFc: result.summary.avgFc,
        uniformity: result.summary.uniformity,
        totalWatts: result.summary.totalWatts,
      },
      bom: { lines: result.bom.lines as LayoutBomLine[] },
      plan: result.estimator ? buildPlan(result.estimator, inputs.roomWidth, inputs.roomLength) : undefined,
      warnings: result.warnings,
    };

    const lines: string[] = [];
    lines.push(
      `Track layout estimate for ${space.lengthFt}×${space.widthFt} ft (mounting ${space.mountingHeightFt} ft) @ ${fmt(inputs.targetFc, 0)} fc target:`,
    );
    lines.push(
      `- ${result.summary.headCount} heads in ${result.summary.runs} run(s) of ${result.summary.headsPerRun} ` +
        `(~${fmt(result.summary.headSpacingFt)} ft spacing); ${fmt(result.summary.totalTrackFt)} ft of track total.`,
    );
    lines.push(
      `- Avg ${fmt(result.summary.avgFc)} fc, avg:min uniformity ${fmt(result.summary.uniformity, 2)}, ${fmt(result.summary.totalWatts)} W connected.`,
    );
    if (result.summary.circuits != null) lines.push(`- ${result.summary.circuits} line-voltage circuit(s).`);
    if (result.summary.transformerCount) lines.push(`- ${result.summary.transformerCount} transformer(s)/feed(s).`);
    lines.push("Bill of materials:");
    for (const l of result.bom.lines) {
      lines.push(`  · ${l.qty}× ${l.sku ?? `[${l.role}]`} — ${l.description}`);
    }
    if (result.warnings.length) lines.push(`Notes: ${result.warnings.join(" ")}`);
    lines.push("This is an estimate — verify in AGi32 / Ventrix; hand off the full track config to the Ventrix configurator.");

    return { content: lines.join("\n"), cards: [card], citations };
  }

  // ── LINEAR (tape / strip): totals + run sizing ────────────
  if (layoutKind === "linear") {
    if (!photo.ies) {
      return {
        content:
          `${resolved.name ?? resolved.sku ?? "This product"} looks like a linear/tape product, but I don't have its IES ` +
          `photometrics on file to size a run for a ${space.lengthFt}×${space.widthFt} ft space. Give me a target run length, ` +
          `or ask about a specific SKU with photometrics.`,
        cards: [],
        citations,
      };
    }
    const longerFt = Math.max(space.lengthFt, space.widthFt);
    const linInputs: LinearEstimatorInputs = {
      runLengthM: longerFt * M_PER_FT,
      llf: 0.85,
      unit: "fc",
      system: "imperial",
      application: "free-form",
      roomLengthM: space.lengthFt * M_PER_FT,
      roomWidthM: space.widthFt * M_PER_FT,
      ceilingHeightM: space.mountingHeightFt * M_PER_FT,
      runWall: "south",
      runStartM: 0,
    };
    const lin = solveLinearLayout(photo.ies, linInputs);
    const card: LayoutCard = {
      kind: "layout",
      space,
      product: productCard,
      layoutKind: "linear",
      summary: {
        headCount: 0,
        avgFc: 0,
        uniformity: 0,
        totalWatts: lin.totalWatts,
      },
      bom: {
        lines: [
          { sku: resolved.sku, description: `${fmt(lin.buildableLengthM / M_PER_FT)} ft of tape/strip`, qty: 1, role: "channel" },
          { sku: null, description: "Driver / power supply", qty: lin.driverCount, role: "transformer" },
        ],
      },
      warnings: lin.driverOverloaded ? ["A single run exceeds one driver — split into driver-sized segments."] : [],
    };
    const content =
      `Linear layout estimate: a ~${fmt(longerFt)} ft run of ${resolved.name ?? resolved.sku} → ` +
      `${fmt(lin.buildableLengthM / M_PER_FT)} ft buildable (${fmt(lin.totalLumens, 0)} lm, ${fmt(lin.totalWatts)} W), ` +
      `${lin.driverCount} driver(s). Estimate — verify in AGi32 / Ventrix.`;
    return { content, cards: [card], citations };
  }

  // ── AREA-GRID (downlights / troffers): single-product grid ─
  if (!photo.ies) {
    return {
      content:
        `I can lay out ${resolved.name ?? resolved.sku ?? "that fixture"} in a ${space.lengthFt}×${space.widthFt} ft space, but I need its ` +
        `IES photometrics to compute the count and footcandles, and they aren't on file yet. Ask about a SKU whose photometrics are indexed, ` +
        `or I can pull recommended light levels for the space with lighting_requirement.`,
      cards: [],
      citations,
    };
  }
  const est = solveLayout(photo.ies, inputs, { wattage: headWattsOverride });
  const card: LayoutCard = {
    kind: "layout",
    space,
    product: productCard,
    layoutKind: "area-grid",
    summary: {
      headCount: est.count,
      runs: est.rows,
      headsPerRun: est.cols,
      avgFc: est.actualFc,
      uniformity: est.uniformity,
      totalWatts: est.totalWatts,
    },
    bom: {
      lines: [{ sku: resolved.sku, description: resolved.name ?? "Fixture", qty: est.count, role: "head" }],
    },
    plan: buildPlan(est, inputs.roomWidth, inputs.roomLength),
    warnings: [
      ...(est.unreachable ? ["This fixture can't reach the target in this room even at the max layout."] : []),
      ...(est.wattsUnknown ? ["Wattage unknown — connected watts not shown."] : []),
    ],
  };
  const content =
    `Layout estimate for ${space.lengthFt}×${space.widthFt} ft @ ${fmt(inputs.targetFc, 0)} fc: ` +
    `${est.count} × ${resolved.name ?? resolved.sku} in a ${est.cols}×${est.rows} grid → avg ${fmt(est.actualFc)} fc, ` +
    `avg:min ${fmt(est.uniformity, 2)}, ${fmt(est.totalWatts)} W. Estimate — verify in AGi32 / Ventrix.`;
  return { content, cards: [card], citations };
}

/** Detect a head's physical track type from its family/category text
 *  (H / J / J2 / L / W / X / FLEXRAIL). Best-effort; undefined when unclear. */
function detectTrackType(family: string | null, category: string | null): string | undefined {
  const hay = `${family ?? ""} ${category ?? ""}`.toLowerCase();
  if (hay.includes("flexrail")) return "FLEXRAIL";
  const m = hay.match(/\b([hjlwx]|j2)[- ]?track\b/);
  if (m) return m[1]!.toUpperCase();
  return undefined;
}

export async function layoutDispatch(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolOutput> {
  switch (name) {
    case "plan_layout":
      return planLayout(ctx, input);
    default:
      return { content: `Unknown layout tool: ${name}`, cards: [], citations: [] };
  }
}
