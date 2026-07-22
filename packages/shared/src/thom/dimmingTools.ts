// =============================================================================
// Dimming-compatibility tools (plan §D) — forward (check_dimmer_compatibility)
// and reverse (find_products_for_dimmer), composed behind THOM_DIMMING on BOTH
// surfaces (spec-rank dark-launch idiom; agent.ts composes, tools.ts routes).
//
// BOTH tools filter dimming_reports.status = 'active' EXPLICITLY (DC14): the
// tables are open-read under RLS, so needs_review/superseded rows are readable
// by anon — "rows stay inactive" is only true because these queries say so
// (only the report carries status).
// =============================================================================

import type { ClaudeTool } from "./transport.js";
import type { Citation, ToolContext, ToolOutput } from "./types.js";
import {
  dimmerModelPart,
  normalizeDimmerModel,
  phaseTypeLabel,
  rankDimmerMatches,
  skuMatchesLikes,
  statusLabel,
  type DimmingModeQualifier,
  type DimmingPhaseType,
  type DimmingRowStatus,
} from "./dimming.js";

/** Cap on rendered dimmer rows per answer (MAX_ACCESSORY_LINES idiom). */
export const MAX_DIMMING_LINES = 30;
/** Cap on families enumerated in a reverse answer. */
export const MAX_DIMMING_FAMILIES = 10;

/** Tool names — also the agent-side marker for the DC3 competitor-screen
 *  carve-out (a turn that called a dimming tool is never nuked by the
 *  web-search competitor screen; chart manufacturers are tested references). */
export const DIMMING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "check_dimmer_compatibility",
  "find_products_for_dimmer",
]);

/** The chart's own caveat, carried on every answer (plan §D.1/§E). */
export const DIMMING_CHART_CAVEAT =
  "Results reflect a single-fixture test; fixture count per dimmer is governed by the dimmer manufacturer's load rating.";

/** Honest coverage caveat, verbatim in reverse-tool results (plan §D.2). */
export const DIMMING_COVERAGE_CAVEAT =
  "Coverage note: only about 17% of the catalog has a tested dimming chart; absence from these charts never means a product is not compatible.";

/** The honest-miss line (plan §E). */
export const DIMMING_HONEST_MISS =
  "That pairing is not in WAC Group's tested dimming charts; check the product's spec sheet or confirm with your WAC Group rep. Absence of a chart row is never a statement of incompatibility.";

export const DIMMING_TOOLS: ClaudeTool[] = [
  {
    name: "check_dimmer_compatibility",
    description:
      "WAC Group's TESTED dimming-compatibility charts for a product: which dimmers were bench-tested with it, the measured low-end %, phase type (adaptive / reverse-phase ELV / forward-phase TRIAC / 0-10V), per-row ELV/TRIAC mode qualifier, and any 'Not Recommended' or issue note verbatim. Pass the product SKU/PPID (variant SKUs resolve to their parent), and optionally a specific dimmer model (e.g. 'Lutron DVCL-153P') to check one pairing. This is the PRIMARY source for dimmer compatibility questions — never answer them from memory or from spec-sheet text chunks.",
    input_schema: {
      type: "object",
      properties: {
        product: { type: "string", description: "Product SKU / PPID (or a variant SKU)." },
        dimmer: {
          type: "string",
          description: "Optional dimmer to check, e.g. 'Lutron DVCL-153P' or 'DVELV-300P'.",
        },
      },
      required: ["product"],
    },
  },
  {
    name: "find_products_for_dimmer",
    description:
      "Reverse dimming lookup: which WAC Group products have a TESTED dimming chart covering a given dimmer model (e.g. 'Lutron DVCL-153P'). Returns matches grouped by product family with phase type, mode qualifier, tested status, and measured low-end %. Coverage is partial — absence never means incompatible.",
    input_schema: {
      type: "object",
      properties: {
        dimmer: { type: "string", description: "The dimmer model, optionally with manufacturer." },
        status: {
          type: "string",
          enum: ["any", "tested_compatible"],
          description: "Filter to rows tested compatible only (default any).",
        },
      },
      required: ["dimmer"],
    },
  },
];

// -----------------------------------------------------------------------------
// Row/report shapes as the tools read them (open-read tables).
// -----------------------------------------------------------------------------

