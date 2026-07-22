// =============================================================================
// Dimming tool tests (plan §F): forward/reverse happy paths, the honest miss,
// the family-level answer, the DC14 status='active' join filter (a
// needs_review/superseded report's rows NEVER appear in either tool), the
// skus_tested scope line on every answer (DC4), caps, and citation shape.
// Runs against an in-memory fake Supabase client.
// =============================================================================
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ThomEnv } from "./env.js";
import type { ToolContext } from "./types.js";
import {
  capLines,
  DIMMING_CHART_CAVEAT,
  DIMMING_COVERAGE_CAVEAT,
  dimmingDispatch,
  familyLevelAnswer,
  formatCompatLine,
  MAX_DIMMING_LINES,
  reportCitation,
  reportScopeLine,
  type DimmingCompatRecord,
  type DimmingReportRecord,
} from "./dimmingTools.js";

// --- tiny in-memory PostgREST fake ------------------------------------------

type Row = Record<string, unknown>;

function likeToRe(pattern: string): RegExp {
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\" && i + 1 < pattern.length) out += esc(pattern[++i]!);
    else if (c === "%") out += ".*";
    else if (c === "_") out += ".";
    else out += esc(c);
  }
  return new RegExp(`^${out}$`, "i");
}

class FakeQuery implements PromiseLike<{ data: Row[] | Row | null; error: null }> {
  private rows: Row[];
  private single = false;
  constructor(rows: Row[]) {
    this.rows = [...rows];
  }
  select(): this {
    return this;
  }
  eq(col: string, v: unknown): this {
    this.rows = this.rows.filter((r) => r[col] === v);
    return this;
  }
  neq(col: string, v: unknown): this {
    this.rows = this.rows.filter((r) => r[col] !== v);
    return this;
  }
  in(col: string, vs: unknown[]): this {
    const set = new Set(vs);
    this.rows = this.rows.filter((r) => set.has(r[col]));
    return this;
  }
  ilike(col: string, pattern: string): this {
    const re = likeToRe(pattern);
    this.rows = this.rows.filter((r) => typeof r[col] === "string" && re.test(r[col] as string));
    return this;
  }
  contains(col: string, vs: unknown[]): this {
    this.rows = this.rows.filter(
      (r) => Array.isArray(r[col]) && vs.every((v) => (r[col] as unknown[]).includes(v)),
    );
    return this;
  }
  limit(n: number): this {
    this.rows = this.rows.slice(0, n);
    return this;
  }
  maybeSingle(): this {
    this.single = true;
    return this;
  }
  then<T1, T2>(
    onfulfilled?: (v: { data: Row[] | Row | null; error: null }) => T1 | PromiseLike<T1>,
    onrejected?: (e: unknown) => T2 | PromiseLike<T2>,
  ): PromiseLike<T1 | T2> {
    const data = this.single ? (this.rows[0] ?? null) : this.rows;
    return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
  }
}

function fakeSb(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from: (name: string) => new FakeQuery(tables[name] ?? []),
  } as unknown as SupabaseClient;
}

const ctx = (tables: Record<string, Row[]>): ToolContext => ({
  env: {} as ThomEnv,
  sb: fakeSb(tables),
});

// --- fixtures ---------------------------------------------------------------

const REPORT: Row = {
  id: "rep-1",
  kb_document_id: "doc-1",
  source_url: "https://cdn.example/tube_cube.zip",
  report_code: "E1801063-1_25W",
  report_code_derived: true,
  product_family: '5" Tube & Cube Architectural',
  skus_tested: ["DS-WS05-F30A-WT"],
  related_model_patterns: ["DS-CD05-*", "DC-CD05-*"],
  related_model_likes: ["DS-CD05-%", "DC-CD05-%"],
  test_voltage_range: "120-277VAC",
  test_notes: null,
  status: "active",
};

const REVIEW_REPORT: Row = {
  ...REPORT,
  id: "rep-2",
  report_code: "E9999999_BAD",
  status: "needs_review",
};

