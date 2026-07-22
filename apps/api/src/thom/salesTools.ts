// =============================================================================
// INTERNAL SURFACE ONLY — crm_sales_by_category (category-sales plan v2,
// docs/thom-category-sales-plan.md; migration 0065).
//
// Aggregated sales-by-product-type rollups over the Supabase warehouse:
//   plane 'invoiced' — turnover_orders (authoritative invoiced history)
//   plane 'backlog'  — open_orders is_open snapshot (WAC family ONLY, CS4)
//   plane 'pipeline' — stage 2 (deal_quote_lines mirror); answers "not yet
//                      available" until it ships.
//
// The tool rides the same internal-only crm_* extension as the HubSpot tools
// (agent.ts), so the public surface hard-reject (tools.ts PUBLIC_TOOL_NAMES)
// covers it for free. It reads through ctx.sb — the USER-RLS Supabase client —
// so the DB itself enforces internal/admin (SECURITY INVOKER RPC + the 0065
// InitPlan policies): a misrouted call yields zero rows from Postgres, which
// this module renders as "no access", never "$0 sales".
//
// Windows resolve HERE, in TypeScript, in America/New_York (the closedate
// noon-UTC lesson applied preemptively): billing_date is an SAP business date
// and a UTC "today" is wrong for ~4 hours every evening. The model never
// computes dates. CS12 pins: Monday-start ET weeks; CALENDAR (not fiscal)
// quarters/years. CS17: for plane 'backlog' the tool silently DROPS window
// args (translate, don't raise) — only an explicitly DATED backlog request
// gets the plain-English snapshot explanation.
// =============================================================================

import { MOUNTING_TYPE_DESCRIPTION, MOUNTING_TYPE_VALUES } from "@wac/shared/thom";
import type { ClaudeTool } from "../anthropic.js";
import type { ToolContext, ToolOutput } from "./types.js";

export const SALES_TOOL_NAME = "crm_sales_by_category";

/** Legal class values — enumerated VERBATIM from the class CASE (0060/0063,
 *  now product_spec_class() in 0068) so the model filters on real buckets.
 *  Since 0068 class is DERIVED mounting-type-first; mounting_type is the
 *  authoritative fixture-type facet. */
export const SALES_CLASS_VALUES = [
  "per-foot",
  "fan",
  "downlight",
  "track",
  "outdoor",
  "wall",
  "ceiling",
  "linear",
  "decorative",
  "other",
] as const;

/** The real zmntyp vocabulary (0068) — re-exported for the schema tests. */
export const SALES_MOUNTING_TYPE_VALUES = MOUNTING_TYPE_VALUES;

export const SALES_WINDOW_VALUES = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "mtd",
  "qtd",
  "ytd",
  "last_year",
] as const;
export type SalesWindowKey = (typeof SALES_WINDOW_VALUES)[number];

const GROUP_BY_VALUES = [
  "category",
  "class",
  "family",
  "brand",
  "product",
  "mounting_type",
  "product_type",
] as const;

/** Explicit date ranges cap at ~2 years (CS1; the monthly pre-aggregate that
 *  would unlock deep history is deferred). */
export const MAX_WINDOW_DAYS = 731;

const TOP_N_DEFAULT = 10;
const TOP_N_MAX = 25;

// --- tool schema -------------------------------------------------------------

