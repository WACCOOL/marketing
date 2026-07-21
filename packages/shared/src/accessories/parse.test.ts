import { describe, expect, it } from "vitest";
import {
  ACCESSORY_PRUNE_COLLAPSE_RATIO,
  accessoryPruneDecision,
  cleanAccessoryCode,
  collectProductAccessoryRefs,
  collectVariantAccessoryRefs,
  dedupeAccessoryRefs,
  normalizeSkuKey,
  resolveAccessoryRefs,
  splitCodeList,
  zaccSlotPosition,
  type AccessoryRef,
  type RawAccessoryRef,
} from "./parse.js";

describe("cleanAccessoryCode / splitCodeList", () => {
  it("trims and keeps real codes, converts numbers", () => {
    expect(cleanAccessoryCode("  A2C01 ")).toBe("A2C01");
    expect(cleanAccessoryCode(528)).toBe("528");
  });

  it("drops empty slots: '', '0', N/A, NA (PL6)", () => {
    for (const v of ["", "  ", "0", "N/A", "n/a", "NA", null, undefined]) {
      expect(cleanAccessoryCode(v)).toBeNull();
    }
  });

  it("splits comma lists incl. spaced values and drops placeholder segments", () => {
    expect(splitCodeList("528, 530,531")).toEqual(["528", "530", "531"]);
    expect(splitCodeList("A2C01,N/A, 0 ,A2C02")).toEqual(["A2C01", "A2C02"]);
    expect(splitCodeList("")).toEqual([]);
    expect(splitCodeList(undefined)).toEqual([]);
    expect(splitCodeList(528)).toEqual(["528"]);
  });
});

describe("collectProductAccessoryRefs", () => {
  it("captures zmataccess + zmataccesstyp2 comma lists as accessory refs with list positions", () => {
    const refs = collectProductAccessoryRefs({
      zmataccess: "528, 530",
      zmataccesstyp2: "601",
    });
    expect(refs).toEqual([
      { related_sku: "528", kind: "accessory", label: null, source_field: "zmataccess", position: 1 },
      { related_sku: "530", kind: "accessory", label: null, source_field: "zmataccess", position: 2 },
      { related_sku: "601", kind: "accessory", label: null, source_field: "zmataccesstyp2", position: 1 },
    ]);
  });

  it("treats zacc2_N as a CONTINUATION of zacc1_N with global slots 1-20", () => {
    expect(zaccSlotPosition(1, 1)).toBe(1);
    expect(zaccSlotPosition(1, 10)).toBe(10);
    expect(zaccSlotPosition(2, 1)).toBe(11);
    expect(zaccSlotPosition(2, 10)).toBe(20);
    const refs = collectProductAccessoryRefs({
      zacc1_1: "A2C01",
      zacc1_2: "A2C02",
      zacc2_1: "A2C11",
    });
    expect(refs.map((r) => [r.related_sku, r.position, r.source_field])).toEqual([
      ["A2C01", 1, "zacc1_1"],
      ["A2C02", 2, "zacc1_2"],
      ["A2C11", 11, "zacc2_1"],
    ]);
    // Continuation semantics: everything is ONE accessory code list, never a
    // name/code pairing — no labels at product level.
    expect(refs.every((r) => r.kind === "accessory" && r.label === null)).toBe(true);
  });

  it("skips N/A and '0' slots in the zacc/zcomp lists", () => {
    const refs = collectProductAccessoryRefs({
      zacc1_1: "0",
      zacc1_2: "N/A",
      zacc1_3: "REAL",
      zcomp1: "0",
      zcomp2: "COMP-2",
    });
    expect(refs.map((r) => r.related_sku)).toEqual(["REAL", "COMP-2"]);
  });

  it("captures zcomp1..10 as components and matnracc1..3,5 (never 4) as accessories", () => {
    const refs = collectProductAccessoryRefs({
      zcomp3: "C3",
      zcomp10: "C10",
      matnracc1: "M1",
      matnracc4: "SHOULD-BE-IGNORED",
      matnracc5: "M5",
    });
    expect(refs).toEqual([
      { related_sku: "C3", kind: "component", label: null, source_field: "zcomp3", position: 3 },
      { related_sku: "C10", kind: "component", label: null, source_field: "zcomp10", position: 10 },
      { related_sku: "M1", kind: "accessory", label: null, source_field: "matnracc1", position: 1 },
      { related_sku: "M5", kind: "accessory", label: null, source_field: "matnracc5", position: 5 },
    ]);
  });

  it("returns [] for a row with none of the fields", () => {
    expect(collectProductAccessoryRefs({ product_id: "123", product_name: "X" })).toEqual([]);
  });
});

