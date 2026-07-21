import { describe, expect, it } from "vitest";
import { buildFamilyCard, dispatch, MAX_FAMILY_MEMBERS, orderFamilyRows, searchDocTypes, WEB_DOC_TYPES } from "./tools.js";
import { dedupeCards } from "./agent.js";
import type { Card, FamilyCard, ProductCard, ToolContext } from "./types.js";

interface Row {
  sku: string;
  name: string | null;
  brand: string | null;
  category: string | null;
  family: string | null;
  primary_image_url: string | null;
  is_accessory: boolean | null;
}
const row = (sku: string, over: Partial<Row> = {}): Row => ({
  sku,
  name: sku,
  brand: "WAC Lighting",
  category: null,
  family: "Outdoor Track",
  primary_image_url: null,
  is_accessory: false,
  ...over,
});

describe("orderFamilyRows", () => {
  it("puts hosts (non-accessory) before accessories, then sorts by category then name", () => {
    const rows = [
      row("acc-b", { is_accessory: true, category: "Connector", name: "B" }),
      row("host-z", { is_accessory: false, category: "Track Head", name: "Z" }),
      row("acc-a", { is_accessory: true, category: "Channel", name: "A" }),
      row("host-a", { is_accessory: false, category: "Track Head", name: "A" }),
    ];
    expect(orderFamilyRows(rows).map((r) => r.sku)).toEqual(["host-a", "host-z", "acc-a", "acc-b"]);
  });
});

describe("buildFamilyCard", () => {
  it("assembles members with role = category and pdp from the map", () => {
    const rows = [
      row("H1", { is_accessory: false, category: "Track Head", primary_image_url: "img-h1" }),
      row("C1", { is_accessory: true, category: "Channel" }),
    ];
    const pdp = new Map([["H1", "https://pdp/h1"]]);
    const card = buildFamilyCard({ family: "Outdoor Track", category: "Track System" }, rows, pdp);
    expect(card.kind).toBe("family");
    expect(card.family).toBe("Outdoor Track");
    expect(card.category).toBe("Track System");
    expect(card.member_count).toBe(2);
    expect(card.members).toEqual([
      { sku: "H1", name: "H1", role: "Track Head", image_url: "img-h1", pdp_url: "https://pdp/h1" },
      { sku: "C1", name: "C1", role: "Channel", image_url: null, pdp_url: null },
    ]);
  });

  it("dedups by sku (first occurrence wins)", () => {
    const rows = [row("A", { name: "first" }), row("A", { name: "second" }), row("B")];
    const card = buildFamilyCard({ family: "F", category: null }, rows, new Map());
    expect(card.member_count).toBe(2);
    expect(card.members.map((m) => m.sku).sort()).toEqual(["A", "B"]);
    expect(card.members.find((m) => m.sku === "A")?.name).toBe("first");
  });

  it("caps members at MAX_FAMILY_MEMBERS but keeps the true member_count", () => {
    const rows = Array.from({ length: MAX_FAMILY_MEMBERS + 5 }, (_, i) =>
      row(`S${String(i).padStart(2, "0")}`, { is_accessory: true, category: "Part" }),
    );
    const card = buildFamilyCard({ family: "F", category: null }, rows, new Map());
    expect(card.members).toHaveLength(MAX_FAMILY_MEMBERS);
    expect(card.member_count).toBe(MAX_FAMILY_MEMBERS + 5);
  });

  it("picks the representative image from the first host with an image", () => {
    const rows = [
      row("acc", { is_accessory: true, primary_image_url: "acc-img" }),
      row("host1", { is_accessory: false, primary_image_url: null }),
      row("host2", { is_accessory: false, primary_image_url: "host2-img" }),
    ];
    // host-first ordering means host1/host2 precede acc; first host WITH an image is host2.
    const card = buildFamilyCard({ family: "F", category: null }, rows, new Map());
    expect(card.image_url).toBe("host2-img");
  });

  it("falls back to any member's image when no host has one", () => {
    const rows = [
      row("host", { is_accessory: false, primary_image_url: null }),
      row("acc", { is_accessory: true, primary_image_url: "acc-img" }),
    ];
    const card = buildFamilyCard({ family: "F", category: null }, rows, new Map());
    expect(card.image_url).toBe("acc-img");
  });
});

// --- getFamily scope resolution (family preferred over category) ------------