export const SALES_TOOLS: ClaudeTool[] = [
  {
    name: SALES_TOOL_NAME,
    description:
      "Internal sales data (read-only): AGGREGATED sales by PRODUCT TYPE — 'sales of downlights today', 'top families this month', 'how much tape did we sell YTD', 'what's in the backlog for fans'. " +
      "Rolls up invoiced sales history (plane 'invoiced', from the SAP turnover warehouse) or the open-order backlog snapshot (plane 'backlog' — covers WAC-family orders only; Schonbek backlog is not in this system), grouped by category/class/family/brand/product/mounting_type/product_type. " +
      "For fixture-type scopes (downlights, landscape, track, fans) filter with mounting_type — the authoritative catalog taxonomy — never by name words. " +
      "Figures are internal business data, NOT real time: always keep the as-of line the tool returns, and never extrapolate a full day from partial data. " +
      "Drill-down is this same tool, narrowed: 'which downlight families sold most this month' → {window:'mtd', class:'downlight', group_by:'family'}. " +
      "Routing seam: crm_top_companies owns 'top companies by sales'; this tool owns 'sales by product type'. For a SPECIFIC customer's history use crm_get_invoice_history.",
    input_schema: {
      type: "object",
      properties: {
        plane: {
          type: "string",
          enum: ["invoiced", "backlog", "pipeline"],
          description:
            "invoiced (default) = shipped-and-billed sales history; backlog = open-order snapshot (point-in-time, no dates; WAC family only); pipeline = deals (not yet available).",
        },
        window: {
          type: "string",
          enum: [...SALES_WINDOW_VALUES],
          description:
            "Named date window, resolved server-side in US Eastern Time (default mtd). Weeks are MONDAY-start ET; qtd/ytd are CALENDAR quarters/years, not fiscal. Ignored for plane 'backlog' (a snapshot has no date dimension).",
        },
        date_from: {
          type: "string",
          description: "Explicit window start (YYYY-MM-DD), used with date_to instead of `window`. Ranges cap at ~2 years.",
        },
        date_to: {
          type: "string",
          description: "Explicit window end (YYYY-MM-DD), inclusive.",
        },
        group_by: {
          type: "string",
          enum: [...GROUP_BY_VALUES],
          description: "Rollup grouping (default category).",
        },
        file_brand: {
          type: "string",
          enum: ["WAC", "SCH"],
          description:
            "SAP turnover FILE provenance — which SAP file the invoiced line came from (WAC or SCH). This is a data-provenance filter, NOT the product's catalog brand: cross-brand materials can ride one file. Invoiced plane only.",
        },
        catalog_brand: {
          type: "string",
          description:
            "The resolved CATALOG brand of the product, by display name: WAC Lighting, Modern Forms, Schonbek (or a Schonbek sub-brand), aiSpire. Different concept from file_brand — use this for 'Modern Forms sales', use file_brand only for the SAP file split.",
        },
        class: {
          type: "string",
          enum: [...SALES_CLASS_VALUES],
          description:
            "Product class filter (the catalog's class buckets, exactly these values — e.g. downlight, track, per-foot for tape/strip). A coarse DERIVED bucket: mounting_type is the authoritative fixture-type facet; prefer it when a mounting_type value matches the ask.",
        },
        mounting_type: {
          type: "string",
          enum: [...MOUNTING_TYPE_VALUES],
          description: MOUNTING_TYPE_DESCRIPTION,
        },
        product_type: {
          type: "string",
          description:
            "Sales Layer product-type filter (exact zprdtyp value). Narrower than mounting_type; use only when the user names a specific catalog product type.",
        },
        category: { type: "string", description: "Sales Layer category filter (exact category name)." },
        family: { type: "string", description: "Product family filter (exact family name)." },
        top_n: { type: "integer", description: `Max group rows (default ${TOP_N_DEFAULT}, cap ${TOP_N_MAX}).` },
      },
    },
  },
];

/**
 * Append the routing-seam sentence to crm_top_companies WITHOUT mutating the
 * shared HUBSPOT_TOOLS constant. Composed only when the sales tool is actually
 * offered (flag on) — a static seam sentence would command an unadvertised
 * tool when the flag is off (the CS6 failure shape).
 */
export function withSalesRoutingSeam(tools: ClaudeTool[]): ClaudeTool[] {
  return tools.map((t) =>
    t.name === "crm_top_companies"
      ? {
          ...t,
          description:
            `${t.description ?? ""} Routing seam: this tool ranks COMPANIES by sales; for sales by PRODUCT TYPE/category (downlights, tape, fans...) use ${SALES_TOOL_NAME}.`,
        }
      : t,
  );
}

// =============================================================================
// Window resolution — pure, America/New_York, injectable clock for tests.
// =============================================================================

const ET = "America/New_York";