const rows: Row[] = [
  {
    report_id: "rep-1",
    manufacturer: "Lutron",
    dimmer_series: "Diva",
    dimmer_model: "DVCL-153PD",
    mode_qualifier: null,
    dimmer_model_norm: "DVCL-153PD",
    related_dimmer_models: [],
    related_dimmer_models_norm: [],
    phase_type: "triac",
    test_voltage: "120",
    low_end_pct: 10,
    status: "not_recommended",
    comments: "Not Recommended",
  },
  {
    report_id: "rep-1",
    manufacturer: "Lutron",
    dimmer_series: "Diva",
    dimmer_model: "DVELV-300P",
    mode_qualifier: null,
    dimmer_model_norm: "DVELV-300P",
    related_dimmer_models: [],
    related_dimmer_models_norm: [],
    phase_type: "elv",
    test_voltage: "120",
    low_end_pct: 7,
    status: "tested_compatible",
    comments: "",
  },
  {
    report_id: "rep-1",
    manufacturer: "Legrand",
    dimmer_series: "Adorne Touch (ELV)",
    dimmer_model: "ADTH700RMTUM1",
    mode_qualifier: "elv",
    dimmer_model_norm: "ADTH700RMTUM1",
    related_dimmer_models: [],
    related_dimmer_models_norm: [],
    phase_type: "adaptive",
    test_voltage: "120",
    low_end_pct: 9,
    status: "tested_compatible",
    comments: "Flicker below 9%",
  },
  // The needs_review unit's row — must NEVER surface (DC14).
  {
    report_id: "rep-2",
    manufacturer: "Lutron",
    dimmer_series: "Maestro",
    dimmer_model: "SECRET-999X",
    mode_qualifier: null,
    dimmer_model_norm: "SECRET-999X",
    related_dimmer_models: [],
    related_dimmer_models_norm: [],
    phase_type: "triac",
    test_voltage: "120",
    low_end_pct: 1,
    status: "tested_compatible",
    comments: "",
  },
];

const TABLES: Record<string, Row[]> = {
  products: [
    { sku: "2718", name: "5in Tube Downlight", family: "Tube & Cube", variant_search: "DS-CD05-F30A-WT DS-CD05-F27A-BK" },
    { sku: "2719", name: "6in Tube Downlight", family: "Tube & Cube", variant_search: "DS-CD06-F30A-WT" },
  ],
  dimming_report_products: [
    { report_id: "rep-1", product_sku: "2718", link_kind: "pattern" },
    { report_id: "rep-2", product_sku: "2718", link_kind: "pattern" },
  ],
  dimming_reports: [REPORT, REVIEW_REPORT],
  dimming_compat_rows: rows,
};

// --- forward ----------------------------------------------------------------

describe("check_dimmer_compatibility", () => {
  it("summarizes the ACTIVE report with scope line, phase counts, and verbatim comments", async () => {
    const out = await dimmingDispatch(ctx(TABLES), "check_dimmer_compatibility", { product: "2718" });
    expect(out.content).toContain('5" Tube & Cube Architectural');
    expect(out.content).toContain("DS-WS05-F30A-WT"); // skus_tested on EVERY answer (DC4)
    expect(out.content).toContain("from the chart filename"); // derived code flagged (DC9)
    expect(out.content).toContain("Tested compatible (2)");
    expect(out.content).toContain("Flicker below 9%"); // verbatim comment
    expect(out.content).toContain("Not Recommended");
    expect(out.content).toContain(DIMMING_CHART_CAVEAT);
    // Citation carries the source PDF.
    expect(out.citations[0]?.url).toBe("https://cdn.example/tube_cube.zip");
  });

  it("NEVER surfaces a needs_review report's rows (DC14 status='active' filter)", async () => {
    const out = await dimmingDispatch(ctx(TABLES), "check_dimmer_compatibility", { product: "2718" });
    expect(out.content).not.toContain("SECRET-999X");
    expect(out.content).not.toContain("E9999999_BAD");
  });

  it("answers a specific pairing with phase type AND mode qualifier", async () => {
    const out = await dimmingDispatch(ctx(TABLES), "check_dimmer_compatibility", {
      product: "2718",
      dimmer: "ADTH700RMTUM1",
    });
    expect(out.content).toContain("Adaptive phase");
    expect(out.content).toContain("ELV mode");
    expect(out.content).toContain("9%");
  });

  it("labels a suffix-variant hit as closest tested model, never an exact result (DC10)", async () => {
    const out = await dimmingDispatch(ctx(TABLES), "check_dimmer_compatibility", {
      product: "2718",
      dimmer: "DVCL-153P",
    });
    expect(out.content).toContain("DVCL-153PD");
    expect(out.content).toContain("closest tested model");
  });

  it("resolves a variant SKU to its parent product's chart", async () => {
    const out = await dimmingDispatch(ctx(TABLES), "check_dimmer_compatibility", {
      product: "DS-CD05-F30A-WT",
    });
    expect(out.content).toContain('5" Tube & Cube Architectural');
  });

  it("gives the FAMILY-LEVEL answer when a sibling has units but this SKU matches none (DC4)", async () => {
    const out = await dimmingDispatch(ctx(TABLES), "check_dimmer_compatibility", { product: "2719" });
    expect(out.content).toContain("cover these sizes/wattages");
    expect(out.content).toContain("DS-WS05-F30A-WT");
    expect(out.content).toContain("Never assume one unit's results apply to another size");
    // Never an arbitrarily chosen unit's row list.
    expect(out.content).not.toContain("DVELV-300P");
  });

  it("honest miss + coverage caveat when nothing covers the product", async () => {
    const out = await dimmingDispatch(ctx(TABLES), "check_dimmer_compatibility", { product: "NOPE-1" });
    expect(out.content).toContain("not in WAC Group's tested dimming charts");
    expect(out.content).toContain("never a statement of incompatibility");
  });

  it("honest miss for an untested pairing on a covered product", async () => {
    const out = await dimmingDispatch(ctx(TABLES), "check_dimmer_compatibility", {
      product: "2718",
      dimmer: "WNRL50-XYZ99",
    });
    expect(out.content).toContain("not in this chart's tested dimmer list");
  });
});

