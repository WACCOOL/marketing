import { describe, expect, it } from "vitest";
import {
  deriveOrderKey,
  normalizePo,
  parseAmount,
  parseShowroomRows,
  parseTimestampMs,
  sheetSerialToMs,
} from "./parse.js";
import type { ShowroomSheet } from "./registry.js";

const SHEET: ShowroomSheet = {
  agencyKey: "williams",
  agencyName: "Williams Lighting Supply",
  spreadsheetId: "test-sheet-id",
};

/** Header row exactly as the live form emits it (trailing spaces and all). */
const HEADER = [
  "Timestamp",
  "Email Address",
  "Sales Representative: ",
  "Showroom Account Name: ",
  "Showroom Account Number: ",
  "Can you clarify how this order came about? (material bank, existing designer, etc.) ",
  "If associated with trade show, please outline: ",
  "Brand: ",
  "Internal Invoice (PO) Number:",
  "Amount (enter exact amount including dollar sign): ",
];

// 2026-06-10 14:22:19 UTC as a Sheets serial (days since 1899-12-30).
const SERIAL = 46183.59883;

describe("normalizePo", () => {
  it("strips the .0 float artifact from string cells", () => {
    expect(normalizePo("3705639.0")).toBe("3705639");
    expect(normalizePo("13172962.00")).toBe("13172962");
  });
  it("renders integer number cells without a decimal", () => {
    expect(normalizePo(3705639)).toBe("3705639");
  });
  it("uppercases alphanumeric POs and preserves letters", () => {
    expect(normalizePo("by171664a")).toBe("BY171664A");
    expect(normalizePo(" BY171664A ")).toBe("BY171664A");
  });
  it("returns empty for blank cells", () => {
    expect(normalizePo("")).toBe("");
    expect(normalizePo(null)).toBe("");
    expect(normalizePo(undefined)).toBe("");
  });
  it("treats placeholder values as blank so they key off the timestamp", () => {
    for (const v of ["NA", "n/a", "N/A", "none", "TBD", "-", "?", "pending"]) {
      expect(normalizePo(v), v).toBe("");
    }
    // ...but real POs containing those substrings pass through untouched.
    expect(normalizePo("NA-1234")).toBe("NA-1234");
  });
});

describe("parseAmount", () => {
  it("parses formatted dollar strings", () => {
    expect(parseAmount("$5,065.42")).toBe(5065.42);
    expect(parseAmount("$ 1,338.75")).toBe(1338.75);
  });
  it("passes plain numbers and numeric strings through", () => {
    expect(parseAmount(5065.42)).toBe(5065.42);
    expect(parseAmount("5065.42")).toBe(5065.42);
  });
  it("returns null for blanks and garbage", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount("TBD")).toBeNull();
  });
});

describe("sheetSerialToMs / parseTimestampMs", () => {
  it("converts known serial dates", () => {
    // 25569 IS the Unix epoch; +1 day = 1970-01-02.
    expect(sheetSerialToMs(25569)).toBe(0);
    expect(sheetSerialToMs(25570)).toBe(86_400_000);
  });
  it("round-trips a real form timestamp to the right date", () => {
    const ms = parseTimestampMs(SERIAL)!;
    expect(new Date(ms).toISOString().slice(0, 10)).toBe("2026-06-10");
  });
  it("falls back to Date.parse for string cells", () => {
    const ms = parseTimestampMs("2026-03-24T15:10:25Z")!;
    expect(new Date(ms).toISOString().slice(0, 10)).toBe("2026-03-24");
  });
  it("returns null when unparseable", () => {
    expect(parseTimestampMs("")).toBeNull();
    expect(parseTimestampMs("soon")).toBeNull();
  });
});

describe("deriveOrderKey", () => {
  it("builds agency:po:brand", () => {
    expect(deriveOrderKey("williams", "3705639", "Schonbek", 123)).toBe(
      "williams:3705639:schonbek",
    );
  });
  it("slugs multi-word brands and defaults blank brand to 'none'", () => {
    expect(deriveOrderKey("williams", "1", "WAC Lighting", null)).toBe("williams:1:wac-lighting");
    expect(deriveOrderKey("williams", "1", "", null)).toBe("williams:1:none");
  });
  it("falls back to the timestamp when PO is blank", () => {
    expect(deriveOrderKey("williams", "", "Schonbek", 1750000000000)).toBe(
      "williams:ts1750000000000:schonbek",
    );
  });
});

