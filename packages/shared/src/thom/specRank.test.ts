import { describe, expect, it } from "vitest";
import { composeTools, specRankEnabled } from "./agent.js";
import { dispatch, MOUNTING_TYPE_VALUES, PUBLIC_TOOL_NAMES, SPEC_RANK_TOOLS } from "./tools.js";
import type { ThomEnv } from "./env.js";
import type { ToolContext } from "./types.js";

const env = (over: Partial<ThomEnv> = {}): ThomEnv => over as ThomEnv;

/** One product_spec_rank RPC row. */
interface RpcRow {
  sku: string;
  name: string | null;
  brand: string | null;
  category: string | null;
  class: string;
  metric_value: number;
  lumens_source: string | null;
  per_ft: boolean;
  class_rank: number;
  in_scope_ranked: number;
  in_scope_total: number;
}
const rpcRow = (over: Partial<RpcRow> = {}): RpcRow => ({
  sku: "452",
  name: "Endurance Flood Pro Wallpack",
  brand: "WAC Lighting",
  category: "Outdoor",
  class: "outdoor",
  metric_value: 2071,
  lumens_source: "ies",
  per_ft: false,
  class_rank: 1,
  in_scope_ranked: 2497,
  in_scope_total: 4390,
  ...over,
});

/** Fake ctx whose sb.rpc records every call and returns queued results. */
function makeCtx(results: { data: unknown; error: { message: string } | null }[]) {
  const calls: { fn: string; params: Record<string, unknown> }[] = [];
  const sb = {
    rpc(fn: string, params: Record<string, unknown>) {
      calls.push({ fn, params });
      return Promise.resolve(results[calls.length - 1] ?? { data: [], error: null });
    },
  };
  const ctx = { env: env(), sb: sb as unknown as ToolContext["sb"] } as ToolContext;
  return { ctx, calls };
}

