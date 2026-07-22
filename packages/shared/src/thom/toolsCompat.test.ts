// =============================================================================
// Compatibility / accessories tool tests (plan v2.1 §B/§E): grouped-parent
// collapse + caps, the reverse-fit two-branch fallback + fan-in rollup,
// explicit-first get_related sections, and the public unresolved-code framing.
// =============================================================================
import { describe, expect, it } from "vitest";
import {
  composeRelatedSections,
  dispatch,
  formatAccessoryLines,
  MAX_ACCESSORY_LINES,
  MAX_REVERSE_FAMILIES,
  rollupReverseFit,
  type AccessoryParentInfo,
  type ProductAccessoryRow,
  type ReverseFitParent,
} from "./tools.js";
import type { ToolContext } from "./types.js";

const accRow = (over: Partial<ProductAccessoryRow> = {}): ProductAccessoryRow => ({
  related_sku: "CODE-1",
  related_product_sku: null,
  kind: "accessory",
  label: null,
  ...over,
});

// --- formatAccessoryLines (PL5 grouped-parent collapse + PL8a public shape) --

describe("formatAccessoryLines", () => {
  it("collapses N finish-variant codes of one resolved parent into ONE line", () => {
    const rows = Array.from({ length: 11 }, (_, i) =>
      accRow({ related_sku: `LENS-16-${i}`, related_product_sku: "528" }),
    );
    const parents = new Map<string, AccessoryParentInfo>([
      ["528", { name: "Colored Lens Accessory", brand: "WAC Lighting" }],
    ]);
    const lines = formatAccessoryLines(rows, parents, "internal");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Colored Lens Accessory");
    expect(lines[0]).toContain("PPID 528"); // numeric catalog id is the internal PPID, never "SKU"
    expect(lines[0]).toContain("WAC Lighting");
    expect(lines[0]).toContain("11 options");
    // Option codes capped at 8 shown.
    expect(lines[0]).toContain("+3 more");
  });

  it("keeps kinds visible and separates parents", () => {
    const rows = [
      accRow({ related_sku: "A", related_product_sku: "P1", kind: "accessory" }),
      accRow({ related_sku: "B", related_product_sku: "P2", kind: "component" }),
      accRow({ related_sku: "C", related_product_sku: "P3", kind: "replacement_part" }),
    ];
    const lines = formatAccessoryLines(rows, new Map(), "internal");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("[accessory]");
    expect(lines[1]).toContain("[component]");
    expect(lines[2]).toContain("[replacement part]");
  });

  it("caps rendered lines at MAX_ACCESSORY_LINES with a +N more tail (AA13)", () => {
    const rows = Array.from({ length: MAX_ACCESSORY_LINES + 5 }, (_, i) =>
      accRow({ related_sku: `C${i}`, related_product_sku: `P${i}` }),
    );
    const lines = formatAccessoryLines(rows, new Map(), "internal");
    expect(lines).toHaveLength(MAX_ACCESSORY_LINES + 1);
    expect(lines[lines.length - 1]).toBe("(+5 more)");
  });

  it("INTERNAL shows unresolved raw codes, with the paired label when present", () => {
    const rows = [
      accRow({ related_sku: "F-RCBT-WT", label: "Bluetooth Remote Control" }),
      accRow({ related_sku: "MYSTERY-9", kind: "replacement_part" }),
    ];
    const lines = formatAccessoryLines(rows, new Map(), "internal");
    expect(lines[0]).toContain("Bluetooth Remote Control (code F-RCBT-WT)");
    expect(lines[1]).toContain("Code MYSTERY-9");
  });

  it("PUBLIC never surfaces a bare unresolved code (PL8a): labels stay, codes become the sales-rep line", () => {
    const rows = [
      accRow({ related_sku: "F-RCBT-WT", label: "Bluetooth Remote Control" }),
      accRow({ related_sku: "MYSTERY-9" }),
      accRow({ related_sku: "MYSTERY-10" }),
      accRow({ related_sku: "RP-77", kind: "replacement_part" }),
    ];
    const lines = formatAccessoryLines(rows, new Map(), "public");
    const joined = lines.join("\n");
    // Raw codes must not appear.
    for (const code of ["F-RCBT-WT", "MYSTERY-9", "MYSTERY-10", "RP-77"]) {
      expect(joined).not.toContain(code);
    }
    // Labeled row keeps its human name; label-less rows aggregate per kind.
    expect(joined).toContain("Bluetooth Remote Control");
    expect(joined).toContain("2 additional accessories available through your WAC Group sales rep");
    expect(joined).toContain("1 additional replacement part available through your WAC Group sales rep");
  });

  it("resolved rows still show orderable option codes on the public surface", () => {
    const rows = [accRow({ related_sku: "XL-DR-BN", related_product_sku: "FAN-DR" })];
    const lines = formatAccessoryLines(
      rows,
      new Map([["FAN-DR", { name: "Downrod", brand: "Modern Forms" }]]),
      "public",
    );
    expect(lines[0]).toContain("Downrod");
    expect(lines[0]).toContain("XL-DR-BN");
  });
});

