// =============================================================================
// Dimming ingest tests (plan §F): zip-entry unit hashing incl. the DC4
// byte-identical dedupe -> zip_entry_path[]; zmatdimrep junk filtering +
// derived-URL builder; the pure derivation layer (applyExtraction); the DC6
// supersession computation; the DC4 pattern-primary binding + overlap audit;
// and the DC7 Step-B exclusion (pending select, dry-run count, retry-failed).
// =============================================================================
import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtractedDimmingReport } from "@wac/shared/thom";
import { DIMMING_REPORT_DOC_TYPE } from "@wac/shared/thom";
import {
  applyExtraction,
  buildPatternBindings,
  computeSupersededDocIds,
  derivedDimReportUrl,
  isPdfMagic,
  isZipMagic,
  sha256Hex,
  unitsFromBytes,
  validZmatdimrep,
  type DimmingDocMeta,
} from "./dimming.js";
import { processPending, requeueFailed } from "./index.js";

const PDF_A = new TextEncoder().encode("%PDF-1.4 fake chart A");
const PDF_B = new TextEncoder().encode("%PDF-1.4 fake chart B");

// --- unit fan-out (DC4) ------------------------------------------------------

describe("unitsFromBytes", () => {
  it("treats a loose PDF as a single unit with null zip paths", () => {
    const { units, skipped } = unitsFromBytes(PDF_A);
    expect(units).toHaveLength(1);
    expect(units[0]!.zipEntryPaths).toBeNull();
    expect(units[0]!.contentHash).toBe(sha256Hex(PDF_A));
    expect(skipped).toEqual([]);
  });

  it("dedupes byte-identical zip entries into ONE unit carrying ALL paths (DC4)", () => {
    // The Tube_Cube shape: the same bytes under contradictory folder names.
    const zip = zipSync({
      "Fam/6in/E1801063-2_35W.pdf": PDF_A,
      "Fam/8in/E1801063-2_34W.pdf": PDF_A,
      "Fam/5in/E1801063-1_25W.pdf": PDF_B,
    });
    const { units } = unitsFromBytes(zip);
    expect(units).toHaveLength(2);
    const dup = units.find((u) => u.contentHash === sha256Hex(PDF_A))!;
    expect(dup.zipEntryPaths).toHaveLength(2);
    expect(dup.zipEntryPaths).toContain("Fam/6in/E1801063-2_35W.pdf");
    expect(dup.zipEntryPaths).toContain("Fam/8in/E1801063-2_34W.pdf");
  });

  it("skips-and-logs non-PDF entries (DWG etc.)", () => {
    const zip = zipSync({
      "a/chart.pdf": PDF_A,
      "a/drawing.dwg": new TextEncoder().encode("dwg bytes"),
    });
    const { units, skipped } = unitsFromBytes(zip);
    expect(units).toHaveLength(1);
    expect(skipped).toEqual(["a/drawing.dwg"]);
  });

  it("throws on bytes that are neither PDF nor zip", () => {
    expect(() => unitsFromBytes(new TextEncoder().encode("<html>nope"))).toThrow(/not a PDF or zip/);
  });

  it("magic helpers", () => {
    expect(isPdfMagic(PDF_A)).toBe(true);
    expect(isZipMagic(zipSync({ "x.pdf": PDF_A }))).toBe(true);
    expect(isZipMagic(PDF_A)).toBe(false);
  });
});

// --- zmatdimrep filter + derived URL (§A.4) ----------------------------------

describe("derived-URL fallback", () => {
  it('filters the junk "0" and N/A markers', () => {
    expect(validZmatdimrep("WAC-S2_V0_DIMREP.pdf")).toBe("WAC-S2_V0_DIMREP.pdf");
    expect(validZmatdimrep("0")).toBeNull();
    expect(validZmatdimrep("N/A")).toBeNull();
    expect(validZmatdimrep("NA")).toBeNull();
    expect(validZmatdimrep("")).toBeNull();
    expect(validZmatdimrep(null)).toBeNull();
  });

  it("builds the verified brand-site URL, url-encoded", () => {
    expect(derivedDimReportUrl("E1801037V0 (HR-LED418).pdf")).toBe(
      "https://waclighting.com/storage/waclighting-images/dim_report/E1801037V0%20(HR-LED418).pdf",
    );
  });
});

// --- applyExtraction (pure derivation layer) ---------------------------------