export interface DimmingReportRecord {
  id: string;
  kb_document_id: string | null;
  source_url: string | null;
  report_code: string | null;
  report_code_derived: boolean;
  product_family: string | null;
  skus_tested: string[];
  related_model_patterns: string[];
  related_model_likes: string[];
  test_voltage_range: string | null;
  test_notes: string | null;
  status: string;
}

export interface DimmingCompatRecord {
  report_id: string;
  manufacturer: string;
  dimmer_series: string | null;
  dimmer_model: string;
  mode_qualifier: DimmingModeQualifier | null;
  dimmer_model_norm: string;
  related_dimmer_models: string[];
  related_dimmer_models_norm: string[];
  phase_type: DimmingPhaseType;
  test_voltage: string | null;
  low_end_pct: number | string | null;
  status: DimmingRowStatus;
  comments: string;
}

const REPORT_COLS =
  "id, kb_document_id, source_url, report_code, report_code_derived, product_family, " +
  "skus_tested, related_model_patterns, related_model_likes, test_voltage_range, test_notes, status";

const ROW_COLS =
  "report_id, manufacturer, dimmer_series, dimmer_model, mode_qualifier, dimmer_model_norm, " +
  "related_dimmer_models, related_dimmer_models_norm, phase_type, test_voltage, low_end_pct, status, comments";

// -----------------------------------------------------------------------------
// Pure formatting (exported for tests).
// -----------------------------------------------------------------------------