// --- rollupReverseFit (PL1b fan-in) ------------------------------------------

const parent = (sku: string, over: Partial<ReverseFitParent> = {}): ReverseFitParent => ({
  sku,
  name: `Name ${sku}`,
  family: null,
  brand: null,
  ...over,
});

describe("rollupReverseFit", () => {
  it("names hosts individually when there are 5 or fewer", () => {
    const out = rollupReverseFit([parent("100"), parent("200")], 2);
    expect(out).toBe("Fits 2 products: Name 100 (PPID 100), Name 200 (PPID 200).");
  });

  it("rolls large fan-in up BY FAMILY with counts, never a PPID list", () => {
    const parents = [
      ...Array.from({ length: 50 }, (_, i) => parent(`Q${i}`, { family: "QUARTUS", brand: "AiSpire" })),
      ...Array.from({ length: 39 }, (_, i) => parent(`A${i}`, { family: "Adjusto", brand: "AiSpire" })),
    ];
    const out = rollupReverseFit(parents, 89);
    expect(out).toContain("Fits 89 AiSpire products");
    expect(out).toContain("QUARTUS (50)");
    expect(out).toContain("Adjusto (39)");
    // Name-first: no host PPID enumeration.
    expect(out).not.toContain("SKU Q1");
  });

  it("caps enumerated families at MAX_REVERSE_FAMILIES", () => {
    const parents = Array.from({ length: MAX_REVERSE_FAMILIES + 4 }, (_, i) =>
      parent(`S${i}`, { family: `FAM-${i}` }),
    );
    const out = rollupReverseFit(parents, parents.length);
    expect(out).toContain("and 4 more families");
    expect((out.match(/FAM-/g) ?? []).length).toBe(MAX_REVERSE_FAMILIES);
  });

  it("returns empty for no parents", () => {
    expect(rollupReverseFit([], 0)).toBe("");
  });
});

// --- composeRelatedSections (AA12 explicit-first) ----------------------------

describe("composeRelatedSections", () => {
  it("puts the confirmed section FIRST with its own count, then the verify-fitment section", () => {
    const out = composeRelatedSections({
      sku: "5010",
      explicitLines: ["- Lens (SKU 528) [accessory]"],
      explicitCount: 3,
      familyScope: 'family "Cirrus"',
      familyLines: ["- 5011 — Cirrus Channel"],
      familyCount: 12,
    });
    const confirmedAt = out.indexOf("Confirmed accessories and components for 5010 (3 references, from catalog reference data):");
    const familyAt = out.indexOf('Same family or category, verify fitment (12 products in family "Cirrus"):');
    expect(confirmedAt).toBe(0);
    expect(familyAt).toBeGreaterThan(confirmedAt);
  });

  it("renders a single section when the other is empty", () => {
    expect(
      composeRelatedSections({
        sku: "X",
        explicitLines: [],
        explicitCount: 0,
        familyScope: 'category "Track"',
        familyLines: ["- A — B"],
        familyCount: 1,
      }),
    ).not.toContain("Confirmed");
    expect(
      composeRelatedSections({
        sku: "X",
        explicitLines: ["- L"],
        explicitCount: 1,
        familyScope: "the catalog",
        familyLines: [],
        familyCount: 0,
      }),
    ).not.toContain("verify fitment");
  });
});