/** The current civil date in US Eastern Time as YYYY-MM-DD. */
export function etToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function parts(iso: string): { y: number; m: number; d: number } {
  const [y = 0, m = 0, d = 0] = iso.split("-").map(Number);
  return { y, m, d };
}

function civilMs(iso: string): number {
  const { y, m, d } = parts(iso);
  return Date.UTC(y, m - 1, d);
}

function fromCivilMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Add n civil days to a YYYY-MM-DD date (pure calendar math — no TZ). */
export function addDays(iso: string, n: number): string {
  return fromCivilMs(civilMs(iso) + n * 86_400_000);
}

/** Inclusive civil-day span of [from, to] (both YYYY-MM-DD). */
export function spanDays(from: string, to: string): number {
  return Math.round((civilMs(to) - civilMs(from)) / 86_400_000);
}

/** Day of week with Monday = 0 (CS12: weeks are Monday-start). */
function dowMon0(iso: string): number {
  return (new Date(civilMs(iso)).getUTCDay() + 6) % 7;
}

function isValidIsoDay(iso: string): boolean {
  if (!ISO_DAY.test(iso)) return false;
  const { y, m, d } = parts(iso);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export type ResolvedWindow = {
  from: string;
  to: string;
  label: string;
  /** Window includes the current ET day → figures are PARTIAL. */
  current: boolean;
};

export type WindowResolution = { ok: true; win: ResolvedWindow } | { ok: false; error: string };

/**
 * Resolve a named window or an explicit range into inclusive ET civil dates.
 * Named windows (CS12): Monday-start weeks; CALENDAR quarters/years. Explicit
 * ranges are capped at MAX_WINDOW_DAYS (CS1) — longer gets a plain-English
 * "narrow the window" refusal.
 */
export function resolveWindow(
  windowKey: string | undefined,
  dateFrom: string | undefined,
  dateTo: string | undefined,
  now: Date = new Date(),
): WindowResolution {
  const today = etToday(now);

  if (dateFrom || dateTo) {
    if (!dateFrom || !dateTo) {
      return { ok: false, error: "Give both date_from and date_to (YYYY-MM-DD), or use a named window." };
    }
    if (!isValidIsoDay(dateFrom) || !isValidIsoDay(dateTo)) {
      return { ok: false, error: "Dates must be valid YYYY-MM-DD." };
    }
    if (civilMs(dateTo) < civilMs(dateFrom)) {
      return { ok: false, error: "date_to is before date_from." };
    }
    if (spanDays(dateFrom, dateTo) > MAX_WINDOW_DAYS) {
      return {
        ok: false,
        error:
          "That range spans more than ~2 years, which is the widest this tool can aggregate — narrow the window (or split it into per-year requests).",
      };
    }
    return {
      ok: true,
      win: { from: dateFrom, to: dateTo, label: `${dateFrom} to ${dateTo}`, current: civilMs(dateTo) >= civilMs(today) },
    };
  }

  const key = (windowKey ?? "mtd") as SalesWindowKey;
  const { y, m } = parts(today);
  switch (key) {
    case "today":
      return { ok: true, win: { from: today, to: today, label: "today", current: true } };
    case "yesterday": {
      const yd = addDays(today, -1);
      return { ok: true, win: { from: yd, to: yd, label: "yesterday", current: false } };
    }
    case "this_week": {
      const mon = addDays(today, -dowMon0(today));
      return { ok: true, win: { from: mon, to: today, label: "this week (Mon-start, ET)", current: true } };
    }
    case "last_week": {
      const mon = addDays(today, -dowMon0(today) - 7);
      return {
        ok: true,
        win: { from: mon, to: addDays(mon, 6), label: "last week (Mon–Sun, ET)", current: false },
      };
    }
    case "mtd": {
      const first = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
      return { ok: true, win: { from: first, to: today, label: "MTD", current: true } };
    }
    case "qtd": {
      const qm = m - ((m - 1) % 3); // calendar quarter start month (CS12)
      const first = `${String(y).padStart(4, "0")}-${String(qm).padStart(2, "0")}-01`;
      return { ok: true, win: { from: first, to: today, label: "QTD (calendar)", current: true } };
    }
    case "ytd":
      return { ok: true, win: { from: `${y}-01-01`, to: today, label: "YTD (calendar)", current: true } };
    case "last_year":
      return {
        ok: true,
        win: { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: `last year (${y - 1})`, current: false },
      };
    default:
      return { ok: false, error: `Unknown window '${windowKey}'.` };
  }
}

// =============================================================================
// RPC result shapes + pure formatting (unit-tested in salesTools.test.ts).
// =============================================================================

export interface SalesGroupRow {
  group_key: string;
  group_label: string | null;
  net_value: number | null;
  units_each: number | null;
  units_ft: number | null;
  line_count: number;
  order_count: number;
}

export interface SalesRpcResult {
  plane: string;
  group_by: string;
  groups: SalesGroupRow[];
  group_count_total: number;
  unclassified: { net_value: number; units: number; line_count: number; order_count: number } | null;
  coverage: {
    line_count: number;
    resolved_line_count: number;
    resolved_line_pct: number | null;
    total_value: number;
    resolved_value: number;
    resolved_value_pct: number | null;
    by_year:
      | { year: number; line_count: number; resolved_line_count: number; resolved_line_pct: number | null; resolved_value_pct: number | null }[]
      | null;
  };
  non_usd: { line_count: number; value: number; line_pct: number; value_pct: number };
}

export interface SalesFreshness {
  plane: string;
  last_ingest_at: string | null;
  max_billing_date?: string | null;
  snapshot_at?: string | null;
  open_line_count?: number | null;
}

/** "$1,234.56" (negative → "-$1,234.56"). */
export function moneyUsd(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}$${abs}`;
}

function intFmt(v: number | null | undefined): string {
  return Math.round(Number(v ?? 0)).toLocaleString("en-US");
}

/** Timestamptz ISO → "YYYY-MM-DD HH:MM ET". */
export function etStamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${day} ${time} ET`;
}