// --- reverse ----------------------------------------------------------------

describe("find_products_for_dimmer", () => {
  it("groups matches by family with skus_tested, patterns, and the coverage caveat VERBATIM", async () => {
    const out = await dimmingDispatch(ctx(TABLES), "find_products_for_dimmer", {
      dimmer: "Lutron DVELV-300P",
    });
    expect(out.content).toContain('5" Tube & Cube Architectural');
    expect(out.content).toContain("DS-WS05-F30A-WT");
    expect(out.content).toContain("DS-CD05-*");
    expect(out.content).toContain("Reverse phase (ELV)");
    expect(out.content).toContain(DIMMING_COVERAGE_CAVEAT);
    expect(out.content).toContain(DIMMING_CHART_CAVEAT);
  });

  it("excludes rows whose report is not active (DC14)", async () => {
    const out = await dimmingDispatch(ctx(TABLES), "find_products_for_dimmer", {
      dimmer: "SECRET-999X",
    });
    expect(out.content).not.toContain("SECRET-999X: tested");
    expect(out.content).toContain("not in WAC Group's tested dimming charts");
  });

  it("status filter keeps only tested_compatible rows", async () => {
    const out = await dimmingDispatch(ctx(TABLES), "find_products_for_dimmer", {
      dimmer: "DVCL-153PD",
      status: "tested_compatible",
    });
    // The only DVCL-153PD row is not_recommended -> filtered to nothing.
    expect(out.content).toContain("not in WAC Group's tested dimming charts");
  });

  it("requires a dimmer", async () => {
    const out = await dimmingDispatch(ctx(TABLES), "find_products_for_dimmer", {});
    expect(out.content).toContain("dimmer is required");
  });
});

// --- pure formatting ---------------------------------------------------------

describe("formatting", () => {
  it("reportCitation flags a filename-derived id (DC9)", () => {
    expect(reportCitation({ report_code: "WAC-S2", report_code_derived: false })).toBe(
      "WAC Group dimming chart WAC-S2",
    );
    expect(reportCitation({ report_code: "E123_25W", report_code_derived: true })).toContain(
      "from the chart filename",
    );
    expect(reportCitation({ report_code: null, report_code_derived: false })).toBe(
      "WAC Group dimming chart",
    );
  });

  it("reportScopeLine always names family + tested SKUs (DC4)", () => {
    const line = reportScopeLine(REPORT as unknown as DimmingReportRecord);
    expect(line).toContain('5" Tube & Cube Architectural');
    expect(line).toContain("DS-WS05-F30A-WT");
  });

  it("formatCompatLine renders qualifier + measured low end + verbatim comment", () => {
    const line = formatCompatLine(rows[2] as unknown as DimmingCompatRecord);
    expect(line).toContain("Adaptive phase, used in ELV mode");
    expect(line).toContain("measured low end 9%");
    expect(line).toContain('"Flicker below 9%"');
    expect(line).not.toContain("closest tested model");
  });

  it("never invents the word Recommended for a compatible row", () => {
    const line = formatCompatLine(rows[1] as unknown as DimmingCompatRecord);
    expect(line).toContain("tested compatible");
    expect(line).not.toMatch(/Recommended/);
  });

  it("caps lines at MAX_DIMMING_LINES with +N more", () => {
    const lines = Array.from({ length: MAX_DIMMING_LINES + 4 }, (_, i) => `- line ${i}`);
    const capped = capLines(lines);
    expect(capped).toHaveLength(MAX_DIMMING_LINES + 1);
    expect(capped[capped.length - 1]).toBe("(+4 more)");
  });

  it("familyLevelAnswer never picks a unit", () => {
    const text = familyLevelAnswer("2719", [REPORT as unknown as DimmingReportRecord]);
    expect(text).toContain("cover these sizes/wattages");
    expect(text).toContain("Never assume");
  });
});