// --- dispatch-level: reverse-fit fallback branches + wiring ------------------

interface Q {
  table: string;
  cols: string;
  opts?: { count?: string };
  filters: [string, string, unknown][];
  limited: number | null;
}
type Handler = (q: Q) => { data?: unknown; error?: unknown; count?: number | null };

/** A thenable query-builder mock: every await of the builder (or maybeSingle)
 *  resolves via the handler with the accumulated filters. */
function makeSb(handler: Handler) {
  return {
    from(table: string) {
      const q: Q = { table, cols: "", filters: [], limited: null };
      const run = () =>
        Promise.resolve({ data: null, error: null, count: null, ...handler(q) });
      const b: Record<string, unknown> = {
        select(cols: string, opts?: { count?: string }) {
          q.cols = cols;
          q.opts = opts;
          return b;
        },
        eq(col: string, val: unknown) {
          q.filters.push(["eq", col, val]);
          return b;
        },
        ilike(col: string, val: unknown) {
          q.filters.push(["ilike", col, String(val)]);
          return b;
        },
        in(col: string, vals: unknown) {
          q.filters.push(["in", col, vals]);
          return b;
        },
        limit(n: number) {
          q.limited = n;
          return b;
        },
        maybeSingle() {
          return run().then((r) => ({
            ...r,
            data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
          }));
        },
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          return run().then(onF, onR);
        },
      };
      return b;
    },
  };
}
const ctxOf = (sb: unknown): ToolContext => ({ env: {}, sb } as unknown as ToolContext);

const filterVal = (q: Q, op: string, col: string): unknown =>
  q.filters.find(([o, c]) => o === op && c === col)?.[2];

describe("get_product reverse-fit fallback (AA1/PL1)", () => {
  it("branch 1: a products MISS that matches related_sku reports what it fits (never 'not found')", async () => {
    const sb = makeSb((q) => {
      if (q.table === "products" && filterVal(q, "eq", "sku")) return { data: null };
      if (q.table === "product_accessories" && filterVal(q, "ilike", "related_sku") === "LENS-16-AMB") {
        return {
          data: [
            { product_sku: "H1", related_product_sku: "528", kind: "accessory", label: null },
            { product_sku: "H2", related_product_sku: "528", kind: "accessory", label: null },
          ],
          count: 2,
        };
      }
      if (q.table === "products" && filterVal(q, "in", "sku")) {
        return {
          data: [
            { sku: "H1", name: "QUARTUS Downlight", family: "QUARTUS", brand: "AiSpire" },
            { sku: "H2", name: "Adjusto Head", family: "Adjusto", brand: "AiSpire" },
            { sku: "528", name: "Colored Lens Accessory", family: null, brand: "WAC Lighting" },
          ],
        };
      }
      return { data: [] };
    });
    const out = await dispatch(ctxOf(sb), "get_product", { sku: "LENS-16-AMB" }, { surface: "internal" });
    expect(out.content).not.toContain("No product found");
    expect(out.content).toContain("confirmed accessory reference");
    expect(out.content).toContain("QUARTUS Downlight");
    // The code resolved to its own parent product — pointed at for details.
    expect(out.content).toContain("Colored Lens Accessory");
    expect(out.content).toContain("528");
  });

  it("branch 2: resolves a variant SKU via products.variants and answers as its parent", async () => {
    const sb = makeSb((q) => {
      if (q.table === "products" && filterVal(q, "eq", "sku") === "WS-100-BK") return { data: null };
      if (q.table === "product_accessories" && filterVal(q, "ilike", "related_sku")) return { data: [], count: 0 };
      if (q.table === "products" && filterVal(q, "ilike", "variant_search")) {
        return {
          data: [
            {
              sku: "1001",
              name: "Paloma Sconce",
              brand: "WAC Lighting",
              variants: [{ sku: "WS-100-BK" }, { sku: "WS-100-WT" }],
            },
          ],
        };
      }
      if (q.table === "products" && filterVal(q, "eq", "sku") === "1001") {
        return { data: { sku: "1001", name: "Paloma Sconce", brand: "WAC Lighting", category: null, primary_image_url: null, variants: [] } };
      }
      return { data: [] };
    });
    const out = await dispatch(ctxOf(sb), "get_product", { sku: "WS-100-BK" }, { surface: "internal" });
    expect(out.content).toContain("WS-100-BK is a variant of Paloma Sconce (PPID 1001)");
    expect(out.cards).toHaveLength(1);
  });

  it("branch 3: still 'not found' when neither branch hits", async () => {
    const sb = makeSb(() => ({ data: null, count: 0 }));
    const out = await dispatch(ctxOf(sb), "get_product", { sku: "NOPE-1" }, { surface: "internal" });
    expect(out.content).toBe("No product found with SKU NOPE-1.");
  });
});