describe("parseShowroomRows", () => {
  const row = (over: Partial<Record<number, unknown>> = {}): unknown[] => {
    const base: unknown[] = [
      SERIAL,
      "office@example.com",
      "Carter Likes",
      "United Electric",
      "BY171664",
      "Existing Designer",
      "",
      "Schonbek",
      1734954,
      1797.75,
    ];
    for (const [i, v] of Object.entries(over)) base[Number(i)] = v;
    return base;
  };

  it("parses a full row into a normalized order", () => {
    const { orders, warnings } = parseShowroomRows([HEADER, row()], SHEET);
    expect(warnings).toEqual([]);
    expect(orders).toHaveLength(1);
    const o = orders[0]!;
    expect(o).toMatchObject({
      agencyKey: "williams",
      agencyName: "Williams Lighting Supply",
      row: 2,
      salesRep: "Carter Likes",
      accountName: "United Electric",
      accountNumber: "BY171664",
      orderSource: "Existing Designer",
      brand: "Schonbek",
      po: "1734954",
      amount: 1797.75,
      orderKey: "williams:1734954:schonbek",
    });
    expect(new Date(o.timestampMs!).toISOString().slice(0, 10)).toBe("2026-06-10");
  });

  it("survives reordered columns (fuzzy header matching)", () => {
    const shuffledHeader = [HEADER[9], HEADER[0], ...HEADER.slice(1, 9)];
    const shuffledRow = ["$1,797.75", SERIAL, ...row().slice(1, 9)];
    const { orders, warnings } = parseShowroomRows([shuffledHeader, shuffledRow], SHEET);
    expect(warnings).toEqual([]);
    expect(orders[0]!.amount).toBe(1797.75);
    expect(orders[0]!.po).toBe("1734954");
  });

  it("warns on a missing column instead of silently misparsing", () => {
    const header = HEADER.map((h) => (h === "Brand: " ? "Mystery" : h));
    const { orders, warnings } = parseShowroomRows([header, row()], SHEET);
    expect(warnings.some((w) => w.includes('column "brand" not found'))).toBe(true);
    expect(orders[0]!.brand).toBe("");
    expect(orders[0]!.orderKey).toBe("williams:1734954:none");
  });

  it("keeps the later of two rows with the same key and warns", () => {
    const { orders, warnings } = parseShowroomRows(
      [HEADER, row({ 9: 100 }), row({ 9: 250 })],
      SHEET,
    );
    expect(orders).toHaveLength(1);
    expect(orders[0]!.amount).toBe(250);
    expect(warnings.some((w) => w.includes("duplicate key"))).toBe(true);
  });

  it("skips trailing blank rows and rows with no business fields", () => {
    const { orders, warnings } = parseShowroomRows(
      [HEADER, row(), ["", "", "", "", "", "", "", "", "", ""], [SERIAL, "x@y.com", "", "", "", "", "", "", "", ""]],
      SHEET,
    );
    expect(orders).toHaveLength(1);
    expect(warnings.some((w) => w.includes("no account/PO/amount"))).toBe(true);
  });

  it("warns on unparseable amount but keeps the row", () => {
    const { orders, warnings } = parseShowroomRows([HEADER, row({ 9: "call me" })], SHEET);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.amount).toBeNull();
    expect(warnings.some((w) => w.includes("unparseable amount"))).toBe(true);
  });

  it("keys blank-PO rows off the immutable timestamp", () => {
    const { orders } = parseShowroomRows([HEADER, row({ 8: "" })], SHEET);
    expect(orders[0]!.orderKey).toBe(`williams:ts${orders[0]!.timestampMs}:schonbek`);
  });

  // The 21 live agency forms are NOT uniform — variants verified 2026-07-02.
  it("handles agency-specific header variants (KTR/Enlightening/Fletcher-style)", () => {
    const header = [
      "Timestamp",
      "Email Address",
      "KTR Lighting Representative",
      "Showroom Account Name: ",
      "Showroom Account Number: ",
      "Brand: ",
      "Internal Invoice (PO) Number:",
      "Amount (enter exact amount including dollar sign): ",
      "Where did this designer sale come from?",
      "Designer's Name or Company",
    ];
    const dataRow = [
      SERIAL,
      "ktr@example.com",
      "Jane Doe",
      "Lights R Us",
      "12345",
      "WAC",
      "555001",
      "$1,000.00",
      "Material Bank",
      "Studio McGee",
    ];
    const { orders, warnings } = parseShowroomRows([header, dataRow], SHEET);
    expect(warnings).toEqual([]);
    expect(orders[0]).toMatchObject({
      salesRep: "Jane Doe",
      orderSource: "Material Bank",
      designer: "Studio McGee",
      brand: "WAC",
      po: "555001",
      amount: 1000,
    });
  });

  it("does not warn when a form simply lacks the optional columns", () => {
    // Many live forms have only the 8 core columns.
    const header = HEADER.filter((_, i) => ![5, 6].includes(i));
    const dataRow = row().filter((_, i) => ![5, 6].includes(i));
    const { orders, warnings } = parseShowroomRows([header, dataRow], SHEET);
    expect(warnings).toEqual([]);
    expect(orders[0]!.orderSource).toBe("");
    expect(orders[0]!.tradeShow).toBe("");
    expect(orders[0]!.po).toBe("1734954");
  });
});
