// =============================================================================
// filter_products + get_product dimension surface tests (attribute-filter
// plan §E): p_-prefixed arg assembly, TS-side unit conversion (O10),
// name-first dual-unit formatting with raw recorded axes (Addendum 1),
// honest windowed coverage, the MANDATORY product-level-lumens sentence (O2),
// the pinned zero-match relaxation protocol (A13/O11), free-text fallbacks,
// flag gating + public allowlist, and the O1 per-size get_product dims.
// =============================================================================
import { describe, expect, it } from "vitest";
import { composeTools, specFilterEnabled } from "./agent.js";
import {
  applicationPatterns,
  buildFilterPredicates,
  canonicalPdp,
  dimToInches,
  dispatch,
  FILTER_TOOLS,
  filterCoverageLine,
  fmtIn,
  fmtMmAsIn,
  fmtWire,
  formatFilterRows,
  formatProductDims,
  hasNumericPredicate,
  MOUNTING_TYPE_VALUES,
  ppidLabel,
  PRODUCT_LEVEL_LUMENS_SENTENCE,
  PUBLIC_TOOL_NAMES,
  SEARCH_PRODUCTS_FILTER_POINTER,
  SPEC_RANK_CLASSES,
  withConstraintRouting,
  TOOLS,
  type FilterRpcRow,
  type ProductDimRow,
} from "./tools.js";
import type { ThomEnv } from "./env.js";
import type { ToolContext } from "./types.js";

const env = (over: Partial<ThomEnv> = {}): ThomEnv =>
  ({ AI: { run: async () => ({ data: [new Array(1024).fill(0)] }) }, ...over }) as unknown as ThomEnv;

/** One product_spec_filter RPC row shaped like the Slim thesis case. */
const frow = (over: Partial<FilterRpcRow> = {}): FilterRpcRow => ({
  sku: "3554",
  name: "Slim Bath & Vanity Light",
  brand: "WAC Lighting",
  category: "Bath & Vanity Lights",
  class: "wall",
  per_ft: false,
  qualifying_variants: 2,
  variant_count_with_dims: 6,
  example_variant_sku: "WS-3554-30-BN",
  qualifying_variant_skus: ["WS-3554-30-BN", "WS-3554-36-BN"],
  q_width_min_in: 18,
  q_width_max_in: 18,
  q_depth_min_in: 2.6,
  q_depth_max_in: 2.6,
  q_height_min_in: 5,
  q_height_max_in: 5,
  ex_width_in: 18,
  ex_depth_in: 2.6,
  ex_height_in: 5,
  ex_width_mm: 66.04,
  ex_height_mm: 127,
  ex_length_mm: 457.2,
  ex_diameter_mm: null,
  ex_wire_length_mm: null,
  cct_summary: "3000K",
  cri: 90,
  ip: null,
  lumens: 1268,
  lumens_source: "variant",
  score: 0.12,
  in_scope_total: 30,
  in_scope_screened: 28,
  matched: 9,
  ...over,
});

/** A zero-match counts-carrier row (null sku). */
const countsRow = (over: Partial<FilterRpcRow> = {}): FilterRpcRow =>
  frow({
    sku: null,
    name: null,
    brand: null,
    category: null,
    class: null,
    per_ft: null,
    qualifying_variants: null,
    variant_count_with_dims: null,
    example_variant_sku: null,
    qualifying_variant_skus: null,
    q_width_min_in: null,
    q_width_max_in: null,
    q_depth_min_in: null,
    q_depth_max_in: null,
    q_height_min_in: null,
    q_height_max_in: null,
    ex_width_in: null,
    ex_depth_in: null,
    ex_height_in: null,
    ex_width_mm: null,
    ex_height_mm: null,
    ex_length_mm: null,
    ex_diameter_mm: null,
    ex_wire_length_mm: null,
    cct_summary: null,
    cri: null,
    ip: null,
    lumens: null,
    lumens_source: null,
    score: null,
    matched: 0,
    ...over,
  });

/** Fake ctx whose sb.rpc records every call and returns queued results, and
 *  whose sb.from serves `pdps` rows (for the pdp_urls link batch-join). */
