// =============================================================================
// crm_sales_by_category — category-sales plan v2 §E tests: schema shape (CS12),
// window resolution (America/New_York, Monday-start weeks, calendar qtd/ytd,
// the ~2-year cap, CS17 backlog translate-don't-raise), dispatch routing,
// output honesty (freshness line always, (unclassified), non-USD share,
// order-count footnote, per-foot unit labeling, WAC-family backlog scope,
// zero-rows-zero-total = "no access", never "$0 sales"), and the public-surface
// hard-reject (the crm_ prefix boundary).
// =============================================================================
import { describe, expect, it, vi } from "vitest";
import { composeTools, dispatch, PUBLIC_TOOL_NAMES } from "@wac/shared/thom";
import type { ToolContext } from "./types.js";
import type { Env } from "../env.js";
import { internalToolExtension } from "./agent.js";
import { HUBSPOT_TOOLS } from "./hubspotTools.js";
import {
  addDays,
  etToday,
  formatSalesAnswer,
  freshnessLine,
  MAX_WINDOW_DAYS,
  moneyUsd,
  resolveWindow,
  SALES_CLASS_VALUES,
  SALES_TOOL_NAME,
  SALES_TOOLS,
  salesDispatch,
  spanDays,
  unitsLabel,
  withSalesRoutingSeam,
  type SalesFreshness,
  type SalesRpcResult,
} from "./salesTools.js";

// A fixed clock: Tuesday 2026-07-21, noon ET (16:00Z).
const NOW = new Date("2026-07-21T16:00:00Z");

const emptyResult = (over: Partial<SalesRpcResult> = {}): SalesRpcResult => ({
  plane: "invoiced",
  group_by: "category",
  groups: [],
  group_count_total: 0,
  unclassified: null,
  coverage: {
    line_count: 0,
    resolved_line_count: 0,
    resolved_line_pct: null,
    total_value: 0,
    resolved_value: 0,
    resolved_value_pct: null,
    by_year: null,
  },
  non_usd: { line_count: 0, value: 0, line_pct: 0, value_pct: 0 },
  ...over,
});

const FRESH_INVOICED: SalesFreshness = {
  plane: "invoiced",
  last_ingest_at: "2026-07-21T11:15:00Z",
  max_billing_date: "2026-07-21",
};
const FRESH_BACKLOG: SalesFreshness = {
  plane: "backlog",
  last_ingest_at: "2026-07-21T10:39:00Z",
  snapshot_at: "2026-07-21T10:39:00Z",
  open_line_count: 7652,
};

function mockCtx(handlers: {
  sales?: (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null };
  freshness?: () => { data?: unknown; error?: { message: string } | null };
}): { ctx: ToolContext; rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "thom_sales_by_category") {
      return { data: null, error: null, ...(handlers.sales?.(args) ?? {}) };
    }
    if (fn === "thom_sales_freshness") {
      return { data: null, error: null, ...(handlers.freshness?.() ?? {}) };
    }
    return { data: null, error: { message: `unknown rpc ${fn}` } };
  });
  const ctx = { env: {} as never, sb: { rpc } as never } as unknown as ToolContext;
  return { ctx, rpc };
}

// --- schema shape (CS12/CS3/CS4) ---------------------------------------------