describe("collectVariantAccessoryRefs", () => {
  it("pairs MFF zacc1_N SKU with the zacc2_N human LABEL — never a second code row", () => {
    const refs = collectVariantAccessoryRefs({
      zacc1_1: "F-RCBT-WT",
      zacc2_1: "Bluetooth Remote Control",
      zacc1_2: "XL-DR-BN",
      // no zacc2_2 → no label
    });
    expect(refs).toEqual([
      {
        related_sku: "F-RCBT-WT",
        kind: "accessory",
        label: "Bluetooth Remote Control",
        source_field: "zacc1_1",
        position: 1,
      },
      { related_sku: "XL-DR-BN", kind: "accessory", label: null, source_field: "zacc1_2", position: 2 },
    ]);
    // The label value must never surface as a related_sku of its own.
    expect(refs.some((r) => r.related_sku === "Bluetooth Remote Control")).toBe(false);
  });

  it("drops the pair when the SKU slot is empty even if a label is present", () => {
    expect(collectVariantAccessoryRefs({ zacc2_1: "Orphan Label" })).toEqual([]);
  });

  it("captures variant matnracc1..5 as replacement_part and zcomp1..3 as component", () => {
    const refs = collectVariantAccessoryRefs({
      matnracc1: "RP-1",
      matnracc5: "RP-5",
      matnracc6: "IGNORED",
      zcomp1: "VC-1",
      zcomp4: "IGNORED-TOO",
    });
    expect(refs).toEqual([
      { related_sku: "RP-1", kind: "replacement_part", label: null, source_field: "matnracc1", position: 1 },
      { related_sku: "RP-5", kind: "replacement_part", label: null, source_field: "matnracc5", position: 5 },
      { related_sku: "VC-1", kind: "component", label: null, source_field: "zcomp1", position: 1 },
    ]);
  });

  it("never reads bare variant zacc1/zacc2 (empty everywhere in the feed)", () => {
    expect(collectVariantAccessoryRefs({ zacc1: "BARE", zacc2: "BARE2" })).toEqual([]);
  });
});

describe("resolveAccessoryRefs", () => {
  const raw = (over: Partial<RawAccessoryRef>): RawAccessoryRef => ({
    related_sku: "X",
    kind: "accessory",
    label: null,
    source_field: "zacc1_1",
    position: 1,
    ...over,
  });
  const products = new Map([["528", "528"], ["LENS-16", "LENS-16"]]);
  const variants = new Map([["LENS-16-AMB", "LENS-16"], ["A2C01", "PPID-9"]]);

  it("resolves zmataccess PPIDs against the product map", () => {
    const [r] = resolveAccessoryRefs(
      "1001",
      [raw({ related_sku: "528", source_field: "zmataccess" })],
      products,
      variants,
    );
    expect(r).toMatchObject({ product_sku: "1001", related_sku: "528", related_product_sku: "528" });
  });

  it("resolves variant codes via the RAW pre-filter variant index with trim/uppercase normalization", () => {
    const [r] = resolveAccessoryRefs("1001", [raw({ related_sku: " lens-16-amb " })], products, variants);
    expect(r?.related_product_sku).toBe("LENS-16");
    // Raw code stored regardless (AA7) — untouched by normalization.
    expect(r?.related_sku).toBe(" lens-16-amb ");
  });

  it("keeps the raw code and leaves related_product_sku null when nothing resolves", () => {
    const [r] = resolveAccessoryRefs("1001", [raw({ related_sku: "MYSTERY-1" })], products, variants);
    expect(r).toMatchObject({ related_sku: "MYSTERY-1", related_product_sku: null });
  });

  it("falls back product-map -> variant-map (and vice versa) by source field", () => {
    // Code field that happens to be a PPID: variant map misses, product map hits.
    const [a] = resolveAccessoryRefs("1", [raw({ related_sku: "LENS-16" })], products, variants);
    expect(a?.related_product_sku).toBe("LENS-16");
    // zmataccess value that is only a variant SKU: product map misses, variant map hits.
    const [b] = resolveAccessoryRefs(
      "1",
      [raw({ related_sku: "A2C01", source_field: "zmataccesstyp2" })],
      products,
      variants,
    );
    expect(b?.related_product_sku).toBe("PPID-9");
  });
});