describe("get_product forward + reverse sections on a HIT", () => {
  const productRow = {
    sku: "5010",
    name: "Cirrus Fixture",
    brand: "AiSpire",
    category: null,
    primary_image_url: null,
    variants: [],
  };
  const sbWith = (accessories: unknown[], referenced: { data: unknown[]; count: number }) =>
    makeSb((q) => {
      if (q.table === "products" && filterVal(q, "eq", "sku") === "5010") return { data: productRow };
      if (q.table === "product_accessories" && filterVal(q, "eq", "product_sku") === "5010") {
        return { data: accessories };
      }
      if (q.table === "product_accessories" && filterVal(q, "eq", "related_product_sku") === "5010") {
        return referenced;
      }
      if (q.table === "products" && filterVal(q, "in", "sku")) {
        return { data: [{ sku: "528", name: "Colored Lens Accessory", family: null, brand: "WAC Lighting" }] };
      }
      return { data: [] };
    });

  it("folds the confirmed-accessory section into the product text, grouped by parent", async () => {
    const accessories = [
      { related_sku: "LENS-A", related_product_sku: "528", kind: "accessory", label: null },
      { related_sku: "LENS-B", related_product_sku: "528", kind: "accessory", label: null },
    ];
    const out = await dispatch(ctxOf(sbWith(accessories, { data: [], count: 0 })), "get_product", { sku: "5010" }, { surface: "internal" });
    expect(out.content).toContain("Confirmed accessories and components (2 references, from catalog reference data):");
    // One grouped line for the shared parent, not two rows.
    expect(out.content.split("\n").filter((l) => l.includes("Colored Lens Accessory"))).toHaveLength(1);
    expect(out.cards).toHaveLength(1); // card unchanged (text-only sections)
  });

  it("adds the reverse fan-in rollup when the product is itself referenced", async () => {
    const referenced = {
      data: [{ product_sku: "H1" }, { product_sku: "H2" }],
      count: 2,
    };
    const sb = makeSb((q) => {
      if (q.table === "products" && filterVal(q, "eq", "sku") === "5010") return { data: productRow };
      if (q.table === "product_accessories" && filterVal(q, "eq", "product_sku") === "5010") return { data: [] };
      if (q.table === "product_accessories" && filterVal(q, "eq", "related_product_sku") === "5010") return referenced;
      if (q.table === "products" && filterVal(q, "in", "sku")) {
        return {
          data: [
            { sku: "H1", name: "Host One", family: "F1", brand: null },
            { sku: "H2", name: "Host Two", family: "F1", brand: null },
          ],
        };
      }
      return { data: [] };
    });
    const out = await dispatch(ctxOf(sb), "get_product", { sku: "5010" }, { surface: "internal" });
    expect(out.content).toContain("This product is itself a confirmed accessory.");
    expect(out.content).toContain("Host One");
  });

  it("public surface: unresolved codes in the forward section are framed, never bare (PL8a)", async () => {
    const accessories = [{ related_sku: "ZX-INTERNAL-1", related_product_sku: null, kind: "accessory", label: null }];
    const out = await dispatch(ctxOf(sbWith(accessories, { data: [], count: 0 })), "get_product", { sku: "5010" }, { surface: "public" });
    expect(out.content).not.toContain("ZX-INTERNAL-1");
    expect(out.content).toContain("available through your WAC Group sales rep");
  });
});