interface QState {
  table: string;
  terminal: "maybeSingle" | "limit" | "in";
  filters: [string, unknown][];
}
function makeSb(handlers: Record<string, (s: QState) => unknown>) {
  return {
    from(table: string) {
      const state: QState = { table, terminal: "limit", filters: [] };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          state.filters.push([col, val]);
          return builder;
        },
        maybeSingle: () => {
          state.terminal = "maybeSingle";
          return Promise.resolve(handlers[table]?.(state) ?? { data: null });
        },
        limit: () => {
          state.terminal = "limit";
          return Promise.resolve(handlers[table]?.(state) ?? { data: [], error: null });
        },
        in: (col: string, vals: unknown) => {
          state.filters.push([col, vals]);
          state.terminal = "in";
          return Promise.resolve(handlers[table]?.(state) ?? { data: [] });
        },
      };
      return builder;
    },
  };
}

describe("get_family scope resolution", () => {
  it("prefers family over category when a sku resolves both", async () => {
    let mainFilter: [string, unknown] | undefined;
    const sb = makeSb({
      products: (s) => {
        if (s.terminal === "maybeSingle") {
          return { data: { family: "Outdoor Track", category: "Track System" } };
        }
        mainFilter = s.filters[0]; // the scope filter on the main query
        return {
          data: [row("H1", { is_accessory: false, category: "Track Head" })],
          error: null,
        };
      },
      pdp_urls: () => ({ data: [] }),
    });
    const out = await dispatch({ env: {}, sb } as unknown as ToolContext, "get_family", {
      sku: "H1",
    });
    // Main query must be scoped by family, not category.
    expect(mainFilter).toEqual(["family", "Outdoor Track"]);
    expect(out.cards).toHaveLength(1);
    expect((out.cards[0] as FamilyCard).kind).toBe("family");
    expect((out.cards[0] as FamilyCard).family).toBe("Outdoor Track");
  });

  it("falls back to category when the sku has no family", async () => {
    let mainFilter: [string, unknown] | undefined;
    const sb = makeSb({
      products: (s) => {
        if (s.terminal === "maybeSingle") return { data: { family: null, category: "Track System" } };
        mainFilter = s.filters[0];
        return { data: [row("C1", { family: null, category: "Track System" })], error: null };
      },
      pdp_urls: () => ({ data: [] }),
    });
    await dispatch({ env: {}, sb } as unknown as ToolContext, "get_family", { sku: "C1" });
    expect(mainFilter).toEqual(["category", "Track System"]);
  });
});

// --- dedupeCards across a mixed product + family array ----------------------

const product = (sku: string): ProductCard => ({
  kind: "product",
  sku,
  name: sku,
  brand: null,
  image_url: null,
  key_specs: [],
  pdp_url: null,
  downloads: [],
});
const family = (name: string): FamilyCard => ({
  kind: "family",
  family: name,
  brand: null,
  image_url: null,
  category: null,
  members: [],
  member_count: 0,
});

describe("dedupeCards (mixed)", () => {
  it("keys products and families separately so a family named like a sku doesn't collide", () => {
    const cards: Card[] = [
      product("Track"),
      family("Track"), // same string, different kind — must NOT collide
      product("Track"), // dup product
      family("Track"), // dup family
      product("Other"),
    ];
    const out = dedupeCards(cards);
    expect(out).toHaveLength(3);
    expect(
      out.map((c) =>
        c.kind === "family" ? `family:${c.family}` : c.kind === "layout" ? "layout" : `product:${c.sku}`,
      ),
    ).toEqual([
      "product:Track",
      "family:Track",
      "product:Other",
    ]);
  });
});

describe("searchDocTypes (C.3 education intent gating)", () => {
  it("includes education for company / education / ambiguous intents on BOTH surfaces", () => {
    for (const surface of ["public", "internal"] as const) {
      for (const intent of ["company", "education", "ambiguous"] as const) {
        expect(searchDocTypes(surface, intent)).toContain("education");
      }
    }
  });

  it("EXCLUDES education for product/SKU-shaped queries on both surfaces", () => {
    expect(searchDocTypes("public", "product")).not.toContain("education");
    expect(searchDocTypes("internal", "product")).not.toContain("education");
  });

  it("keeps the surface split: zendesk_ticket internal-only, base types intact", () => {
    const pub = searchDocTypes("public", "ambiguous");
    const int = searchDocTypes("internal", "ambiguous");
    expect(pub).not.toContain("zendesk_ticket");
    expect(int).toContain("zendesk_ticket");
    for (const t of ["spec_sheet", "manual", "marketing", "zendesk_article", ...WEB_DOC_TYPES]) {
      expect(pub).toContain(t);
      expect(int).toContain(t);
    }
  });

  it("education gating never removes a base doc type (pure addition)", () => {
    const withEdu = searchDocTypes("public", "ambiguous");
    const withoutEdu = searchDocTypes("public", "product");
    expect(withEdu.filter((t) => t !== "education")).toEqual(withoutEdu);
  });
});