function makeCtx(
  results: { data: unknown; error: { message: string } | null }[],
  pdps: { sku: string; url: string | null }[] = [],
) {
  const calls: { fn: string; params: Record<string, unknown> }[] = [];
  const sb = {
    rpc(fn: string, params: Record<string, unknown>) {
      calls.push({ fn, params });
      return Promise.resolve(results[calls.length - 1] ?? { data: [], error: null });
    },
    from(_table: string) {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "limit", "order", "ilike"]) b[m] = () => b;
      b.maybeSingle = () => Promise.resolve({ data: pdps[0] ?? null, error: null });
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve({ data: pdps, error: null }).then(res, rej);
      return b;
    },
  };
  const ctx = { env: env(), sb: sb as unknown as ToolContext["sb"] } as ToolContext;
  return { ctx, calls };
}

// --- unit conversion (O10 — TS-side, never the model) ------------------------

describe("dimToInches / buildFilterPredicates", () => {
  it("converts cm/ft/mm to inches in TS before the RPC call", () => {
    expect(dimToInches(38.1, "cm")).toBe(15);
    expect(dimToInches(2, "ft")).toBe(24);
    expect(dimToInches(381, "mm")).toBe(15);
    expect(dimToInches(15, "in")).toBe(15);
  });

  it("assembles p_-prefixed predicate args (plan A3) with unit conversion applied", () => {
    const preds = buildFilterPredicates({
      max_width_in: 38.1,
      max_depth_in: 10.16,
      min_lumens: 1000,
      cct_min_k: 3000,
      cct_max_k: 3000,
      min_cri: 90,
      min_ip: 65,
      unit: "cm",
    });
    expect(preds.p_width_max_in).toBe(15);
    expect(preds.p_depth_max_in).toBe(4);
    expect(preds.p_lumens_min).toBe(1000); // lumens are unitless — never converted
    expect(preds.p_cct_min_k).toBe(3000);
    expect(preds.p_cct_max_k).toBe(3000);
    expect(preds.p_cri_min).toBe(90);
    expect(preds.p_ip_min).toBe(65);
    expect(preds.p_width_min_in).toBeNull();
    // Every key carries the p_ prefix.
    expect(Object.keys(preds).every((k) => k.startsWith("p_"))).toBe(true);
  });

  it("converts wire-length args with the same unit", () => {
    const preds = buildFilterPredicates({ min_wire_length: 10, unit: "ft" });
    expect(preds.p_wire_min_in).toBe(120);
  });

  it("hasNumericPredicate distinguishes constrained from unconstrained calls", () => {
    expect(hasNumericPredicate(buildFilterPredicates({}))).toBe(false);
    expect(hasNumericPredicate(buildFilterPredicates({ max_width_in: 15 }))).toBe(true);
  });
});

// --- dual-unit rendering (Addendum 1) ----------------------------------------

describe("dual-unit formatting", () => {
  it("renders inches with the mm conversion alongside", () => {
    expect(fmtIn(18)).toBe("18.0 in (457 mm)");
    expect(fmtMmAsIn(457.2)).toBe("18.0 in (457 mm)");
    expect(fmtMmAsIn(66.04)).toBe("2.6 in (66 mm)");
  });

  it("renders wire lengths as ft (m)", () => {
    expect(fmtWire(1828.8)).toBe("6 ft (1.83 m)");
  });
});

// --- row + coverage formatting ------------------------------------------------