describe("rank_products_by_spec output", () => {
  it("renders NAME-FIRST rows in per-class sections with source tags + the coverage line", async () => {
    const { ctx, calls } = makeCtx([
      {
        data: [
          rpcRow(),
          rpcRow({ sku: "881", name: "Silo Flood", metric_value: 1800, lumens_source: "sales_layer", class_rank: 2 }),
          rpcRow({ sku: "77", name: "Paloma Track Head", class: "track", metric_value: 1033, lumens_source: "sales_layer" }),
        ],
        error: null,
      },
    ]);
    const out = await dispatch(ctx, "rank_products_by_spec", { metric: "lumens" });

    // RPC args: defaults (desc, grouped, no filters, cap 10).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("product_spec_rank");
    expect(calls[0]!.params).toEqual({
      metric: "lumens",
      dir: "desc",
      brand_filter: null,
      category_filter: null,
      class_filter: null,
      mounting_type_filter: null,
      per_ft_filter: false,
      grouped: true,
      match_count: 10,
    });

    // Name-first rows (never a bare leading catalog number) with the IES vs
    // catalog source tag, under per-class section headers.
    expect(out.content).toContain(
      "- Endurance Flood Pro Wallpack (SKU 452, WAC Lighting, outdoor): 2,071 lm [IES-measured]",
    );
    expect(out.content).toContain("- Silo Flood (SKU 881, WAC Lighting, outdoor): 1,800 lm [catalog-listed]");
    expect(out.content).toContain("outdoor:\n");
    expect(out.content).toContain("track:\n- Paloma Track Head");

    // Honest coverage line from the RPC's windowed counts.
    expect(out.content).toContain(
      "Ranked among the 2,497 of 4,390 catalog products with output data; " +
        "per-foot products (tape/strip) are ranked separately by watts/ft.",
    );
    // No cards/citations — the model follows up with get_product.
    expect(out.cards).toEqual([]);
    expect(out.citations).toEqual([]);
  });

  it("maps direction 'lowest' to asc, clamps the limit, and passes filters through flat (class-pinned) mode", async () => {
    const { ctx, calls } = makeCtx([
      { data: [rpcRow({ class: "downlight", metric_value: 4.5, in_scope_ranked: 12, in_scope_total: 40 })], error: null },
    ]);
    const out = await dispatch(ctx, "rank_products_by_spec", {
      metric: "watts",
      direction: "lowest",
      brand: "WAC Lighting",
      class: "downlight",
      limit: 100,
    });
    expect(calls[0]!.params).toEqual({
      metric: "watts",
      dir: "asc",
      brand_filter: "WAC Lighting",
      category_filter: null,
      class_filter: "downlight",
      mounting_type_filter: null,
      per_ft_filter: false,
      grouped: false, // a pinned class is one section — flat top-N
      match_count: 25,
    });
    expect(out.content).toContain("4.5 W");
    expect(out.content).not.toContain("[catalog-listed]"); // tag is lumens-only
    // Scope names the filters in the coverage line.
    expect(out.content).toContain("Ranked among the 12 of 40 WAC Lighting downlight products");
  });

  it("ranks per-foot products by watts/ft with the per-foot coverage phrasing", async () => {
    const { ctx, calls } = makeCtx([
      {
        data: [
          rpcRow({
            sku: "T24",
            name: "InvisiLED Pro High Output Tape",
            class: "per-foot",
            metric_value: 5.5,
            lumens_source: null,
            per_ft: true,
            in_scope_ranked: 150,
            in_scope_total: 180,
          }),
        ],
        error: null,
      },
    ]);
    const out = await dispatch(ctx, "rank_products_by_spec", { metric: "watts", per_foot: true });
    expect(calls[0]!.params).toMatchObject({ per_ft_filter: true, grouped: false });
    expect(out.content).toContain("- InvisiLED Pro High Output Tape (SKU T24, WAC Lighting, per-foot): 5.5 W/ft");
    expect(out.content).toContain(
      "Ranked among the 150 of 180 catalog per-foot (tape/strip) products with watts/ft data.",
    );
  });

  it("passes mounting_type through as the authoritative fixture-type filter (0068), flat mode", async () => {
    const { ctx, calls } = makeCtx([
      {
        data: [rpcRow({ class: "downlight", metric_value: 3000, in_scope_ranked: 200, in_scope_total: 509 })],
        error: null,
      },
    ]);
    const out = await dispatch(ctx, "rank_products_by_spec", {
      metric: "lumens",
      mounting_type: "Recessed Downlights",
    });
    expect(calls[0]!.params).toMatchObject({
      mounting_type_filter: "Recessed Downlights",
      class_filter: null,
      grouped: false, // a pinned mounting type is one section — flat top-N
    });
    // The coverage scope names the mounting type.
    expect(out.content).toContain("Recessed Downlights");
  });

  it("empty FILTERED result: explains free-text categories and falls back to the unfiltered grouped rank", async () => {
    const { ctx, calls } = makeCtx([
      { data: [], error: null }, // filtered call comes back empty
      { data: [rpcRow()], error: null }, // unfiltered grouped fallback
    ]);
    const out = await dispatch(ctx, "rank_products_by_spec", {
      metric: "lumens",
      category: "Wallpacks & Floods",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.params).toMatchObject({ category_filter: "Wallpacks & Floods" });
    expect(calls[1]!.params).toMatchObject({
      brand_filter: null,
      category_filter: null,
      class_filter: null,
      grouped: true,
    });
    // Never implies the data doesn't exist — names the free-text cause and
    // still delivers the catalog-wide rank.
    expect(out.content).toContain("free text");
    expect(out.content).toContain("Endurance Flood Pro Wallpack");
    expect(out.content).toContain("catalog products with output data");
  });

  it("empty UNFILTERED result says the data isn't indexed (single call)", async () => {
    const { ctx, calls } = makeCtx([{ data: [], error: null }]);
    const out = await dispatch(ctx, "rank_products_by_spec", { metric: "efficacy" });
    expect(calls).toHaveLength(1);
    expect(out.content).toContain("No products carry numeric efficacy data");
  });

  it("rejects an unknown metric without calling the RPC, and surfaces RPC errors", async () => {
    const bad = makeCtx([]);
    const out = await dispatch(bad.ctx, "rank_products_by_spec", { metric: "sparkle" });
    expect(out.content).toContain("metric must be lumens, watts, or efficacy");
    expect(bad.calls).toHaveLength(0);

    const err = makeCtx([{ data: null, error: { message: "boom" } }]);
    const out2 = await dispatch(err.ctx, "rank_products_by_spec", { metric: "lumens" });
    expect(out2.content).toContain("rank_products_by_spec error: boom");
  });
});

describe("mounting_type schema (0068)", () => {
  it("enumerates the REAL zmntyp vocabulary and names the downlight/landscape split", () => {
    const schema = SPEC_RANK_TOOLS[0]!.input_schema as {
      properties: Record<string, { enum?: string[]; description?: string }>;
    };
    const mt = schema.properties.mounting_type!;
    expect(mt.enum).toEqual([...MOUNTING_TYPE_VALUES]);
    expect(mt.enum).toContain("Recessed Downlights");
    expect(mt.enum).toContain("Landscape Lighting");
    expect(mt.enum).toContain("Inground Lighting");
    // VENTRIX is brand junk, remapped at sync — never a legal filter value.
    expect(mt.enum).not.toContain("VENTRIX");
    expect(mt.description).toContain("NOT downlights");
    // class is explicitly demoted to the coarse derived bucket.
    expect(schema.properties.class!.description).toMatch(/mounting_type is the authoritative/);
  });
});

describe("THOM_SPEC_RANK gating", () => {
  it("is off unless the flag is exactly '1'", () => {
    expect(specRankEnabled(env())).toBe(false);
    expect(specRankEnabled(env({ THOM_SPEC_RANK: "0" }))).toBe(false);
    expect(specRankEnabled(env({ THOM_SPEC_RANK: "1" }))).toBe(true);
  });

  it("composes the tool on BOTH surfaces only when the flag is on", () => {
    for (const surface of ["internal", "public"] as const) {
      const off = composeTools(surface, env()).map((t) => t.name);
      expect(off).not.toContain("rank_products_by_spec");
      const on = composeTools(surface, env({ THOM_SPEC_RANK: "1" })).map((t) => t.name);
      expect(on).toContain("rank_products_by_spec");
    }
  });

  it("is on the public dispatch allowlist and dispatches on the public surface", async () => {
    expect(PUBLIC_TOOL_NAMES.has("rank_products_by_spec")).toBe(true);
    expect(SPEC_RANK_TOOLS.map((t) => t.name)).toEqual(["rank_products_by_spec"]);
    const { ctx, calls } = makeCtx([{ data: [rpcRow()], error: null }]);
    const out = await dispatch(ctx, "rank_products_by_spec", { metric: "lumens" }, { surface: "public" });
    expect(calls).toHaveLength(1); // reached the RPC — not surface-rejected
    expect(out.content).not.toContain("not available on this surface");
  });
});
