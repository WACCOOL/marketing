// =============================================================================
// Thom photometrics tools — precomputed IES metrics + lighting-requirement
// lookups. Split out of tools.ts (mirroring hubspotTools.ts) and composed onto
// the tool set by agent.ts only when THOM_PHOTOMETRICS === "1" (dark-launch).
//
//  - get_photometrics: reads product_photometrics + ies_metrics for a SKU. NO
//    live compute — if a SKU hasn't been precomputed by apps/photometrics-sync,
//    it says so gracefully.
//  - lighting_requirement: a PURE lookup over the ported IESNA/ASHRAE reference
//    tables in @wac/shared (recommended fc / uniformity / LPD by space/task).
// =============================================================================

import {
  DEFAULT_UNIFORMITY_RATIO,
  ESTIMATOR_TASKS,
  findTask,
  mToFt,
  tasksForTarget,
  type EstimatorTask,
} from "../index.js";
import type { ClaudeTool } from "./transport.js";
import type { PhotometricsCard, ToolContext, ToolOutput } from "./types.js";

export const PHOTOMETRICS_TOOLS: ClaudeTool[] = [
  {
    name: "get_photometrics",
    description:
      "Precomputed IES photometrics for a specific product SKU: beam & field angles, max candela, coverage (beam/field diameter + center footcandles at typical mounting heights), spacing criterion (S/MH), zonal lumens, delivered lumens & efficacy, and — for multi-plane fixtures — BUG rating and UGR. Use this whenever a KNOWN SKU's beam/field angle, footcandles-on-a-surface / coverage, spacing, glare (UGR), BUG, or efficacy is asked — never estimate those from memory when you have the SKU.",
    input_schema: {
      type: "object",
      properties: {
        sku: { type: "string", description: "The product SKU / PPID to look up photometrics for." },
        mounting_height_ft: {
          type: "number",
          description: "Optional mounting height (feet) to highlight in the cone-of-light coverage table.",
        },
      },
      required: ["sku"],
    },
  },
  {
    name: "lighting_requirement",
    description:
      "Recommended lighting design targets for a space or task — maintained illuminance (footcandles), avg/min uniformity ratio, and ASHRAE 90.1 lighting-power-density allowance (W/ft²) — from the IESNA/ASHRAE reference tables. Use this for 'how many footcandles for an office / classroom / retail / pathway', recommended uniformity, or LPD questions. Cite each value to its own source exactly as returned (illuminance and uniformity per the IES document; LPD per ASHRAE 90.1-2019), as an end-of-answer footnote.",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "A task key (e.g. 'office-general', 'classroom', 'outdoor-pathway') when known." },
        query: { type: "string", description: "Free-text space/task description to match, e.g. 'office reading', 'museum wall wash'." },
        environment: { type: "string", enum: ["indoor", "outdoor"], description: "Optional filter." },
        target: { type: "string", enum: ["horizontal", "vertical"], description: "Optional surface orientation filter (working plane vs wall/accent)." },
      },
    },
  },
];

// --- get_photometrics -------------------------------------------------------