const EXTRACTED: ExtractedDimmingReport = {
  report_code: null,
  product_family: '5" Tube & Cube Architectural',
  skus_tested: ["DS‐WS05‐F30A‐WT"],
  related_model_patterns: ["DS‐CD05‐*", "DC‐CD05‐*"],
  test_voltage_range: "120-277VAC",
  control_types: ["ELV", "0-10V"],
  test_notes: "CPU SCM: 03.56 build 2025-02",
  rows: [
    {
      page: 1,
      section_header: "Adaptive Phase Dimmers",
      manufacturer: "Legrand",
      dimmer_series: "Adorne Touch",
      dimmer_model: "ADTH700RMTUM1 (ELV)",
      related_dimmer_models: [],
      phase_type: "adaptive",
      test_voltage: "120",
      low_end_pct: 9,
      comments: "Flicker below 9%",
    },
    {
      page: 1,
      section_header: "Adaptive Phase Dimmers",
      manufacturer: "Legrand",
      dimmer_series: "Adorne Touch",
      dimmer_model: "ADTH700RMTUM1 (TRIAC)",
      related_dimmer_models: [],
      phase_type: "adaptive",
      test_voltage: "120",
      low_end_pct: 18,
      comments: "Not Recommended",
    },
    {
      page: 2,
      section_header: "Forward Phase Dimmers (TRIAC) Cont.",
      manufacturer: "Lutron",
      dimmer_series: "Maestro",
      dimmer_model: "MA‐PRO",
      related_dimmer_models: ["RRD‐PRO", "AYCL-153P/253P", "-"],
      // The model mislabeled the section — the code-side header derivation wins.
      phase_type: "adaptive",
      test_voltage: "120",
      low_end_pct: null,
      comments: "Wobbles mysteriously at dusk",
    },
  ],
};

describe("applyExtraction", () => {
  const applied = applyExtraction(EXTRACTED, "Fam/5in Tube and Cube/E1801063-1_25W.pdf");

  it("derives the report code from the entry filename when the body has none (DC9)", () => {
    expect(applied.report.report_code).toBe("E1801063-1_25W");
    expect(applied.report.report_code_derived).toBe(true);
  });

  it("keeps a body-carried code as-is, not flagged derived", () => {
    const withCode = applyExtraction({ ...EXTRACTED, report_code: "WAC-S2" }, "x/y.pdf");
    expect(withCode.report.report_code).toBe("WAC-S2");
    expect(withCode.report.report_code_derived).toBe(false);
  });

  it("parses + strips the mode qualifier BEFORE building the norm key (DC2)", () => {
    const [elv, triac] = applied.rows;
    expect(elv!.mode_qualifier).toBe("elv");
    expect(triac!.mode_qualifier).toBe("triac");
    expect(elv!.dimmer_model_norm).toBe("ADTH700RMTUM1");
    expect(triac!.dimmer_model_norm).toBe("ADTH700RMTUM1");
    expect(elv!.phase_type).toBe("adaptive");
    expect(triac!.phase_type).toBe("adaptive");
  });

  it("derives status in code (DC1) and collects unknown vocabulary", () => {
    const [elv, triac, weird] = applied.rows;
    expect(elv!.status).toBe("tested_compatible");
    expect(triac!.status).toBe("not_recommended");
    expect(weird!.status).toBe("tested_issue");
    expect(applied.unknownVocabulary).toEqual(["Wobbles mysteriously at dusk"]);
  });

  it("re-derives phase from the section header and reports disagreements", () => {
    const weird = applied.rows[2]!;
    expect(weird.phase_type).toBe("triac"); // header wins over the model's 'adaptive'
    expect(applied.phaseDisagreements).toHaveLength(1);
  });

  it("slash-expands + placeholder-drops related models with U+2010 fixed (DC8)", () => {
    const weird = applied.rows[2]!;
    expect(weird.related_dimmer_models_norm).toEqual(["RRD-PRO", "AYCL-153P", "AYCL-253P"]);
    expect(weird.related_dimmer_models).toEqual(["RRD-PRO", "AYCL-153P/253P"]);
  });

  it("builds normalized LIKE patterns from the header wildcards", () => {
    expect(applied.report.related_model_likes).toEqual(["DS-CD05-%", "DC-CD05-%"]);
    expect(applied.report.skus_tested).toEqual(["DS-WS05-F30A-WT"]);
    expect(applied.report.test_notes).toContain("CPU SCM: 03.56"); // DC12 firmware line
  });
});

// --- supersession computation (DC6) ------------------------------------------

const doc = (over: Partial<DimmingDocMeta>): DimmingDocMeta => ({
  id: "d1",
  url: "https://cdn.example/f.pdf",
  source_system: "sales_layer",
  status: "pending_extract",
  updated_at: "2026-07-21T00:00:00Z",
  ...over,
});

describe("computeSupersededDocIds", () => {
  it("supersedes older same-url rows (a changed file keeps its filename)", () => {
    const ids = computeSupersededDocIds([
      doc({ id: "old", updated_at: "2026-07-01T00:00:00Z" }),
      doc({ id: "new", updated_at: "2026-07-21T00:00:00Z" }),
    ]);
    expect(ids.has("old")).toBe(true);
    expect(ids.has("new")).toBe(false);
  });

  it("supersedes docs the daily capture stopped touching (staleness)", () => {
    const ids = computeSupersededDocIds([
      doc({ id: "dropped", url: "https://cdn.example/dropped.pdf", updated_at: "2026-06-01T00:00:00Z" }),
      doc({ id: "current", url: "https://cdn.example/current.pdf", updated_at: "2026-07-21T00:00:00Z" }),
    ]);
    expect(ids.has("dropped")).toBe(true);
    expect(ids.has("current")).toBe(false);
  });

  it("never staleness-sweeps admin uploads (they retire explicitly)", () => {
    const ids = computeSupersededDocIds([
      doc({ id: "au", source_system: "admin_upload", url: null, updated_at: "2020-01-01T00:00:00Z" }),
      doc({ id: "current", updated_at: "2026-07-21T00:00:00Z" }),
    ]);
    expect(ids.has("au")).toBe(false);
  });

  it("passes already-superseded rows through (idempotent)", () => {
    const ids = computeSupersededDocIds([doc({ id: "s", status: "superseded" })]);
    expect(ids.has("s")).toBe(true);
  });
});