describe("get_related_products two sections (AA12)", () => {
  it("returns explicit confirmed rows FIRST, then family expansion labeled verify fitment", async () => {
    const sb = makeSb((q) => {
      if (q.table === "products" && filterVal(q, "eq", "sku") === "5010" && q.cols.includes("family")) {
        return { data: { family: "Cirrus", category: "Track System" } };
      }
      if (q.table === "product_accessories" && filterVal(q, "eq", "product_sku") === "5010") {
        return { data: [{ related_sku: "LENS-A", related_product_sku: "528", kind: "accessory", label: null }] };
      }
      if (q.table === "products" && filterVal(q, "in", "sku")) {
        return { data: [{ sku: "528", name: "Colored Lens Accessory", family: null, brand: "WAC Lighting" }] };
      }
      if (q.table === "products" && filterVal(q, "eq", "family") === "Cirrus") {
        return { data: [{ sku: "5011", name: "Cirrus Channel", category: "Channel" }] };
      }
      if (q.table === "products" && filterVal(q, "eq", "category") === "Track System") {
        return { data: [{ sku: "5012", name: "Track Head", category: "Track System" }] };
      }
      return { data: [] };
    });
    const out = await dispatch(ctxOf(sb), "get_related_products", { sku: "5010" }, { surface: "internal" });
    const confirmedAt = out.content.indexOf("Confirmed accessories and components for 5010");
    const familyAt = out.content.indexOf("Same family or category, verify fitment");
    expect(confirmedAt).toBeGreaterThanOrEqual(0);
    expect(familyAt).toBeGreaterThan(confirmedAt);
    expect(out.content).toContain("Colored Lens Accessory");
    expect(out.content).toContain("5011");
    expect(out.content).toContain("5012");
  });

  it("still answers with explicit rows when the sku has no family/category", async () => {
    const sb = makeSb((q) => {
      if (q.table === "products" && filterVal(q, "eq", "sku") === "FAN-1" && q.cols.includes("family")) {
        return { data: { family: null, category: null } };
      }
      if (q.table === "product_accessories" && filterVal(q, "eq", "product_sku") === "FAN-1") {
        return {
          data: [{ related_sku: "XL-DR-BN", related_product_sku: null, kind: "accessory", label: "72in Downrod" }],
        };
      }
      return { data: [] };
    });
    const out = await dispatch(ctxOf(sb), "get_related_products", { sku: "FAN-1" }, { surface: "internal" });
    expect(out.content).toContain("Confirmed accessories and components for FAN-1");
    expect(out.content).toContain("72in Downrod");
    expect(out.content).not.toContain("No related products found");
  });

  it("keeps the no-scope error and the empty-result message", async () => {
    const sb = makeSb(() => ({ data: [] }));
    const none = await dispatch(ctxOf(sb), "get_related_products", {}, { surface: "internal" });
    expect(none.content).toContain("provide a sku, family, or category");
    const empty = await dispatch(ctxOf(makeSb((q) => (q.table === "products" && filterVal(q, "eq", "sku") ? { data: { family: null, category: null } } : { data: [] }))), "get_related_products", { sku: "X9" }, { surface: "internal" });
    expect(empty.content).toBe("No related products found.");
  });
});