interface MetricRow {
  ies_url: string | null;
  is_representative: boolean | null;
  match_confidence: number | null;
  ies_metrics: {
    inner_filename: string | null;
    metrics: Record<string, unknown> | null;
    warnings: unknown;
  } | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fmtDeg(v: unknown): string {
  const n = num(v);
  return n == null ? "n/a" : `${n.toFixed(1)}°`;
}

function fmt1(v: unknown): string {
  const n = num(v);
  return n == null ? "n/a" : n.toFixed(1);
}

function fmt0(v: unknown): string {
  const n = num(v);
  return n == null ? "n/a" : Math.round(n).toString();
}

/** Metres → feet, 1dp (for cone diameters). */
function mToFtStr(v: unknown): string {
  const n = num(v);
  return n == null ? "n/a" : `${mToFt(n).toFixed(1)} ft`;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Render one metric bundle into a compact readable block for Claude. */
function formatMetrics(m: Record<string, unknown>): string {
  const beam = obj(m.beam);
  const sc = obj(m.spacingCriterion);
  const zonal = obj(m.zonal);
  const bug = m.bug == null ? null : obj(m.bug);
  const ugr = m.ugr == null ? null : obj(m.ugr);
  const cone = Array.isArray(m.cone) ? (m.cone as Record<string, unknown>[]) : [];

  const lines: string[] = [];
  lines.push(
    `Format ${String(m.format ?? "?")}, Type ${String(m.photometricType ?? "?")}; ` +
      `${fmt0(m.lumens)} lm @ ${fmt1(m.inputWatts)} W → ${fmt1(m.efficacy)} lm/W.`,
  );
  lines.push(
    `Beam angle ${fmtDeg(beam.beamAngle)} (C0 ${fmtDeg(beam.beamC0)} / C90 ${fmtDeg(beam.beamC90)}); ` +
      `field angle ${fmtDeg(beam.fieldAngle)} (C0 ${fmtDeg(beam.fieldC0)} / C90 ${fmtDeg(beam.fieldC90)}).`,
  );
  lines.push(`Max candela ${fmt0(m.maxCandela)} cd at ${fmtDeg(m.maxAngle)} from nadir.`);
  lines.push(
    `Spacing criterion (S/MH) avg ${fmt1(sc.average)} (plane0 ${fmt1(sc.plane0)} / plane90 ${fmt1(sc.plane90)}).`,
  );
  lines.push(
    `Zonal lumens: total ${fmt0(zonal.total)} (down ${fmt0(zonal.downward)} / up ${fmt0(zonal.upward)}).`,
  );
  lines.push(bug ? `BUG rating: ${String(bug.rating ?? "?")}.` : "BUG: not applicable (single-plane / non-Type-C).");
  lines.push(ugr ? `UGR (reference room): ${fmt1(ugr.value)}.` : "UGR: not applicable (single-plane / non-Type-C).");
  if (cone.length) {
    const rows = cone
      .map(
        (c) =>
          `  ${fmt0(c.mountingHeightFt)} ft → beam Ø ${mToFtStr(c.beamDiaM)}, field Ø ${mToFtStr(c.fieldDiaM)}, ` +
          `center ${fmt1(c.centerFc)} fc`,
      )
      .join("\n");
    lines.push(`Coverage (cone of light):\n${rows}`);
  }
  return lines.join("\n");
}

/** Parse-warning caveats worth surfacing (Type A/B, symmetric ⇒ BUG/UGR off). */
function caveats(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return [];
  const out: string[] = [];
  for (const w of warnings as { code?: string; message?: string; severity?: string }[]) {
    if (!w || typeof w.message !== "string") continue;
    if (["I_PHOT_TYPE_NON_C", "I_SYMMETRIC", "W_LUMINOUS_SHAPE", "W_LUMENS_ABSOLUTE"].includes(w.code ?? "")) {
      out.push(w.message);
    }
  }
  return out;
}

async function getPhotometrics(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutput> {
  const sku = String(input.sku ?? "").trim();
  if (!sku) return { content: "get_photometrics: sku is required.", cards: [], citations: [] };

  const { data, error } = await ctx.sb
    .from("product_photometrics")
    .select("ies_url, is_representative, match_confidence, ies_metrics(inner_filename, metrics, warnings)")
    .eq("product_sku", sku);
  if (error) return { content: `get_photometrics error: ${error.message}`, cards: [], citations: [] };

  const rows = (data ?? []) as unknown as MetricRow[];
  const usable = rows.filter((r) => r.ies_metrics?.metrics);
  if (!usable.length) {
    return {
      content: `Photometrics for ${sku} haven't been computed yet (no IES metrics on file). They may not be indexed, or the product has no IES file.`,
      cards: [],
      citations: [],
    };
  }

  // Representative first, then the other optics.
  const repr = usable.find((r) => r.is_representative) ?? usable[0]!;
  const others = usable.filter((r) => r !== repr);

  const reprMetrics = repr.ies_metrics!.metrics as Record<string, unknown>;
  const reprFile = repr.ies_metrics!.inner_filename ?? null;

  const parts: string[] = [];
  parts.push(`Photometrics for ${sku}${reprFile ? ` (representative distribution: ${reprFile})` : ""}:`);
  parts.push(formatMetrics(reprMetrics));

  const cav = caveats(repr.ies_metrics!.warnings);
  if (cav.length) parts.push(`Caveats: ${cav.join(" ")}`);

  if (others.length) {
    const list = others
      .map((r) => `- ${r.ies_metrics?.inner_filename ?? "(unnamed optic)"}`)
      .join("\n");
    parts.push(
      `Other optics/distributions on file for ${sku} (ask to compare a specific one):\n${list}`,
    );
  }

  const card: PhotometricsCard = {
    kind: "photometrics",
    sku,
    source_filename: reprFile,
    metrics: reprMetrics,
  };

  return { content: parts.join("\n\n"), cards: [card], citations: [] };
}

// --- lighting_requirement (pure) --------------------------------------------

function formatTask(t: EstimatorTask): string {
  const uni = t.uniformityRatio ?? DEFAULT_UNIFORMITY_RATIO;
  const bits = [
    `${t.label}: ${t.fc} fc maintained`,
    `avg/min uniformity ≤ ${uni}:1`,
  ];
  if (t.lpdWFt2 != null) bits.push(`LPD allowance ${t.lpdWFt2} W/ft²`);
  // Per-value attribution (Davis 2026-07-21): illuminance/uniformity come from
  // the IES recommended practice; the LPD allowance comes from ASHRAE 90.1.
  // Kept as one trailing "sources:" clause so the model can lift it into its
  // end-of-answer Sources footnote.
  bits.push(
    `sources: illuminance and uniformity per ${t.source ?? "IESNA recommended practice"}` +
      (t.lpdWFt2 != null ? "; LPD allowance per ASHRAE 90.1-2019" : ""),
  );
  return `- ${bits.join("; ")}.`;
}

/** Free-text match over the task table: token overlap on label + key. */
function searchTasks(query: string): EstimatorTask[] {
  const q = query.toLowerCase();
  const terms = q.split(/[^a-z0-9]+/).filter(Boolean);
  if (!terms.length) return [];
  const scored = ESTIMATOR_TASKS.map((t) => {
    const hay = `${t.key} ${t.label}`.toLowerCase();
    let score = 0;
    for (const term of terms) if (hay.includes(term)) score++;
    return { t, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((x) => x.t);
}

function lightingRequirement(input: Record<string, unknown>): ToolOutput {
  const taskKey = typeof input.task === "string" ? input.task.trim() : "";
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const environment =
    input.environment === "outdoor" || input.environment === "indoor" ? input.environment : undefined;
  const target = input.target === "vertical" || input.target === "horizontal" ? input.target : undefined;

  // 1. Exact task key wins.
  if (taskKey) {
    const t = findTask(taskKey);
    if (t) {
      return { content: `Recommended lighting for this space/task:\n${formatTask(t)}`, cards: [], citations: [] };
    }
  }

  // 2. Otherwise, candidate set = target/environment filter and/or free-text.
  let candidates: EstimatorTask[] = [];
  if (target) {
    candidates = tasksForTarget(target, environment ?? "indoor");
  } else {
    candidates = [...ESTIMATOR_TASKS];
    if (environment) candidates = candidates.filter((t) => (t.environment ?? "indoor") === environment);
  }
  if (query) {
    const matched = searchTasks(query);
    const allow = new Set(candidates.map((t) => t.key));
    const narrowed = matched.filter((t) => allow.has(t.key));
    candidates = narrowed.length ? narrowed : matched;
  }

  if (!candidates.length) {
    const keys = ESTIMATOR_TASKS.map((t) => t.key).join(", ");
    return {
      content: `No matching lighting-requirement preset. Available task keys: ${keys}.`,
      cards: [],
      citations: [],
    };
  }

  const shown = candidates.slice(0, 6);
  return {
    content:
      `Recommended lighting targets (IESNA/ASHRAE reference):\n` +
      shown.map(formatTask).join("\n"),
    cards: [],
    citations: [],
  };
}

export async function photometricsDispatch(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutput> {
  switch (name) {
    case "get_photometrics":
      return getPhotometrics(ctx, input);
    case "lighting_requirement":
      return lightingRequirement(input);
    default:
      return { content: `Unknown photometrics tool: ${name}`, cards: [], citations: [] };
  }
}