describe("formatFilterRows", () => {
  it("renders NAME-FIRST rows with dual-unit derived values, raw recorded axes, the sizes count, and REAL variant SKUs", () => {
    const [line] = formatFilterRows([frow()], { lumensStated: true, wireStated: false });
    expect(line).toBe(
      "- Slim Bath & Vanity Light (PPID 3554, WAC Lighting, wall): " +
        "18.0 in (457 mm) wide, 2.6 in (66 mm) deep, 5.0 in (127 mm) tall " +
        "(recorded W 2.6 in (66 mm) x H 5.0 in (127 mm) x L 18.0 in (457 mm)); " +
        "2 of 6 sizes meet your limits; order SKUs WS-3554-30-BN, WS-3554-36-BN; " +
        "3000K, CRI 90, 1,268 lm",
    );
  });

  it("NEVER labels the numeric PPID as 'SKU' — the SKU label is reserved for variant part numbers", () => {
    const [line] = formatFilterRows([frow()], { lumensStated: false, wireStated: false });
    expect(line).toContain("(PPID 3554");
    expect(line).not.toContain("SKU 3554");
    expect(line).toContain("order SKUs WS-3554-30-BN");
    expect(ppidLabel("822")).toBe("PPID 822");
    expect(ppidLabel("WS-180414-30-BN")).toBe("SKU WS-180414-30-BN"); // non-numeric ids ARE part numbers
  });

  it("falls back to the single example variant SKU when the 0069 array is absent (pre-apply rows)", () => {
    const [line] = formatFilterRows([frow({ qualifying_variant_skus: undefined })], {
      lumensStated: false,
      wireStated: false,
    });
    expect(line).toContain("e.g. order SKU WS-3554-30-BN");
  });

  it("adds a +N more tail when more variants qualify than the capped SKU list carries", () => {
    const [line] = formatFilterRows(
      [frow({ qualifying_variants: 9, qualifying_variant_skus: ["A-1", "A-2", "A-3", "A-4", "A-5", "A-6"] })],
      { lumensStated: false, wireStated: false },
    );
    expect(line).toContain("order SKUs A-1, A-2, A-3, A-4, A-5, A-6 (+3 more)");
  });

  it("renders the product name as a markdown link when a canonical PDP url is known", () => {
    const [line] = formatFilterRows([frow()], {
      lumensStated: false,
      wireStated: false,
      pdpBySku: new Map([["3554", "https://www.waclighting.com/slim-vanity"]]),
    });
    expect(line).toContain("- [Slim Bath & Vanity Light](https://www.waclighting.com/slim-vanity) (PPID 3554");
  });

  it("says depth is not defined for depth-undefined classes instead of inventing a number", () => {
    const [line] = formatFilterRows(
      [frow({ class: "decorative", ex_depth_in: null, q_depth_min_in: null, q_depth_max_in: null })],
      { lumensStated: false, wireStated: false },
    );
    expect(line).toContain("depth is not defined for this fixture type");
  });

  it("labels per-foot widths as tape cross-section (the reel exception)", () => {
    const [line] = formatFilterRows(
      [
        frow({
          class: "per-foot",
          per_ft: true,
          ex_width_in: 0.3,
          ex_depth_in: null,
          ex_height_in: null,
          ex_width_mm: 8.13,
          ex_height_mm: null,
          ex_length_mm: null,
        }),
      ],
      { lumensStated: false, wireStated: false },
    );
    expect(line).toContain("tape cross-section 0.3 in (8 mm) wide");
  });

  it("shows the wire/cord length when a wire predicate was stated", () => {
    const [line] = formatFilterRows([frow({ ex_wire_length_mm: 1828.8 })], {
      lumensStated: false,
      wireStated: true,
    });
    expect(line).toContain("wire/cord 6 ft (1.83 m)");
  });
});

describe("filterCoverageLine", () => {
  it("states the honest windowed denominator verbatim", () => {
    expect(filterCoverageLine(frow(), "catalog")).toBe(
      "Screened the 28 of 30 catalog products that carry data for every stated constraint; " +
        "9 matched. Products missing catalog data for a constraint are excluded, not confirmed to fit.",
    );
  });
});

// --- application hard-filter mapping (0069) ------------------------------------

describe("applicationPatterns", () => {
  it("maps known applications through the synonym table", () => {
    expect(applicationPatterns("vanity")).toEqual(["%vanit%", "%bath%"]);
    expect(applicationPatterns("Under Cabinet")).toEqual(["%under%cab%"]);
    expect(applicationPatterns("undercabinet")).toEqual(["%under%cab%"]);
    expect(applicationPatterns("step")).toEqual(["%step%"]);
    expect(applicationPatterns("picture")).toEqual(["%picture%"]);
    expect(applicationPatterns("island")).toEqual(["%island%", "%linear%pend%"]);
  });

  it("strips trailing light/fixture noise before lookup", () => {
    expect(applicationPatterns("vanity lights")).toEqual(["%vanit%", "%bath%"]);
    expect(applicationPatterns("step light")).toEqual(["%step%"]);
    expect(applicationPatterns("picture lighting")).toEqual(["%picture%"]);
  });

  it("builds a literal pattern from unknown terms (ILIKE wildcards escaped, separators normalized)", () => {
    expect(applicationPatterns("cove")).toEqual(["%cove%"]);
    // "%" is escaped so it matches literally; "_"/"-" normalize to spaces
    // BEFORE escaping (same separator normalization as the synonym lookup).
    expect(applicationPatterns("100% weird_term")).toEqual(["%100\\% weird term%"]);
  });

  it("returns null when no application was stated", () => {
    expect(applicationPatterns(undefined)).toBeNull();
    expect(applicationPatterns("")).toBeNull();
    expect(applicationPatterns("   ")).toBeNull();
  });
});