function lowEnd(v: number | string | null): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Cite a chart: its own code, or the filename-derived id flagged as such
 *  (DC9 — never present a derived id as the chart's printed code). */
export function reportCitation(r: Pick<DimmingReportRecord, "report_code" | "report_code_derived">): string {
  if (!r.report_code) return "WAC Group dimming chart";
  return r.report_code_derived
    ? `WAC Group dimming chart (ID ${r.report_code}, from the chart filename)`
    : `WAC Group dimming chart ${r.report_code}`;
}

/** The scope header EVERY answer carries (DC4 — scope errors must be visible):
 *  the chart's own product_family + skus_tested. */
export function reportScopeLine(r: DimmingReportRecord): string {
  const tested = r.skus_tested.length ? r.skus_tested.join(", ") : "not stated";
  const fam = r.product_family ?? "unnamed family";
  return `${reportCitation(r)} for ${fam} (SKU tested: ${tested})`;
}

/** One chart row as an answer line: phase type AND mode qualifier (DC2 — the
 *  same physical dimmer can be tested compatible as (ELV) and Not Recommended
 *  as (TRIAC) inside the same Adaptive section), measured low end, verbatim
 *  comment. `closestOf` labels a non-exact fuzzy hit (DC10). */
export function formatCompatLine(row: DimmingCompatRecord, closest = false): string {
  const who = [row.manufacturer, row.dimmer_series, row.dimmer_model].filter(Boolean).join(" ");
  const phase =
    phaseTypeLabel(row.phase_type) +
    (row.mode_qualifier ? `, used in ${row.mode_qualifier.toUpperCase()} mode` : "");
  const volts = row.test_voltage ? ` at ${row.test_voltage}V` : "";
  const le = lowEnd(row.low_end_pct);
  const measured = le !== null ? `, measured low end ${le}%` : "";
  const note = row.comments.trim() ? ` Chart comment: "${row.comments.trim()}"` : "";
  const label = closest ? " [closest tested model, not an exact match]" : "";
  return `- ${who}${label} (${phase}${volts}): ${statusLabel(row.status)}${measured}.${note}`;
}

/** Per-phase counts line for a report summary. */
export function phaseCountsLine(rows: readonly DimmingCompatRecord[]): string {
  const counts = new Map<DimmingPhaseType, number>();
  for (const r of rows) counts.set(r.phase_type, (counts.get(r.phase_type) ?? 0) + 1);
  const parts = [...counts.entries()].map(([p, n]) => `${phaseTypeLabel(p)}: ${n}`);
  return `Dimmers tested by phase type: ${parts.join("; ")}.`;
}

/** Cap a set of lines at MAX_DIMMING_LINES with a "+N more" tail. */
export function capLines(lines: readonly string[], cap = MAX_DIMMING_LINES): string[] {
  if (lines.length <= cap) return [...lines];
  return [...lines.slice(0, cap), `(+${lines.length - cap} more)`];
}

/** The family-level answer when a product references a chart file but no unit
 *  scopes it (DC4 — NEVER pick an arbitrary unit). */
export function familyLevelAnswer(product: string, reports: readonly DimmingReportRecord[]): string {
  const lines = reports.map((r) => {
    const tested = r.skus_tested.length ? r.skus_tested.join(", ") : "not stated";
    return `- ${r.product_family ?? "unnamed"} (SKU tested: ${tested}${r.related_model_patterns.length ? `; covers ${r.related_model_patterns.join(", ")}` : ""})`;
  });
  return (
    `No tested chart unit matches ${product} exactly, but WAC Group's tested dimming charts for this family cover these sizes/wattages:\n` +
    capLines(lines).join("\n") +
    `\nName the exact size/wattage (or its SKU) to get that unit's tested dimmer list. Never assume one unit's results apply to another size.`
  );
}

function reportCitations(reports: readonly DimmingReportRecord[]): Citation[] {
  return reports
    .filter((r) => r.source_url)
    .map((r) => ({
      document_id: r.kb_document_id ?? r.id,
      title: reportCitation(r),
      doc_type: "dimming_report",
      page: null,
      url: r.source_url,
    }));
}

const out = (content: string, citations: Citation[] = []): ToolOutput => ({
  content,
  cards: [],
  citations,
});

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

// -----------------------------------------------------------------------------
// Forward: check_dimmer_compatibility
// -----------------------------------------------------------------------------

interface ProductHit {
  sku: string;
  name: string | null;
  family: string | null;
}

async function resolveProduct(ctx: ToolContext, raw: string): Promise<ProductHit | null> {
  const { data: p } = await ctx.sb
    .from("products")
    .select("sku, name, family")
    .eq("sku", raw)
    .maybeSingle();
  if (p) return p as ProductHit;
  // Variant SKU -> parent product (variant_search carries variant SKUs).
  const { data: vhits } = await ctx.sb
    .from("products")
    .select("sku, name, family")
    .ilike("variant_search", `%${escapeLike(raw)}%`)
    .limit(1);
  const parent = (vhits ?? [])[0] as ProductHit | undefined;
  return parent ?? null;
}

/** Fetch ACTIVE reports by id set — the DC14 status filter lives here. */
async function activeReportsByIds(ctx: ToolContext, ids: string[]): Promise<DimmingReportRecord[]> {
  if (!ids.length) return [];
  const { data } = await ctx.sb
    .from("dimming_reports")
    .select(REPORT_COLS)
    .in("id", ids)
    .eq("status", "active");
  return (data ?? []) as unknown as DimmingReportRecord[];
}

async function reportsLinkedToSkus(ctx: ToolContext, skus: string[]): Promise<DimmingReportRecord[]> {
  if (!skus.length) return [];
  const { data: links } = await ctx.sb
    .from("dimming_report_products")
    .select("report_id")
    .in("product_sku", skus)
    .limit(500);
  const ids = [...new Set(((links ?? []) as { report_id: string }[]).map((l) => l.report_id))];
  return activeReportsByIds(ctx, ids);
}

async function checkDimmerCompatibility(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolOutput> {
  const productRaw = String(input.product ?? "").trim();
  if (!productRaw) return out("check_dimmer_compatibility: product is required.");
  const dimmer = typeof input.dimmer === "string" ? input.dimmer.trim() : "";

  const product = await resolveProduct(ctx, productRaw);
  const sku = product?.sku ?? productRaw;

  // (1) Direct links (written at extraction time; pattern-primary).
  let reports = await reportsLinkedToSkus(ctx, [...new Set([sku, productRaw])]);

  // (2) related_model_likes fallback: patterns matched TS-side over the active
  // report set (no pg_trgm; ~hundreds of reports).
  if (!reports.length) {
    const { data } = await ctx.sb
      .from("dimming_reports")
      .select(REPORT_COLS)
      .eq("status", "active")
      .limit(500);
    const all = (data ?? []) as unknown as DimmingReportRecord[];
    reports = all.filter(
      (r) =>
        skuMatchesLikes(sku, r.related_model_likes) ||
        r.skus_tested.some((t) => t.toUpperCase() === sku.toUpperCase()),
    );
  }

  // (3) Family-level answer: siblings of the product's family have tested
  // units, but none scopes THIS sku (DC4 — never pick an arbitrary unit).
  if (!reports.length && product?.family) {
    const { data: sibs } = await ctx.sb
      .from("products")
      .select("sku")
      .eq("family", product.family)
      .limit(200);
    const sibSkus = ((sibs ?? []) as { sku: string }[]).map((s) => s.sku).filter((s) => s !== sku);
    const famReports = await reportsLinkedToSkus(ctx, sibSkus);
    if (famReports.length) {
      return out(
        `${familyLevelAnswer(productRaw, famReports)}\n\n${DIMMING_CHART_CAVEAT}`,
        reportCitations(famReports),
      );
    }
  }

  if (!reports.length) {
    return out(
      `No tested dimming chart covers ${productRaw}. ${DIMMING_HONEST_MISS}\n${DIMMING_COVERAGE_CAVEAT}`,
    );
  }

  const reportIds = reports.map((r) => r.id);
  const { data: rowData } = await ctx.sb
    .from("dimming_compat_rows")
    .select(ROW_COLS)
    .in("report_id", reportIds)
    .limit(2000);
  const rows = (rowData ?? []) as unknown as DimmingCompatRecord[];
  const byReport = new Map<string, DimmingCompatRecord[]>();
  for (const r of rows) {
    const list = byReport.get(r.report_id) ?? [];
    list.push(r);
    byReport.set(r.report_id, list);
  }

  const sections: string[] = [];
  for (const rep of reports) {
    const repRows = byReport.get(rep.id) ?? [];
    const head = [
      reportScopeLine(rep),
      rep.test_voltage_range ? `Test voltage: ${rep.test_voltage_range}.` : null,
      rep.test_notes ? `Chart notes: ${rep.test_notes}` : null,
      rep.source_url ? `Chart PDF: ${rep.source_url}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    if (dimmer) {
      const matches = rankDimmerMatches(dimmer, repRows);
      if (!matches.length) {
        sections.push(
          `${head}\n${dimmer} is not in this chart's tested dimmer list. ${DIMMING_HONEST_MISS}`,
        );
        continue;
      }
      const lines = matches.map((m) => formatCompatLine(m.row, m.tier !== "exact" && m.tier !== "related"));
      sections.push(`${head}\n${capLines(lines).join("\n")}`);
    } else {
      const compatible = repRows.filter((r) => r.status === "tested_compatible");
      const flagged = repRows.filter((r) => r.status !== "tested_compatible");
      const parts = [head, phaseCountsLine(repRows)];
      if (compatible.length) {
        parts.push(
          `Tested compatible (${compatible.length}):`,
          ...capLines(compatible.map((r) => formatCompatLine(r))),
        );
      }
      if (flagged.length) {
        parts.push(
          `Tested with a caution (${flagged.length}):`,
          ...capLines(flagged.map((r) => formatCompatLine(r))),
        );
      }
      if (!repRows.length) parts.push("No rows extracted for this chart yet.");
      sections.push(parts.join("\n"));
    }
  }

  return out(`${sections.join("\n\n")}\n\n${DIMMING_CHART_CAVEAT}`, reportCitations(reports));
}