// --- pattern-primary binding + overlap audit (DC4) ---------------------------

describe("buildPatternBindings", () => {
  const rep = (id: string, family: string, likes: string[], tested: string[] = []) => ({
    id,
    product_family: family,
    skus_tested: tested,
    related_model_likes: likes,
    loosePdf: false,
    kb_document_id: null,
  });

  it("binds via product sku, variant sku, and tested-sku exact match", () => {
    const { links, overlaps } = buildPatternBindings(
      [rep("r1", "Tube", ["DS-CD05-%"], ["DS-WS05-F30A-WT"])],
      [
        { sku: "DS-CD05-F30A", variant_search: null },
        { sku: "2718", variant_search: "DS-CD05-F27A-BK OTHER-1" },
        { sku: "2999", variant_search: "DS-WS05-F30A-WT" },
        { sku: "NOPE", variant_search: null },
      ],
    );
    expect(overlaps).toEqual([]);
    expect(links.map((l) => l.product_sku).sort()).toEqual(["2718", "2999", "DS-CD05-F30A"]);
    expect(links.every((l) => l.link_kind === "pattern")).toBe(true);
  });

  it("HOLDS a sku matched by 2+ units with DIFFERENT families (overlap audit)", () => {
    const { links, overlaps } = buildPatternBindings(
      [rep("r1", "Tube", ["DS-CD05-%"]), rep("r2", "Cube", ["DS-CD%"])],
      [{ sku: "DS-CD05-F30A", variant_search: null }],
    );
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]!.sku).toBe("DS-CD05-F30A");
    expect(links).toEqual([]);
  });

  it("same-family multi-unit matches are NOT overlaps (both links written)", () => {
    const { links, overlaps } = buildPatternBindings(
      [rep("r1", "Tube", ["DS-CD05-%"]), rep("r2", "Tube", ["DS-CD%"])],
      [{ sku: "DS-CD05-F30A", variant_search: null }],
    );
    expect(overlaps).toEqual([]);
    expect(links).toHaveLength(2);
  });
});

// --- DC7: Step-B exclusion (pending select + dry-run count + retry-failed) ---

interface Captured {
  table: string;
  filters: { op: string; args: unknown[] }[];
}

/** A recording fake: every chain call is captured; queries resolve empty. */
function recordingSb(captured: Captured[]): SupabaseClient {
  const make = (table: string) => {
    const rec: Captured = { table, filters: [] };
    captured.push(rec);
    const q: Record<string, unknown> = {};
    const chain =
      (op: string) =>
      (...args: unknown[]) => {
        rec.filters.push({ op, args });
        return q;
      };
    for (const m of ["select", "eq", "neq", "in", "ilike", "order", "limit", "update", "range"]) {
      q[m] = chain(m);
    }
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null, count: 0 }).then(res);
    return q;
  };
  return { from: make } as unknown as SupabaseClient;
}

const cf = { accountId: "x", token: "y" };

describe("Step-B exclusion (DC7)", () => {
  it("the pending select excludes doc_type dimming_report", async () => {
    const captured: Captured[] = [];
    await processPending(recordingSb(captured), cf, null, null, null, null, false);
    const kbSelects = captured.filter(
      (c) => c.table === "kb_documents" && c.filters.some((f) => f.op === "select"),
    );
    expect(kbSelects.length).toBeGreaterThan(0);
    for (const sel of kbSelects) {
      expect(sel.filters).toContainEqual({
        op: "neq",
        args: ["doc_type", DIMMING_REPORT_DOC_TYPE],
      });
    }
  });

  it("the dry-run count excludes doc_type dimming_report", async () => {
    const captured: Captured[] = [];
    await processPending(recordingSb(captured), cf, null, null, null, null, true);
    const sel = captured.find((c) => c.table === "kb_documents");
    expect(sel).toBeDefined();
    expect(sel!.filters).toContainEqual({ op: "neq", args: ["doc_type", DIMMING_REPORT_DOC_TYPE] });
  });

  it("the retry-failed requeue excludes doc_type dimming_report", async () => {
    const captured: Captured[] = [];
    await requeueFailed(recordingSb(captured));
    const upd = captured.find(
      (c) => c.table === "kb_documents" && c.filters.some((f) => f.op === "update"),
    );
    expect(upd).toBeDefined();
    expect(upd!.filters).toContainEqual({ op: "neq", args: ["doc_type", DIMMING_REPORT_DOC_TYPE] });
    expect(upd!.filters).toContainEqual({ op: "eq", args: ["status", "failed"] });
  });
});
