import { describe, expect, it } from "vitest";
import { classifyLayoutKind, downsampleHeatmap, planLayout } from "./layoutTool.js";
import type { LayoutCard, ToolContext } from "./types.js";

/** Per-table canned responses. Each entry returns { data, error } for any
 *  query against that table (the builder ignores which filters were applied —
 *  the tool's queries are simple enough that per-table data suffices). */
type TableData = Record<string, { data: unknown; error: unknown }>;

function fakeCtx(tables: TableData): ToolContext {
  const sb = {
    from(table: string) {
      const resolve = () => tables[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve(resolve()),
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve(resolve()).then(onF, onR),
      };
      return builder;
    },
  };
  return { env: {} as ToolContext["env"], sb: sb as unknown as ToolContext["sb"] };
}

const TRACK_PRODUCT = {
  sku: "HEAD-1",
  name: "FlexRail Head",
  family: "flexrail track head",
  category: "Track System",
  variants: [{ watts: 15 }],
};

// A representative photometrics row whose ies_url is a zip ref (contains '#'),
// so the tool skips the fetch and uses the lumen-method degrade with lumens=600.
const PHOTO_ROWS = {
  data: [
    {
      ies_url: "https://cdn.example.com/flexrail.zip#inner/head.ies",
      is_representative: true,
      ies_metrics: { metrics: { lumens: 600, inputWatts: 15 } },
    },
  ],
  error: null,
};

const TRACK_SYSTEMS = {
  data: [
    {
      key: "flexrail-lv",
      label: "FlexRail LV",
      track_type: "FLEXRAIL",
      voltage_class: "low",
      segment_lengths_ft: [8, 4, 2],
      feed_capacity_w: 300,
      max_heads_per_run: null,
      default_head_spacing_ft: 4,
      compatible_head_track_types: ["FLEXRAIL"],
    },
  ],
  error: null,
};

const TRACK_COMPONENTS = {
  data: [
    { role: "channel", sku: "CH-8", segment_length_ft: 8, description: "8 ft channel" },
    { role: "channel", sku: "CH-2", segment_length_ft: 2, description: "2 ft channel" },
    { role: "head", sku: "HEAD-1", head_watts: 15 },
    { role: "feed", sku: "FEED-LV" },
    { role: "connector", sku: "CONN-LV" },
    { role: "endcap", sku: "END-LV" },
    { role: "transformer", sku: "XFMR-300", capacity_w: 300 },
  ],
  error: null,
};

const INPUT = { space: { length_ft: 20, width_ft: 10, mounting_height_ft: 9 }, product: { sku: "HEAD-1" } };

describe("classifyLayoutKind", () => {
  it("routes track / tape / else", () => {
    expect(classifyLayoutKind("Outdoor Track", "Track System")).toBe("track");
    expect(classifyLayoutKind("InvisiLED Pro", "Tape Light")).toBe("linear");
    expect(classifyLayoutKind("Aether", "Recessed Downlight")).toBe("area-grid");
  });
});

describe("downsampleHeatmap", () => {
  it("caps a large grid to ≤16×16 and reports min/max", () => {
    const big = Array.from({ length: 51 }, (_, r) => Array.from({ length: 51 }, (_, c) => r + c));
    const hm = downsampleHeatmap(big, 16)!;
    expect(hm.rows).toBeLessThanOrEqual(16);
    expect(hm.cols).toBeLessThanOrEqual(16);
    expect(hm.max).toBeGreaterThan(hm.min);
  });
});

describe("plan_layout — track system resolved", () => {
  it("emits a track LayoutCard with a seeded BOM", async () => {
    const ctx = fakeCtx({
      products: { data: TRACK_PRODUCT, error: null },
      product_photometrics: PHOTO_ROWS,
      track_systems: TRACK_SYSTEMS,
      track_components: TRACK_COMPONENTS,
    });
    const out = await planLayout(ctx, INPUT);
    expect(out.cards).toHaveLength(1);
    const card = out.cards[0] as LayoutCard;
    expect(card.kind).toBe("layout");
    expect(card.layoutKind).toBe("track");
    expect(card.summary.headCount).toBeGreaterThan(0);
    // Seeded component SKUs made it into the BOM.
    const skus = card.bom.lines.map((l) => l.sku);
    expect(skus).toContain("HEAD-1");
    expect(skus).toContain("FEED-LV");
    expect(skus.some((s) => s === "CH-8" || s === "CH-2")).toBe(true);
    expect(out.content).toContain("Bill of materials");
  });
});

describe("plan_layout — missing system degrades gracefully", () => {
  it("still emits a card but with a generic, sku-null parts list + a note", async () => {
    const ctx = fakeCtx({
      products: { data: TRACK_PRODUCT, error: null },
      product_photometrics: PHOTO_ROWS,
      track_systems: { data: [], error: null }, // no seeded systems
      track_components: { data: [], error: null },
    });
    const out = await planLayout(ctx, INPUT);
    const card = out.cards[0] as LayoutCard;
    expect(card.layoutKind).toBe("track");
    expect(card.bom.lines.every((l) => l.sku === null)).toBe(true);
    expect(card.warnings.some((w) => /no matching track system/i.test(w))).toBe(true);
  });
});

describe("plan_layout — area-grid without photometrics", () => {
  it("returns a graceful note and no card when the head IES isn't on file", async () => {
    const ctx = fakeCtx({
      products: {
        data: { sku: "DL-1", name: "Aether 3\"", family: "aether", category: "Recessed Downlight", variants: [{ watts: 12 }] },
        error: null,
      },
      product_photometrics: { data: [], error: null },
    });
    const out = await planLayout(ctx, { space: { length_ft: 14, width_ft: 12 }, product: { sku: "DL-1" } });
    expect(out.cards).toHaveLength(0);
    expect(out.content.toLowerCase()).toContain("photometrics");
  });
});