/**
 * CS10 unit labeling: each-goods print as units; per-foot classes (tape,
 * channel) print as FEET; a mixed group prints both, never a bare blended sum.
 * Returns "" when there is nothing meaningful to print.
 */
export function unitsLabel(row: Pick<SalesGroupRow, "units_each" | "units_ft">): string {
  const each = Number(row.units_each ?? 0);
  const ft = Number(row.units_ft ?? 0);
  const bits: string[] = [];
  if (each !== 0) bits.push(`${intFmt(each)} units`);
  if (ft !== 0) bits.push(`${intFmt(ft)} ft`);
  return bits.join(" + ");
}

/** The mandatory freshness tail (never left to the model). */
export function freshnessLine(
  plane: "invoiced" | "backlog",
  fresh: SalesFreshness | null,
  currentWindow: boolean,
): string {
  if (plane === "backlog") {
    const at = etStamp(fresh?.snapshot_at ?? fresh?.last_ingest_at) ?? "(sync time unavailable)";
    return `Backlog snapshot as of ${at}.`;
  }
  const at = etStamp(fresh?.last_ingest_at) ?? "(sync time unavailable)";
  const through = fresh?.max_billing_date ? ` (data through billing date ${fresh.max_billing_date}${
    currentWindow
      ? " — today's figures are PARTIAL: invoices post throughout the day and files arrive on a ~3-hour sync"
      : ""
  })` : "";
  return `As of the last turnover sync, ${at}${through}.`;
}

const UNCLASSIFIED_EXPLANATION =
  "materials that don't resolve to the current product catalog — custom, legacy, parts, and adjustment lines";

const BACKLOG_SCOPE_LINE = "Backlog covers WAC-family orders only; Schonbek backlog is not in this system.";

export interface SalesAnswerParams {
  plane: "invoiced" | "backlog";
  window?: ResolvedWindow;
  filters: {
    group_by: string;
    file_brand?: string;
    catalog_brand?: string;
    class?: string;
    mounting_type?: string;
    product_type?: string;
    category?: string;
    family?: string;
  };
}