// --- link guard (canonicalPdp) --------------------------------------------------

describe("canonicalPdp link guard", () => {
  it("rejects brand-site search URLs (legacy ?s= rows) and keeps real pages", () => {
    expect(canonicalPdp("https://www.waclighting.com/?s=3554")).toBeNull();
    expect(canonicalPdp("https://www.waclighting.com/slim-vanity")).toBe(
      "https://www.waclighting.com/slim-vanity",
    );
    expect(canonicalPdp(null)).toBeNull();
    expect(canonicalPdp("")).toBeNull();
  });
});

// --- the tool end-to-end -------------------------------------------------------

describe("filter_products dispatch", () => {
  it("passes p_ args, the embedding, and the clamped count to product_spec_filter", async () => {
    const { ctx, calls } = makeCtx([{ data: [frow()], error: null }]);
    const out = await dispatch(ctx, "filter_products", {
      query: "vanity light",
      max_width_in: 15,
      min_lumens: 1000,
      limit: 100,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("product_spec_filter");
    expect(calls[0]!.params).toMatchObject({
      p_width_max_in: 15,
      p_lumens_min: 1000,
      p_brand: null,
      p_category: null,
      p_class: null,
      p_mounting_type: null,
      p_application_patterns: null, // no application stated
      p_query_text: "vanity light",
      p_match_count: 25, // clamped
    });
    expect(String(calls[0]!.params.p_query_embedding)).toMatch(/^\[/);
    expect(out.content).toContain("Slim Bath & Vanity Light");
    expect(out.content).toContain("Screened the 28 of 30 catalog products");
    expect(out.cards).toEqual([]); // no cards — get_product follows up
  });

  it("appends the MANDATORY product-level-lumens sentence verbatim (O2)", async () => {
    const { ctx } = makeCtx([
      { data: [frow({ lumens: 6342, lumens_source: "product_level" })], error: null },
    ]);
    const out = await dispatch(ctx, "filter_products", { max_width_in: 20, min_lumens: 2000 });
    expect(out.content).toContain(PRODUCT_LEVEL_LUMENS_SENTENCE);
    expect(PRODUCT_LEVEL_LUMENS_SENTENCE).toBe(
      "brightness figures are for the product's highest-output configuration, which may not be the size that fits",
    );
  });

  it("omits the sentence when every row's lumens are the variant's own", async () => {
    const { ctx } = makeCtx([{ data: [frow({ lumens_source: "variant" })], error: null }]);
    const out = await dispatch(ctx, "filter_products", { max_width_in: 20, min_lumens: 1000 });
    expect(out.content).not.toContain(PRODUCT_LEVEL_LUMENS_SENTENCE);
  });

  it("zero-match: relaxes ONLY dimension predicates, width first, and reports a labeled near-miss with NO product card lines", async () => {
    const { ctx, calls } = makeCtx([
      // Original call: nothing matched, counts carried by the null-sku row.
      { data: [countsRow({ in_scope_total: 30, in_scope_screened: 25 })], error: null },
      // Width relaxed: the narrowest option with data is 16.0 in wide.
      {
        data: [
          frow({ sku: "9001", name: "Metro Vanity", q_width_min_in: 16, matched: 3 }),
          frow({ sku: "9002", name: "Fuse Vanity", q_width_min_in: 16.5, matched: 3 }),
        ],
        error: null,
      },
    ]);
    const out = await dispatch(ctx, "filter_products", {
      max_width_in: 15,
      max_depth_in: 4,
      min_lumens: 1000,
    });
    expect(calls).toHaveLength(2);
    // Width relaxed FIRST; every other predicate (incl. depth + lumens) kept.
    expect(calls[1]!.params).toMatchObject({
      p_width_max_in: null,
      p_depth_max_in: 4,
      p_lumens_min: 1000,
    });
    expect(out.content).toContain("No product with recorded dimensions fits");
    expect(out.content).toContain(
      "the narrowest option with data is Metro Vanity (PPID 9001, e.g. order SKU WS-3554-30-BN) at 16.0 in (406 mm) wide",
    );
    expect(out.content).toContain("does NOT meet the stated width requirement");
    // Near-misses are never carded: no product bullet rows in the output.
    expect(out.content).not.toMatch(/^- /m);
    // Honest counts from the ORIGINAL call.
    expect(out.content).toContain("Screened the 25 of 30 catalog products");
  });

  it("zero-match relaxation order: width -> depth -> height (skips unstated dimensions)", async () => {
    const { ctx, calls } = makeCtx([
      { data: [countsRow()], error: null }, // original: 0 matched
      { data: [countsRow()], error: null }, // depth relaxed: still 0
      { data: [frow({ q_height_max_in: 30 })], error: null }, // height relaxed: rows
    ]);
    await dispatch(ctx, "filter_products", { max_depth_in: 1, max_height_in: 2 });
    expect(calls).toHaveLength(3);
    expect(calls[1]!.params).toMatchObject({ p_depth_max_in: null, p_height_max_in: 2 });
    expect(calls[2]!.params).toMatchObject({ p_depth_max_in: 1, p_height_max_in: null });
  });

  it("zero-match from a NON-dimension predicate says plain nothing-fits (no relaxation calls)", async () => {
    const { ctx, calls } = makeCtx([{ data: [countsRow()], error: null }]);
    const out = await dispatch(ctx, "filter_products", { min_lumens: 100000 });
    expect(calls).toHaveLength(1); // never relaxes a lumens zero
    expect(out.content).toContain("Nothing in the catalog fits all of those requirements.");
    expect(out.content).toContain("excluded, not confirmed to fit");
  });

  it("empty SCOPE from a brand/category filter re-runs without it and explains (free-text idiom)", async () => {
    const { ctx, calls } = makeCtx([
      { data: [countsRow({ in_scope_total: 0, in_scope_screened: 0 })], error: null },
      { data: [frow()], error: null },
    ]);
    const out = await dispatch(ctx, "filter_products", {
      max_width_in: 15,
      category: "Vanity & Bath Bars",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.params).toMatchObject({ p_category: "Vanity & Bath Bars" });
    expect(calls[1]!.params).toMatchObject({ p_category: null, p_brand: null });
    expect(out.content).toContain("free text");
    expect(out.content).toContain("Slim Bath & Vanity Light");
  });

  it("passes mounting_type through and KEEPS it on the free-text scope retry (0068: authoritative, not free text)", async () => {
    const { ctx, calls } = makeCtx([
      { data: [countsRow({ in_scope_total: 0, in_scope_screened: 0 })], error: null },
      { data: [frow({ class: "downlight", category: "Recessed Downlights" })], error: null },
    ]);
    const out = await dispatch(ctx, "filter_products", {
      max_width_in: 4,
      brand: "WACC", // free-text miss — dropped on retry
      mounting_type: "Recessed Downlights",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.params).toMatchObject({
      p_brand: "WACC",
      p_mounting_type: "Recessed Downlights",
    });
    // Retry drops the free-text brand but NEVER the enumerated mounting type.
    expect(calls[1]!.params).toMatchObject({
      p_brand: null,
      p_category: null,
      p_mounting_type: "Recessed Downlights",
    });
    // The coverage scope names the mounting type.
    expect(out.content).toContain("Recessed Downlights");
  });

  it("with NO numeric predicate falls back to a plain catalog search (never an unconstrained dump)", async () => {
    const { ctx, calls } = makeCtx([
      { data: [{ sku: "2010", name: "Aurora Downlight", brand: "WAC Lighting" }], error: null },
    ]);
    const out = await dispatch(ctx, "filter_products", { query: "warm downlight" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("product_semantic_search");
    expect(out.content).toContain("No numeric constraints were stated");
    expect(out.content).toContain("Aurora Downlight");
  });

  it("with neither predicates nor query asks for one (and calls nothing)", async () => {
    const { ctx, calls } = makeCtx([]);
    const out = await dispatch(ctx, "filter_products", {});
    expect(calls).toHaveLength(0);
    expect(out.content).toContain("state at least one numeric constraint");
  });

  it("surfaces RPC errors", async () => {
    const { ctx } = makeCtx([{ data: null, error: { message: "boom" } }]);
    const out = await dispatch(ctx, "filter_products", { max_width_in: 15 });
    expect(out.content).toContain("filter_products error: boom");
  });

  it("passes the mapped application patterns through to the RPC (0069 hard-filter)", async () => {
    const { ctx, calls } = makeCtx([{ data: [frow()], error: null }]);
    await dispatch(ctx, "filter_products", {
      query: "vanity light",
      application: "vanity",
      max_width_in: 15,
    });
    expect(calls[0]!.params).toMatchObject({
      p_application_patterns: ["%vanit%", "%bath%"],
    });
  });

  it("keeps the application filter through relaxation and says the exclusion out loud on an empty result", async () => {
    const { ctx, calls } = makeCtx([
      { data: [countsRow()], error: null }, // original: 0 matched
      { data: [countsRow()], error: null }, // width relaxed: still 0
    ]);
    const out = await dispatch(ctx, "filter_products", {
      application: "vanity",
      max_width_in: 5,
    });
    // The application is a REQUIREMENT: present on every call, never relaxed.
    expect(calls[0]!.params).toMatchObject({ p_application_patterns: ["%vanit%", "%bath%"] });
    expect(calls[1]!.params).toMatchObject({
      p_application_patterns: ["%vanit%", "%bath%"],
      p_width_max_in: null,
    });
    expect(out.content).toContain(
      "Only vanity products (matched by name or category) were considered; other fixture types were excluded.",
    );
    // The coverage scope names the application too.
    expect(out.content).toContain("vanity products that carry data");
  });

  it("passes mounting_type AND application together, both kept through relaxation and the brand rescope", async () => {
    const { ctx, calls } = makeCtx([
      { data: [countsRow({ in_scope_total: 0, in_scope_screened: 0 })], error: null }, // brand scope empty
      { data: [countsRow()], error: null }, // rescoped: 0 matched
      { data: [countsRow()], error: null }, // width relaxed: still 0
    ]);
    await dispatch(ctx, "filter_products", {
      brand: "WAC Lighting",
      mounting_type: "Wall Lighting",
      application: "vanity",
      max_width_in: 15,
    });
    const both = { p_mounting_type: "Wall Lighting", p_application_patterns: ["%vanit%", "%bath%"] };
    expect(calls[0]!.params).toMatchObject({ ...both, p_brand: "WAC Lighting" });
    expect(calls[1]!.params).toMatchObject({ ...both, p_brand: null }); // rescope drops brand only
    expect(calls[2]!.params).toMatchObject({ ...both, p_width_max_in: null }); // relaxation drops the dim only
  });

  it("renders product names as markdown links from pdp_urls, guarded by canonicalPdp", async () => {
    const linked = makeCtx(
      [{ data: [frow()], error: null }],
      [{ sku: "3554", url: "https://www.waclighting.com/slim-vanity" }],
    );
    const out = await dispatch(linked.ctx, "filter_products", { max_width_in: 20 });
    expect(out.content).toContain(
      "[Slim Bath & Vanity Light](https://www.waclighting.com/slim-vanity)",
    );

    // A legacy search-result url is never a link (canonicalPdp guard).
    const searchy = makeCtx(
      [{ data: [frow()], error: null }],
      [{ sku: "3554", url: "https://www.waclighting.com/?s=3554" }],
    );
    const out2 = await dispatch(searchy.ctx, "filter_products", { max_width_in: 20 });
    expect(out2.content).not.toContain("](");
    expect(out2.content).toContain("- Slim Bath & Vanity Light (PPID 3554");
  });
});

// --- flag gating + public surface ---------------------------------------------

describe("THOM_SPEC_FILTER gating", () => {
  it("is off unless the flag is exactly '1'", () => {
    expect(specFilterEnabled(env())).toBe(false);
    expect(specFilterEnabled(env({ THOM_SPEC_FILTER: "0" }))).toBe(false);
    expect(specFilterEnabled(env({ THOM_SPEC_FILTER: "1" }))).toBe(true);
  });

  it("composes the tool on BOTH surfaces only when the flag is on", () => {
    for (const surface of ["internal", "public"] as const) {
      const off = composeTools(surface, env()).map((t) => t.name);
      expect(off).not.toContain("filter_products");
      const on = composeTools(surface, env({ THOM_SPEC_FILTER: "1" })).map((t) => t.name);
      expect(on).toContain("filter_products");
    }
  });

  it("appends the search_products back-pointer ONLY when the flag is on (O3/R3)", () => {
    for (const surface of ["internal", "public"] as const) {
      const off = composeTools(surface, env()).find((t) => t.name === "search_products")!;
      expect(off.description).not.toContain("filter_products");
      const on = composeTools(surface, env({ THOM_SPEC_FILTER: "1" })).find(
        (t) => t.name === "search_products",
      )!;
      expect(on.description).toContain(SEARCH_PRODUCTS_FILTER_POINTER.trim());
    }
    // The shared TOOLS constant is never mutated.
    expect(TOOLS.find((t) => t.name === "search_products")!.description).not.toContain(
      "filter_products",
    );
    expect(withConstraintRouting(TOOLS)).not.toBe(TOOLS);
  });

  it("is on the public dispatch allowlist and dispatches on the public surface", async () => {
    expect(PUBLIC_TOOL_NAMES.has("filter_products")).toBe(true);
    expect(FILTER_TOOLS.map((t) => t.name)).toEqual(["filter_products"]);
    const { ctx, calls } = makeCtx([{ data: [frow()], error: null }]);
    const out = await dispatch(ctx, "filter_products", { max_width_in: 15 }, { surface: "public" });
    expect(calls).toHaveLength(1); // reached the RPC — not surface-rejected
    expect(out.content).not.toContain("not available on this surface");
  });

  it("the class enum now carries the wall and ceiling buckets (O9)", () => {
    expect(SPEC_RANK_CLASSES).toContain("wall");
    expect(SPEC_RANK_CLASSES).toContain("ceiling");
    const schema = FILTER_TOOLS[0]!.input_schema as { properties: Record<string, { enum?: string[] }> };
    expect(schema.properties.class!.enum).toContain("wall");
  });

  it("the tool description carries the O3b routing sentence", () => {
    expect(FILTER_TOOLS[0]!.description).toContain(
      "Use this for ANY question that states a numeric limit",
    );
    expect(FILTER_TOOLS[0]!.description).toContain("instead of search_products");
  });

  it("the mounting_type param enumerates the REAL zmntyp vocabulary (0068)", () => {
    const schema = FILTER_TOOLS[0]!.input_schema as {
      properties: Record<string, { enum?: string[]; description?: string }>;
    };
    const mt = schema.properties.mounting_type!;
    expect(mt.enum).toEqual([...MOUNTING_TYPE_VALUES]);
    expect(mt.enum).toContain("Recessed Downlights");
    expect(mt.enum).toContain("Inground Lighting");
    expect(mt.enum).not.toContain("VENTRIX"); // brand junk, remapped at sync
    // The description carries the downlight vs in-ground/landscape rule.
    expect(mt.description).toContain("'Recessed Downlights'");
    expect(mt.description).toContain("NOT downlights");
  });
});

// --- get_product per-size dims (O1) --------------------------------------------

const dimRow = (over: Partial<ProductDimRow> = {}): ProductDimRow => ({
  variant_sku: "WS-3554-30-BN",
  finish: "Brushed Nickel",
  width_mm: 66.04,
  height_mm: 127,
  length_mm: 457.2,
  diameter_mm: null,
  wire_length_mm: null,
  width_in: 18,
  depth_in: 2.6,
  height_in: 5,
  class: "wall",
  ...over,
});

describe("formatProductDims (O1)", () => {
  it("prints a Sizes: block with recorded axes AND the derived width/depth the filter uses, dual-unit", () => {
    const lines = formatProductDims([
      dimRow(),
      dimRow({ variant_sku: "WS-3554-30-BK", finish: "Black" }), // same size, other finish -> collapsed
      dimRow({ variant_sku: "WS-3554-36-BN", length_mm: 609.6, width_in: 24 }),
    ]);
    expect(lines[0]).toBe("Sizes:");
    expect(lines).toHaveLength(3); // header + 2 distinct sizes
    expect(lines[1]).toBe(
      "- 18.0 in (457 mm) wide, 2.6 in (66 mm) deep, 5.0 in (127 mm) tall " +
        "(recorded W 2.6 in (66 mm) x H 5.0 in (127 mm) x L 18.0 in (457 mm))",
    );
    expect(lines[2]).toContain("24.0 in (610 mm) wide");
  });

  it("adds the wire/cord line when present, dual-unit ft (m)", () => {
    const lines = formatProductDims([dimRow({ wire_length_mm: 1828.8 })]);
    expect(lines[lines.length - 1]).toBe("Wire/cord length: 6 ft (1.83 m)");
  });

  it("prints the explicit no-recorded-dimensions line when the catalog has none (the O8 unknown case)", () => {
    expect(formatProductDims([])).toEqual([
      "No recorded dimensions in the catalog for this product.",
    ]);
    expect(
      formatProductDims([
        dimRow({ width_mm: null, height_mm: null, length_mm: null, diameter_mm: null }),
      ]),
    ).toEqual(["No recorded dimensions in the catalog for this product."]);
  });
});

/** Thenable query-builder fake for the get_product read path. */
function fakeSb(handlers: Record<string, () => unknown>, tablesHit: string[]) {
  return {
    from(table: string) {
      tablesHit.push(table);
      const result = () =>
        Promise.resolve(handlers[table]?.() ?? { data: [], error: null, count: 0 });
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "ilike", "in", "limit", "order"]) {
        b[m] = () => b;
      }
      b.maybeSingle = () => result();
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        result().then(res, rej);
      return b;
    },
    rpc: () => Promise.resolve({ data: [], error: null }),
  };
}

describe("get_product dimension surface (O1, flag-gated)", () => {
  const handlers = (dims: ProductDimRow[]) => ({
    products: () => ({
      data: { sku: "3554", name: "Slim Bath & Vanity Light", brand: "WAC Lighting", category: null, primary_image_url: null, variants: [] },
      error: null,
    }),
    product_variant_spec_view: () => ({ data: dims, error: null }),
  });

  it("reads the 0063 view and prints the Sizes block when THOM_SPEC_FILTER=1", async () => {
    const tables: string[] = [];
    const ctx = {
      env: env({ THOM_SPEC_FILTER: "1" }),
      sb: fakeSb(handlers([dimRow(), dimRow({ wire_length_mm: 1828.8 })]), tables) as unknown as ToolContext["sb"],
    } as ToolContext;
    const out = await dispatch(ctx, "get_product", { sku: "3554" });
    expect(tables).toContain("product_variant_spec_view");
    expect(out.content).toContain("Sizes:");
    expect(out.content).toContain("18.0 in (457 mm) wide");
    expect(out.content).toContain("recorded W 2.6 in (66 mm)");
    expect(out.content).toContain("Wire/cord length: 6 ft (1.83 m)");
  });

  it("prints the explicit no-recorded-dimensions line for a dimensionless product", async () => {
    const tables: string[] = [];
    const ctx = {
      env: env({ THOM_SPEC_FILTER: "1" }),
      sb: fakeSb(handlers([]), tables) as unknown as ToolContext["sb"],
    } as ToolContext;
    const out = await dispatch(ctx, "get_product", { sku: "3554" });
    expect(out.content).toContain("No recorded dimensions in the catalog for this product.");
  });

  it("does NOT touch the view when the flag is off (dark launch)", async () => {
    const tables: string[] = [];
    const ctx = {
      env: env(),
      sb: fakeSb(handlers([dimRow()]), tables) as unknown as ToolContext["sb"],
    } as ToolContext;
    const out = await dispatch(ctx, "get_product", { sku: "3554" });
    expect(tables).not.toContain("product_variant_spec_view");
    expect(out.content).not.toContain("Sizes:");
  });
});
