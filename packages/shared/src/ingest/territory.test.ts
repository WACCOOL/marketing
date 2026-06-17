import { describe, expect, it } from "vitest";
import {
  addToAggregate,
  buildRepCodes,
  parseRepCodeMapping,
  parseTerritoryHeader,
  unpivotTerritoryRow,
  type RepAggregate,
} from "./territory.js";

// Real header shape: blank col A, geo cols, then channel cols.
const HEADER = [
  null,
  "Zip Code",
  "State",
  "State",
  "County",
  "County & State",
  "WAC Showroom",
  "MF Showroom",
  "Integration",
];

describe("parseTerritoryHeader", () => {
  it("finds the zip column and only the channel columns", () => {
    const h = parseTerritoryHeader(HEADER)!;
    expect(h.zipCol).toBe(1);
    expect(h.channels.map((c) => c.name)).toEqual([
      "WAC Showroom",
      "MF Showroom",
      "Integration",
    ]);
  });

  it("returns null when there is no Zip Code column", () => {
    expect(parseTerritoryHeader(["State", "County"])).toBeNull();
  });
});

describe("unpivotTerritoryRow", () => {
  const h = parseTerritoryHeader(HEADER)!;

  it("emits one row per non-blank channel cell", () => {
    const row = [null, "99553", "Alaska", "AK", "Aleutians", "Aleutians AK", "DD", "DDM", "CSM"];
    expect(unpivotTerritoryRow(row, h)).toEqual([
      { repCode: "DD", zip: "99553", channel: "WAC Showroom" },
      { repCode: "DDM", zip: "99553", channel: "MF Showroom" },
      { repCode: "CSM", zip: "99553", channel: "Integration" },
    ]);
  });

  it("skips blank channel cells and rows without a zip", () => {
    const partial = [null, "10001", "NY", "NY", "x", "x", "AB", "", null];
    expect(unpivotTerritoryRow(partial, h)).toEqual([
      { repCode: "AB", zip: "10001", channel: "WAC Showroom" },
    ]);
    expect(unpivotTerritoryRow([null, "", "NY"], h)).toEqual([]);
  });

  it("zero-pads integer zips that lost their leading zeros", () => {
    // 501 and 1001 arrive as integers from Excel.
    expect(unpivotTerritoryRow([null, 501, "MA", "MA", "x", "x", "AB"], h)[0]?.zip).toBe("00501");
    expect(unpivotTerritoryRow([null, 1001, "MA", "MA", "x", "x", "AB"], h)[0]?.zip).toBe("01001");
    expect(unpivotTerritoryRow([null, 99553, "AK", "AK", "x", "x", "AB"], h)[0]?.zip).toBe("99553");
  });
});

describe("parseRepCodeMapping", () => {
  function mrow(rc: string, extra: Record<string, unknown> = {}) {
    return {
      "Rep Code": rc,
      District: "Showroom West WAC",
      "RSM/TSM": "Eddie Rodriguez",
      "Sales District Code": "200020",
      ISR: "Nina Chou",
      "AMT Rep Code": "403",
      ...extra,
    };
  }

  it("maps the mapping-tab columns", () => {
    const { mapping } = parseRepCodeMapping([mrow("DD")]);
    expect(mapping.get("DD")).toEqual({
      repCode: "DD",
      district: "Showroom West WAC",
      rsmTsm: "Eddie Rodriguez",
      salesDistrictCode: "200020",
      isr: "Nina Chou",
      amtRepCode: "403",
    });
  });

  it("dedups a repeated rep code (last wins) and counts it", () => {
    const { mapping, duplicates } = parseRepCodeMapping([
      mrow("JK", { ISR: "First" }),
      mrow("JK", { ISR: "Second" }),
    ]);
    expect(duplicates).toBe(1);
    expect(mapping.get("JK")?.isr).toBe("Second");
  });
});

describe("buildRepCodes", () => {
  it("unions matrix aggregates with mapping (zips-only, mapping-only, both)", () => {
    const aggregates = new Map<string, RepAggregate>();
    addToAggregate(aggregates, { repCode: "DD", zip: "1", channel: "WAC Showroom" });
    addToAggregate(aggregates, { repCode: "DD", zip: "2", channel: "MF Showroom" });
    addToAggregate(aggregates, { repCode: "ZIPONLY", zip: "9", channel: "Integration" });

    const { mapping } = parseRepCodeMapping([
      { "Rep Code": "DD", District: "West", "RSM/TSM": "Eddie", ISR: "Nina" },
      { "Rep Code": "CAX", District: "East" }, // mapping-only (no zips)
    ]);

    const rows = buildRepCodes(aggregates, mapping);
    const by = Object.fromEntries(rows.map((r) => [r.repCode, r]));

    expect(by["DD"]!.zipCount).toBe(2);
    expect(by["DD"]!.channels).toEqual(["MF Showroom", "WAC Showroom"]);
    expect(by["DD"]!.district).toBe("West");
    expect(by["ZIPONLY"]!.zipCount).toBe(1);
    expect(by["ZIPONLY"]!.district).toBeNull();
    expect(by["CAX"]!.zipCount).toBe(0);
    expect(by["CAX"]!.district).toBe("East");
    expect(rows).toHaveLength(3);
  });
});