describe("dedupeAccessoryRefs", () => {
  const ref = (over: Partial<AccessoryRef>): AccessoryRef => ({
    product_sku: "P1",
    related_sku: "R1",
    kind: "accessory",
    label: null,
    source_field: "zacc1_1",
    position: 1,
    related_product_sku: null,
    ...over,
  });

  it("collapses repeats on (product, related, kind); first occurrence wins", () => {
    const out = dedupeAccessoryRefs([
      ref({ source_field: "zacc1_1", position: 1 }),
      ref({ source_field: "zacc1_2", position: 2 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.source_field).toBe("zacc1_1");
  });

  it("keeps different kinds and different products apart", () => {
    const out = dedupeAccessoryRefs([
      ref({}),
      ref({ kind: "component" }),
      ref({ product_sku: "P2" }),
    ]);
    expect(out).toHaveLength(3);
  });

  it("upgrades a kept row with a later label / resolution", () => {
    const out = dedupeAccessoryRefs([
      ref({}),
      ref({ label: "Bluetooth Remote Control", related_product_sku: "PPID-9" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      label: "Bluetooth Remote Control",
      related_product_sku: "PPID-9",
    });
  });
});

describe("accessoryPruneDecision (PL7 mass-delete guard)", () => {
  const feed = new Set(["P1", "P2", "P3"]);

  it("prunes normally on a healthy capture", () => {
    expect(
      accessoryPruneDecision({ captured: 9000, previous: 10000, previousProductSkus: ["P1"], feedSkus: feed }),
    ).toEqual({ prune: true, warn: null });
  });

  it("prunes when the table was empty (first run)", () => {
    expect(
      accessoryPruneDecision({ captured: 0, previous: 0, previousProductSkus: [], feedSkus: feed }),
    ).toEqual({ prune: true, warn: null });
  });

  it("ABORTS when capture collapses toward zero while previously-referenced products are still in the feed", () => {
    const d = accessoryPruneDecision({
      captured: 3,
      previous: 10000,
      previousProductSkus: ["P1", "P2", "GONE"],
      feedSkus: feed,
    });
    expect(d.prune).toBe(false);
    expect(d.warn).toMatch(/ABORTED/);
    expect(d.warn).toMatch(/2\/3 previously-referenced/);
  });

  it("still prunes a collapse when the previously-referenced products truly left the feed", () => {
    const d = accessoryPruneDecision({
      captured: 0,
      previous: 500,
      previousProductSkus: ["GONE-1", "GONE-2"],
      feedSkus: feed,
    });
    expect(d).toEqual({ prune: true, warn: null });
  });

  it("uses the collapse ratio as the threshold (normalized sku matching)", () => {
    const atThreshold = Math.ceil(500 * ACCESSORY_PRUNE_COLLAPSE_RATIO);
    expect(
      accessoryPruneDecision({
        captured: atThreshold,
        previous: 500,
        previousProductSkus: [" p1 "],
        feedSkus: feed,
      }).prune,
    ).toBe(true);
    expect(
      accessoryPruneDecision({
        captured: atThreshold - 1,
        previous: 500,
        previousProductSkus: [" p1 "],
        feedSkus: feed,
      }).prune,
    ).toBe(false);
  });
});