/** Render the full text answer from the RPC result + freshness facts. Pure. */
export function formatSalesAnswer(
  params: SalesAnswerParams,
  data: SalesRpcResult,
  fresh: SalesFreshness | null,
): string {
  const { plane, window: win, filters } = params;
  const filterBits = [
    filters.mounting_type && `${filters.mounting_type} (mounting type)`,
    filters.product_type && `${filters.product_type} (product type)`,
    filters.class && `${filters.class} (class)`,
    filters.category && `category ${filters.category}`,
    filters.family && `family ${filters.family}`,
    filters.catalog_brand && `${filters.catalog_brand} (catalog brand)`,
    filters.file_brand && `${filters.file_brand} file`,
  ].filter(Boolean);
  const scope = filterBits.length ? `, ${filterBits.join(", ")}` : "";

  const header =
    plane === "backlog"
      ? `Open-order backlog snapshot${scope}, by ${filters.group_by}:`
      : `Invoiced sales${scope}, by ${filters.group_by}, ${win ? `${win.label} ${win.from} to ${win.to}` : ""}:`;

  const lines: string[] = [header];

  const groups = data.groups ?? [];
  groups.forEach((g, i) => {
    const label = g.group_label ? `${g.group_key} (${g.group_label})` : g.group_key;
    const bits = [moneyUsd(g.net_value)];
    if (Number(g.net_value ?? 0) < 0) bits.push("net of returns/credits");
    const units = unitsLabel(g);
    if (units) bits.push(units);
    bits.push(`${intFmt(g.order_count)} orders`);
    lines.push(`${i + 1}. ${label}: ${bits.join(", ")}`);
  });
  if (!groups.length) {
    lines.push("(no resolved product groups matched)");
  }
  const overflow = Number(data.group_count_total ?? 0) - groups.length;
  if (overflow > 0) lines.push(`…and ${overflow} more group(s) — raise top_n or narrow the filters.`);

  const un = data.unclassified;
  if (un && (un.line_count > 0 || Number(un.net_value) !== 0)) {
    lines.push(`(unclassified): ${moneyUsd(un.net_value)} — ${UNCLASSIFIED_EXPLANATION}.`);
  }

  lines.push("Note: order counts are per-group and NOT additive across rows (one order spans categories).");

  const nu = data.non_usd;
  if (nu && nu.line_count > 0) {
    lines.push(
      `Excludes ${nu.line_pct}% of lines (${nu.value_pct}% of value) in non-USD currencies (no conversion available).`,
    );
  }

  const cov = data.coverage;
  if (cov) {
    let covLine = `Coverage: ${cov.resolved_line_pct ?? 0}% of lines (${cov.resolved_value_pct ?? 0}% of value) resolved to the catalog for this window.`;
    if (cov.by_year && cov.by_year.length > 1) {
      const perYear = cov.by_year
        .map((yc) => `${yc.year}: ${yc.resolved_line_pct ?? 0}% of lines / ${yc.resolved_value_pct ?? 0}% of value`)
        .join("; ");
      covLine += ` Per-year (coverage varies by year): ${perYear}.`;
    }
    lines.push(covLine);
  }

  if (plane === "backlog") lines.push(BACKLOG_SCOPE_LINE);
  lines.push(freshnessLine(plane, fresh, win?.current ?? false));

  return lines.join("\n");
}

// =============================================================================
// Dispatch (I/O) — reads through ctx.sb (the user-RLS client).
// =============================================================================

const text = (content: string): ToolOutput => ({ content, cards: [], citations: [] });

const PIPELINE_NOT_YET =
  "Deal-pipeline category rollups aren't available yet — I can show invoiced sales or the open-order backlog instead.";

const BACKLOG_DATED_EXPLANATION =
  "The open-order backlog is a point-in-time snapshot — it has no date dimension, so a dated backlog request can't be answered. " +
  "Ask for the current backlog (no dates), or use invoiced sales for a dated window.";

const NO_ACCESS =
  "You don't appear to have access to internal sales data (internal/admin access is required), so I can't report sales figures.";

function str(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : undefined;
}