describe("SALES_TOOLS schema", () => {
  const tool = SALES_TOOLS[0]!;
  const rawProps = (tool.input_schema as { properties: Record<string, { enum?: string[]; description?: string }> })
    .properties;
  const props = {
    class: rawProps.class!,
    window: rawProps.window!,
    file_brand: rawProps.file_brand!,
    catalog_brand: rawProps.catalog_brand!,
  };

  it("is the crm_-prefixed tool (rides the internal-only extension + public hard-reject)", () => {
    expect(tool.name).toBe("crm_sales_by_category");
    expect(tool.name.startsWith("crm_")).toBe(true);
    expect(SALES_TOOLS).toHaveLength(1);
  });

  it("enumerates the legal class values VERBATIM from the 0060/0063 CASE (CS12)", () => {
    expect(props.class.enum).toEqual([
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
    ]);
    expect(props.class.enum).toEqual([...SALES_CLASS_VALUES]);
  });

  it("pins the calendar conventions the model would otherwise guess (CS12)", () => {
    expect(props.window.description).toMatch(/MONDAY-start/i);
    expect(props.window.description).toMatch(/CALENDAR quarters\/years, not fiscal/i);
    expect(props.window.description).toMatch(/Eastern/i);
  });

  it("spells out BOTH brand parameters so the router cannot conflate them (CS3)", () => {
    expect(props.file_brand.enum).toEqual(["WAC", "SCH"]);
    expect(props.file_brand.description).toMatch(/provenance/i);
    expect(props.file_brand.description).toMatch(/NOT the product's catalog brand/i);
    expect(props.catalog_brand.description).toMatch(/WAC Lighting/);
    expect(props.catalog_brand.description).toMatch(/Different concept from file_brand/i);
  });

  it("states the backlog WAC-family-only scope + the drill-down example + the routing seam", () => {
    expect(tool.description).toMatch(/WAC-family orders only; Schonbek backlog is not in this system/);
    expect(tool.description).toContain("{window:'mtd', class:'downlight', group_by:'family'}");
    expect(tool.description).toMatch(/crm_top_companies owns 'top companies by sales'/);
    expect(tool.description).toMatch(/crm_get_invoice_history/);
    expect(tool.description).toMatch(/NOT real time/i);
  });
});

describe("withSalesRoutingSeam", () => {
  it("appends the seam to crm_top_companies only, without mutating the shared constant", () => {
    const before = HUBSPOT_TOOLS.find((t) => t.name === "crm_top_companies")!.description!;
    const out = withSalesRoutingSeam(HUBSPOT_TOOLS);
    const seamed = out.find((t) => t.name === "crm_top_companies")!;
    expect(seamed.description).toContain(SALES_TOOL_NAME);
    expect(seamed.description!.startsWith(before)).toBe(true);
    // Original untouched; other tools byte-identical.
    expect(HUBSPOT_TOOLS.find((t) => t.name === "crm_top_companies")!.description).toBe(before);
    expect(out.find((t) => t.name === "crm_get_company")).toEqual(
      HUBSPOT_TOOLS.find((t) => t.name === "crm_get_company"),
    );
  });
});

// --- window resolution (§E.2) ------------------------------------------------

describe("window resolution (America/New_York)", () => {
  it("resolves 'today' to the ET civil day across the UTC midnight boundary", () => {
    // 02:30Z on the 22nd is still 22:30 EDT on the 21st.
    expect(etToday(new Date("2026-07-22T02:30:00Z"))).toBe("2026-07-21");
    const r = resolveWindow("today", undefined, undefined, new Date("2026-07-22T02:30:00Z"));
    expect(r).toMatchObject({ ok: true, win: { from: "2026-07-21", to: "2026-07-21", current: true } });
  });

  it("resolves today/yesterday across DST boundaries", () => {
    // Spring forward (2026-03-08): 06:30Z = 01:30 EST.
    const spring = resolveWindow("yesterday", undefined, undefined, new Date("2026-03-08T06:30:00Z"));
    expect(spring).toMatchObject({ ok: true, win: { from: "2026-03-07", to: "2026-03-07", current: false } });
    // Fall back (2026-11-01): 05:30Z = 01:30 EDT.
    const fall = resolveWindow("yesterday", undefined, undefined, new Date("2026-11-01T05:30:00Z"));
    expect(fall).toMatchObject({ ok: true, win: { from: "2026-10-31", to: "2026-10-31" } });
  });

  it("weeks are Monday-start ET (CS12)", () => {
    // 2026-07-21 is a Tuesday.
    const thisWeek = resolveWindow("this_week", undefined, undefined, NOW);
    expect(thisWeek).toMatchObject({ ok: true, win: { from: "2026-07-20", to: "2026-07-21", current: true } });
    const lastWeek = resolveWindow("last_week", undefined, undefined, NOW);
    expect(lastWeek).toMatchObject({ ok: true, win: { from: "2026-07-13", to: "2026-07-19", current: false } });
  });

  it("qtd/ytd are CALENDAR periods, mtd from the 1st, last_year full prior year (CS12)", () => {
    expect(resolveWindow("mtd", undefined, undefined, NOW)).toMatchObject({
      ok: true,
      win: { from: "2026-07-01", to: "2026-07-21", current: true },
    });
    expect(resolveWindow("qtd", undefined, undefined, NOW)).toMatchObject({
      ok: true,
      win: { from: "2026-07-01", to: "2026-07-21" },
    });
    expect(resolveWindow("ytd", undefined, undefined, NOW)).toMatchObject({
      ok: true,
      win: { from: "2026-01-01", to: "2026-07-21" },
    });
    expect(resolveWindow("last_year", undefined, undefined, NOW)).toMatchObject({
      ok: true,
      win: { from: "2025-01-01", to: "2025-12-31", current: false },
    });
  });

  it("passes explicit ranges through and refuses beyond the ~2-year cap (CS1)", () => {
    const ok = resolveWindow(undefined, "2025-01-01", "2025-06-30", NOW);
    expect(ok).toMatchObject({ ok: true, win: { from: "2025-01-01", to: "2025-06-30", current: false } });
    // Exactly the cap is allowed…
    expect(spanDays("2024-01-01", addDays("2024-01-01", MAX_WINDOW_DAYS))).toBe(MAX_WINDOW_DAYS);
    expect(resolveWindow(undefined, "2024-01-01", addDays("2024-01-01", MAX_WINDOW_DAYS), NOW).ok).toBe(true);
    // …one day past is a plain-English refusal.
    const wide = resolveWindow(undefined, "2024-01-01", addDays("2024-01-01", MAX_WINDOW_DAYS + 1), NOW);
    expect(wide.ok).toBe(false);
    if (!wide.ok) expect(wide.error).toMatch(/narrow the window/i);
    // Reversed + malformed ranges refuse plainly.
    expect(resolveWindow(undefined, "2026-02-02", "2026-02-01", NOW).ok).toBe(false);
    expect(resolveWindow(undefined, "2026-02-30", "2026-03-01", NOW).ok).toBe(false);
  });

  it("defaults to mtd when neither window nor dates are given", () => {
    expect(resolveWindow(undefined, undefined, undefined, NOW)).toMatchObject({
      ok: true,
      win: { from: "2026-07-01", to: "2026-07-21" },
    });
  });
});

// --- backlog window handling (CS17) ------------------------------------------

describe("backlog window handling (CS17: translate, don't raise)", () => {
  it("silently DROPS a routine window arg and calls the RPC date-less", async () => {
    const { ctx, rpc } = mockCtx({
      sales: () => ({
        data: emptyResult({
          plane: "backlog",
          groups: [
            { group_key: "Downlights", group_label: null, net_value: 100, units_each: 5, units_ft: null, line_count: 2, order_count: 2 },
          ],
          group_count_total: 1,
          coverage: { ...emptyResult().coverage, line_count: 2, resolved_line_count: 2, resolved_line_pct: 100, total_value: 100, resolved_value: 100, resolved_value_pct: 100 },
        }),
      }),
      freshness: () => ({ data: FRESH_BACKLOG }),
    });
    const out = await salesDispatch(ctx, SALES_TOOL_NAME, { plane: "backlog", window: "mtd" }, NOW);
    const salesCall = rpc.mock.calls.find((c) => c[0] === "thom_sales_by_category")!;
    expect(salesCall[1]).toMatchObject({ p_plane: "backlog", p_date_from: null, p_date_to: null });
    expect(out.content).toContain("Backlog snapshot as of");
  });

  it("explains an EXPLICITLY dated backlog request in plain English and never calls the RPC", async () => {
    const { ctx, rpc } = mockCtx({});
    const out = await salesDispatch(
      ctx,
      SALES_TOOL_NAME,
      { plane: "backlog", date_from: "2026-07-01", date_to: "2026-07-21" },
      NOW,
    );
    expect(out.content).toMatch(/point-in-time snapshot/i);
    expect(out.content).toMatch(/no date dimension/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("every backlog answer carries the WAC-family-only scope line (CS4)", async () => {
    const { ctx } = mockCtx({
      sales: () => ({
        data: emptyResult({
          plane: "backlog",
          groups: [
            { group_key: "Fans", group_label: null, net_value: 10, units_each: 1, units_ft: null, line_count: 1, order_count: 1 },
          ],
          group_count_total: 1,
          coverage: { ...emptyResult().coverage, line_count: 1, resolved_line_count: 1 },
        }),
      }),
      freshness: () => ({ data: FRESH_BACKLOG }),
    });
    const out = await salesDispatch(ctx, SALES_TOOL_NAME, { plane: "backlog" }, NOW);
    expect(out.content).toContain("Backlog covers WAC-family orders only; Schonbek backlog is not in this system.");
  });
});

// --- pipeline stage-2 stub ---------------------------------------------------

describe("plane pipeline (stage 2)", () => {
  it("answers the one-line not-yet-available reply without touching the DB", async () => {
    const { ctx, rpc } = mockCtx({});
    const out = await salesDispatch(ctx, SALES_TOOL_NAME, { plane: "pipeline", window: "ytd" }, NOW);
    expect(out.content).toMatch(/aren't available yet/i);
    expect(out.content).toMatch(/invoiced sales or the open-order backlog/i);
    expect(rpc).not.toHaveBeenCalled();
  });
});

// --- output honesty ----------------------------------------------------------

const RICH_RESULT = emptyResult({
  groups: [
    { group_key: "Downlights", group_label: null, net_value: 120000.5, units_each: 4200, units_ft: null, line_count: 900, order_count: 310 },
    { group_key: "Tape & Extrusion", group_label: null, net_value: 60000, units_each: null, units_ft: 15000, line_count: 400, order_count: 150 },
    { group_key: "Track", group_label: null, net_value: -2500, units_each: -60, units_ft: null, line_count: 20, order_count: 12 },
  ],
  group_count_total: 7,
  unclassified: { net_value: 9000, units: 100, line_count: 80, order_count: 40 },
  coverage: {
    line_count: 1400,
    resolved_line_count: 1320,
    resolved_line_pct: 94.3,
    total_value: 186500.5,
    resolved_value: 177500.5,
    resolved_value_pct: 95.9,
    by_year: null,
  },
  non_usd: { line_count: 30, value: 4000, line_pct: 2.1, value_pct: 1.4 },
});

describe("formatSalesAnswer honesty rules", () => {
  const params = {
    plane: "invoiced" as const,
    window: { from: "2026-07-01", to: "2026-07-21", label: "MTD", current: true },
    filters: { group_by: "category" },
  };

  it("always appends the freshness line, with PARTIAL for current windows", () => {
    const text = formatSalesAnswer(params, RICH_RESULT, FRESH_INVOICED);
    expect(text).toMatch(/As of the last turnover sync, 2026-07-21 07:15 ET/);
    expect(text).toMatch(/data through billing date 2026-07-21/);
    expect(text).toMatch(/PARTIAL/);
    // Closed windows drop the partial warning but keep the as-of line.
    const closed = formatSalesAnswer(
      { ...params, window: { ...params.window!, current: false } },
      RICH_RESULT,
      FRESH_INVOICED,
    );
    expect(closed).toMatch(/As of the last turnover sync/);
    expect(closed).not.toMatch(/PARTIAL/);
  });

  it("renders the (unclassified) bucket with the fixed explanation (A.5)", () => {
    const text = formatSalesAnswer(params, RICH_RESULT, FRESH_INVOICED);
    expect(text).toContain("(unclassified): $9,000.00");
    expect(text).toMatch(/don't resolve to the current product catalog/);
  });

  it("prints the non-USD exclusion when nonzero and omits it at zero (CS2)", () => {
    const text = formatSalesAnswer(params, RICH_RESULT, FRESH_INVOICED);
    expect(text).toContain("Excludes 2.1% of lines (1.4% of value) in non-USD currencies (no conversion available).");
    const none = formatSalesAnswer(params, emptyResult({ groups: RICH_RESULT.groups, coverage: RICH_RESULT.coverage }), FRESH_INVOICED);
    expect(none).not.toMatch(/non-USD/);
  });

  it("carries the order-count non-additivity footnote (CS11) and the coverage sentence (CS7)", () => {
    const text = formatSalesAnswer(params, RICH_RESULT, FRESH_INVOICED);
    expect(text).toContain("order counts are per-group and NOT additive across rows");
    expect(text).toContain("Coverage: 94.3% of lines (95.9% of value) resolved to the catalog for this window.");
  });

  it("prints the per-year coverage breakdown on multi-year windows (CS7)", () => {
    const multi = {
      ...RICH_RESULT,
      coverage: {
        ...RICH_RESULT.coverage,
        by_year: [
          { year: 2025, line_count: 700, resolved_line_count: 650, resolved_line_pct: 92.9, resolved_value_pct: 96.1 },
          { year: 2026, line_count: 700, resolved_line_count: 500, resolved_line_pct: 71.4, resolved_value_pct: 57.2 },
        ],
      },
    };
    const text = formatSalesAnswer(
      { ...params, window: { from: "2025-01-01", to: "2026-07-21", label: "custom", current: true } },
      multi,
      FRESH_INVOICED,
    );
    expect(text).toMatch(/coverage varies by year/i);
    expect(text).toContain("2025: 92.9% of lines / 96.1% of value");
    expect(text).toContain("2026: 71.4% of lines / 57.2% of value");
  });

  it("labels per-foot quantities as FEET, never a bare blended unit sum (CS10)", () => {
    expect(unitsLabel({ units_each: 4200, units_ft: null })).toBe("4,200 units");
    expect(unitsLabel({ units_each: null, units_ft: 15000 })).toBe("15,000 ft");
    expect(unitsLabel({ units_each: 10, units_ft: 500 })).toBe("10 units + 500 ft");
    expect(unitsLabel({ units_each: 0, units_ft: 0 })).toBe("");
    const text = formatSalesAnswer(params, RICH_RESULT, FRESH_INVOICED);
    expect(text).toContain("Tape & Extrusion: $60,000.00, 15,000 ft");
  });

  it("marks negative nets as net of returns/credits", () => {
    const text = formatSalesAnswer(params, RICH_RESULT, FRESH_INVOICED);
    expect(text).toContain("Track: -$2,500.00, net of returns/credits");
    expect(moneyUsd(-2500)).toBe("-$2,500.00");
  });

  it("notes overflow beyond top_n instead of silently truncating", () => {
    const text = formatSalesAnswer(params, RICH_RESULT, FRESH_INVOICED);
    expect(text).toMatch(/and 4 more group\(s\)/);
  });
});

// --- zero-rows-zero-total (A.6) ----------------------------------------------

describe("zero-rows-zero-total handling", () => {
  it("answers 'no access', never '$0 sales', when freshness is ALSO invisible (RLS wall)", async () => {
    const { ctx } = mockCtx({
      sales: () => ({ data: emptyResult() }),
      freshness: () => ({ data: null }),
    });
    const out = await salesDispatch(ctx, SALES_TOOL_NAME, { window: "ytd" }, NOW);
    expect(out.content).toMatch(/don't appear to have access/i);
    expect(out.content).not.toMatch(/\$0/);
  });

  it("reports an empty window (with the as-of line) when freshness IS visible", async () => {
    const { ctx } = mockCtx({
      sales: () => ({ data: emptyResult() }),
      freshness: () => ({ data: FRESH_INVOICED }),
    });
    const out = await salesDispatch(ctx, SALES_TOOL_NAME, { window: "yesterday" }, NOW);
    expect(out.content).toMatch(/No invoiced lines in that window/);
    expect(out.content).toMatch(/As of the last turnover sync/);
  });

  it("renders a permission-denied RPC error as no-access", async () => {
    const { ctx } = mockCtx({ sales: () => ({ data: null, error: { message: "permission denied for table turnover_orders" } }) });
    const out = await salesDispatch(ctx, SALES_TOOL_NAME, { window: "ytd" }, NOW);
    expect(out.content).toMatch(/don't appear to have access/i);
  });
});

// --- dispatch plumbing + composition ----------------------------------------

describe("dispatch routing + extension composition", () => {
  const envWith = (over: Partial<Record<string, string>>): Env => ({ ...over }) as unknown as Env;

  it("passes filters and the resolved ET window through to the RPC", async () => {
    const { ctx, rpc } = mockCtx({
      sales: () => ({ data: RICH_RESULT }),
      freshness: () => ({ data: FRESH_INVOICED }),
    });
    await salesDispatch(
      ctx,
      SALES_TOOL_NAME,
      { window: "mtd", group_by: "family", class: "downlight", file_brand: "WAC", top_n: 99 },
      NOW,
    );
    const call = rpc.mock.calls.find((c) => c[0] === "thom_sales_by_category")!;
    expect(call[1]).toMatchObject({
      p_plane: "invoiced",
      p_date_from: "2026-07-01",
      p_date_to: "2026-07-21",
      p_group_by: "family",
      p_class: "downlight",
      p_file_brand: "WAC",
      p_top_n: 25, // clamped
    });
  });

  it("internalToolExtension routes the sales tool to salesDispatch and crm_* to HubSpot", async () => {
    const ext = internalToolExtension(envWith({ THOM_CATEGORY_SALES: "1" }))!;
    expect(ext).toBeDefined();
    expect(ext.owns(SALES_TOOL_NAME)).toBe(true);
    expect(ext.tools.map((t) => t.name)).toContain(SALES_TOOL_NAME);
    // Sales route: reaches the sb.rpc mock (pipeline short-circuits without DB,
    // proving the sales dispatcher answered, not HubSpot's).
    const { ctx } = mockCtx({});
    const sales = await ext.dispatch(ctx, SALES_TOOL_NAME, { plane: "pipeline" });
    expect(sales.content).toMatch(/aren't available yet/i);
    // HubSpot route: no read token configured -> the HubSpot dispatcher's
    // NOT_CONFIGURED reply (proves routing went to hubspotDispatch).
    const hs = await ext.dispatch(ctx, "crm_get_company", {});
    expect(hs.content).toBe("CRM tools are not configured.");
  });

  it("composes tools by flag: off = absent (even with a CRM token), on = present", () => {
    expect(internalToolExtension(envWith({}))).toBeUndefined();
    const crmOnly = internalToolExtension(envWith({ HUBSPOT_READ_TOKEN: "t" }))!;
    expect(crmOnly.tools.map((t) => t.name)).not.toContain(SALES_TOOL_NAME);
    // Flag off -> no seam sentence on crm_top_companies either (CS6 atomicity).
    expect(crmOnly.tools.find((t) => t.name === "crm_top_companies")!.description).not.toContain(SALES_TOOL_NAME);
    const both = internalToolExtension(envWith({ HUBSPOT_READ_TOKEN: "t", THOM_CATEGORY_SALES: "1" }))!;
    expect(both.tools.map((t) => t.name)).toContain(SALES_TOOL_NAME);
    expect(both.tools.find((t) => t.name === "crm_top_companies")!.description).toContain(SALES_TOOL_NAME);
    // Sales without CRM token still composes the sales tool alone.
    const salesOnly = internalToolExtension(envWith({ THOM_CATEGORY_SALES: "1" }))!;
    expect(salesOnly.tools.map((t) => t.name)).toEqual([SALES_TOOL_NAME]);
  });
});

// --- public-surface boundary (§E.4) ------------------------------------------

describe("public-surface boundary", () => {
  it("is absent from the public allowlist and from every public tool composition", () => {
    expect(PUBLIC_TOOL_NAMES.has(SALES_TOOL_NAME)).toBe(false);
    const env = { AI: null, THOM_CATEGORY_SALES: "1" };
    const names = composeTools("public", env, SALES_TOOLS).map((t) => t.name);
    expect(names).not.toContain(SALES_TOOL_NAME);
  });

  it("is HARD-REJECTED by the shared dispatch on the public surface even if injected", async () => {
    const ext = internalToolExtension({ THOM_CATEGORY_SALES: "1" } as unknown as Env)!;
    const { ctx } = mockCtx({});
    const out = await dispatch(ctx, SALES_TOOL_NAME, {}, { surface: "public", extension: ext });
    expect(out.content).toContain(`Tool "${SALES_TOOL_NAME}" is not available on this surface.`);
  });
});