// -----------------------------------------------------------------------------
// Reverse: find_products_for_dimmer
// -----------------------------------------------------------------------------

async function findProductsForDimmer(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolOutput> {
  const dimmer = String(input.dimmer ?? "").trim();
  if (!dimmer) return out("find_products_for_dimmer: dimmer is required.");
  const wantStatus = input.status === "tested_compatible" ? "tested_compatible" : null;

  // Broad SQL prefilter (plan §C.4/§D.3): longest hyphen token of the
  // normalized MODEL part (a leading all-alpha word is treated as the
  // manufacturer and dropped — "Lutron DVCL-153P") as an ilike fragment, plus
  // an exact contains on the related-models arrays; ranking is pure TS.
  const norm = normalizeDimmerModel(dimmerModelPart(dimmer));
  // The LAST hyphen token is the most selective prefilter fragment ("DVCL-153P"
  // -> "153P", "C4-APD120" -> "APD120"); precision comes from the TS ranking.
  const tokens = norm.split("-").filter(Boolean);
  const frag = tokens[tokens.length - 1];
  const candidates = new Map<string, DimmingCompatRecord>();
  const keyOf = (r: DimmingCompatRecord) =>
    `${r.report_id}|${r.dimmer_model_norm}|${r.mode_qualifier ?? ""}|${r.test_voltage ?? ""}|${r.phase_type}`;
  if (frag) {
    const { data } = await ctx.sb
      .from("dimming_compat_rows")
      .select(ROW_COLS)
      .ilike("dimmer_model_norm", `%${escapeLike(frag)}%`)
      .limit(500);
    for (const r of (data ?? []) as unknown as DimmingCompatRecord[]) candidates.set(keyOf(r), r);
  }
  if (norm) {
    const { data } = await ctx.sb
      .from("dimming_compat_rows")
      .select(ROW_COLS)
      .contains("related_dimmer_models_norm", [norm])
      .limit(500);
    for (const r of (data ?? []) as unknown as DimmingCompatRecord[]) candidates.set(keyOf(r), r);
  }

  const matches = rankDimmerMatches(dimmer, [...candidates.values()]).filter(
    (m) => !wantStatus || m.row.status === wantStatus,
  );
  if (!matches.length) {
    return out(
      `${dimmer} is not in WAC Group's tested dimming charts. ${DIMMING_HONEST_MISS}\n${DIMMING_COVERAGE_CAVEAT}`,
    );
  }

  // ACTIVE reports only (DC14) — a needs_review/superseded unit's rows never
  // surface even though RLS lets anon read them.
  const reportIds = [...new Set(matches.map((m) => m.row.report_id))];
  const reports = await activeReportsByIds(ctx, reportIds);
  const reportById = new Map(reports.map((r) => [r.id, r]));
  const activeMatches = matches.filter((m) => reportById.has(m.row.report_id));
  if (!activeMatches.length) {
    return out(
      `${dimmer} is not in WAC Group's tested dimming charts. ${DIMMING_HONEST_MISS}\n${DIMMING_COVERAGE_CAVEAT}`,
    );
  }

  // Group by family (report product_family; fall back to report code).
  const byFamily = new Map<string, { reports: Set<string>; lines: string[] }>();
  for (const m of activeMatches) {
    const rep = reportById.get(m.row.report_id)!;
    const fam = rep.product_family ?? reportCitation(rep);
    let g = byFamily.get(fam);
    if (!g) {
      g = { reports: new Set(), lines: [] };
      byFamily.set(fam, g);
    }
    g.reports.add(rep.id);
    g.lines.push(formatCompatLine(m.row, m.tier !== "exact" && m.tier !== "related"));
  }

  const famEntries = [...byFamily.entries()];
  const shown = famEntries.slice(0, MAX_DIMMING_FAMILIES);
  const sections = shown.map(([fam, g]) => {
    const reps = [...g.reports].map((id) => reportById.get(id)!) ;
    const tested = [...new Set(reps.flatMap((r) => r.skus_tested))];
    const patterns = [...new Set(reps.flatMap((r) => r.related_model_patterns))];
    const header =
      `${fam} (SKU tested: ${tested.length ? tested.join(", ") : "not stated"}` +
      (patterns.length ? `; covers ${patterns.join(", ")}` : "") +
      `) — ${reps.map((r) => reportCitation(r)).join("; ")}`;
    return `${header}\n${capLines(g.lines).join("\n")}`;
  });
  const moreFams =
    famEntries.length > MAX_DIMMING_FAMILIES
      ? `\n(+${famEntries.length - MAX_DIMMING_FAMILIES} more families)`
      : "";

  return out(
    `${sections.join("\n\n")}${moreFams}\n\n${DIMMING_CHART_CAVEAT}\n${DIMMING_COVERAGE_CAVEAT}`,
    reportCitations(reports),
  );
}

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------

export async function dimmingDispatch(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutput> {
  if (name === "check_dimmer_compatibility") return checkDimmerCompatibility(ctx, input);
  if (name === "find_products_for_dimmer") return findProductsForDimmer(ctx, input);
  return out(`Unknown dimming tool: ${name}`);
}