export async function salesDispatch(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
  now: Date = new Date(),
): Promise<ToolOutput> {
  if (name !== SALES_TOOL_NAME) return text(`Unknown sales tool: ${name}`);

  const planeRaw = str(input.plane) ?? "invoiced";
  if (planeRaw === "pipeline") return text(PIPELINE_NOT_YET);
  if (planeRaw !== "invoiced" && planeRaw !== "backlog") {
    return text(`Unknown plane '${planeRaw}' — use invoiced or backlog.`);
  }
  const plane = planeRaw as "invoiced" | "backlog";

  const groupBy = str(input.group_by) ?? "category";
  if (!(GROUP_BY_VALUES as readonly string[]).includes(groupBy)) {
    return text(`Unknown group_by '${groupBy}' — use one of: ${GROUP_BY_VALUES.join(", ")}.`);
  }
  const topN = Math.min(Math.max(Number(input.top_n) || TOP_N_DEFAULT, 1), TOP_N_MAX);

  const filters = {
    group_by: groupBy,
    file_brand: str(input.file_brand),
    catalog_brand: str(input.catalog_brand),
    class: str(input.class),
    mounting_type: str(input.mounting_type),
    product_type: str(input.product_type),
    category: str(input.category),
    family: str(input.family),
  };

  let win: ResolvedWindow | undefined;
  if (plane === "backlog") {
    // CS17 translate-don't-raise: router models habitually fill `window` on
    // every call — silently DROP it (and any non-explicit date args). Only an
    // EXPLICITLY dated backlog request gets the snapshot explanation.
    if (str(input.date_from) || str(input.date_to)) {
      return text(BACKLOG_DATED_EXPLANATION);
    }
    // backlog carries no file_brand — it is WAC-family only (CS4).
    filters.file_brand = undefined;
  } else {
    const resolved = resolveWindow(str(input.window), str(input.date_from), str(input.date_to), now);
    if (!resolved.ok) return text(resolved.error);
    win = resolved.win;
  }

  const rpcArgs: Record<string, unknown> = {
    p_plane: plane,
    p_date_from: win?.from ?? null,
    p_date_to: win?.to ?? null,
    p_group_by: groupBy,
    p_file_brand: filters.file_brand ?? null,
    p_catalog_brand: filters.catalog_brand ?? null,
    p_class: filters.class ?? null,
    p_category: filters.category ?? null,
    p_family: filters.family ?? null,
    p_mounting_type: filters.mounting_type ?? null,
    p_product_type: filters.product_type ?? null,
    p_top_n: topN,
  };

  const { data, error } = await ctx.sb.rpc("thom_sales_by_category", rpcArgs);
  if (error) {
    if (/permission denied|not allowed|42501/i.test(error.message ?? "")) return text(NO_ACCESS);
    return text(`Sales rollup failed: ${error.message}`);
  }
  const result = data as SalesRpcResult | null;

  const freshRes = await ctx.sb.rpc("thom_sales_freshness", { p_plane: plane });
  const fresh = (freshRes.error ? null : (freshRes.data as SalesFreshness | null)) ?? null;

  // Zero-rows-with-zero-total: RLS gives a non-internal user zero rows from
  // Postgres itself. Distinguish "no access" (freshness — also internal-RLS'd —
  // returned nothing either) from a genuinely empty window, and NEVER answer
  // "$0 sales" for the former (§A.6).
  const lineCount = Number(result?.coverage?.line_count ?? 0);
  if (!result || lineCount === 0) {
    const hasFreshness = !!(fresh && (fresh.last_ingest_at || fresh.snapshot_at || fresh.max_billing_date));
    if (!hasFreshness) return text(NO_ACCESS);
    if (plane === "backlog") {
      return text(`No open backlog lines in the snapshot. ${BACKLOG_SCOPE_LINE}\n${freshnessLine("backlog", fresh, false)}`);
    }
    return text(
      `No invoiced lines in that window (${win?.label ?? ""} ${win?.from ?? ""} to ${win?.to ?? ""}).\n` +
        freshnessLine("invoiced", fresh, win?.current ?? false),
    );
  }

  return text(formatSalesAnswer({ plane, window: win, filters }, result, fresh));
}
