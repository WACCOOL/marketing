import { describe, expect, it } from "vitest";
import {
  asArray,
  buildDealDescription,
  completionDateMs,
  firstText,
  fullProjectAddress,
  parseBudgetAmount,
  parseMaterialBank,
  type MaterialBankOrder,
} from "./materialBank.js";

/** A doc shaped the way fast-xml-parser emits the Material Bank feed. */
function doc(rows: unknown): unknown {
  return { root: { row: rows } };
}

const FULL_ORDER = {
  ORDERID: "MB-1001",
  CONTACT1NAME: "María de la Cruz",
  CONTACT1EMAIL: "Maria@DesignStudio.com",
  CONTACT1PHONE: "555-111-2222",
  MOBILEPHONE: "555-333-4444",
  CONTACTPREFERENCE: "Email",
  Title: "Principal Designer",
  Company: "Café Design Studio",
  CompanyPractice: "Residential Interior Design",
  STREET1: "123 Main St",
  City: "Austin",
  State: "TX",
  Zip: "78701",
  Country: "United States",
  row: [
    {
      SKU: "PD-12345",
      QTYORIGINAL: "2",
      Color: "Aged Brass",
      ProjectName: "Hilltop Résidence",
      ProjectDescription: "Whole-home remodel",
      ProjectPhase: "Design Development",
      ProjectType: "Single Family",
      ProjectBudget: "$50k-$100k",
      ExpectedProjectCompletionMonth: "January",
      ExpectedProjectCompletionYear: "2027",
    },
    { SKU: "PD-67890", QTYORIGINAL: "1", Color: "Black" },
  ],
};

describe("parseMaterialBank", () => {
  it("parses a full order with nested line rows and project fields on the lines", () => {
    const { valid, errors, stats } = parseMaterialBank(doc([FULL_ORDER]));
    expect(errors).toEqual([]);
    expect(stats).toMatchObject({ orders: 1, duplicates: 0, lineRows: 2 });
    const o = valid[0]!;
    expect(o.orderId).toBe("MB-1001");
    expect(o.contact.email).toBe("maria@designstudio.com"); // lowercased
    expect(o.contact.name).toBe("María de la Cruz"); // latin1 accents survive
    expect(o.company.practice).toBe("Residential Interior Design");
    expect(o.project.name).toBe("Hilltop Résidence"); // picked up from nested row
    expect(o.project.budgetRaw).toBe("$50k-$100k");
    expect(o.lines).toEqual([
      { sku: "PD-12345", quantity: 2, color: "Aged Brass" },
      { sku: "PD-67890", quantity: 1, color: "Black" },
    ]);
  });

  it("handles the single-child collapse (one order, one line, no arrays)", () => {
    const { valid } = parseMaterialBank(
      doc({ ORDERID: "MB-1", CONTACT1EMAIL: "a@b.com", row: { SKU: "X-1", QTYORIGINAL: "3" } }),
    );
    expect(valid).toHaveLength(1);
    expect(valid[0]!.lines).toEqual([{ sku: "X-1", quantity: 3, color: null }]);
  });

  it("unwraps array-wrapped leaf values (Make-style ORDERID[] arrays)", () => {
    const { valid } = parseMaterialBank(
      doc([{ ORDERID: ["MB-2"], CONTACT1EMAIL: ["x@y.com"], row: [{ SKU: ["S-1"] }] }]),
    );
    expect(valid[0]!.orderId).toBe("MB-2");
    expect(valid[0]!.contact.email).toBe("x@y.com");
  });

  it("collects an error for a row without ORDERID and keeps going", () => {
    const { valid, errors } = parseMaterialBank(
      doc([{ CONTACT1EMAIL: "no-id@x.com" }, { ORDERID: "MB-3" }]),
    );
    expect(valid.map((o) => o.orderId)).toEqual(["MB-3"]);
    expect(errors).toEqual([{ rowIndex: 1, messages: ["missing ORDERID"] }]);
  });

  it("merges duplicate ORDERID elements, de-duping lines", () => {
    const { valid, stats } = parseMaterialBank(
      doc([
        { ORDERID: "MB-4", row: { SKU: "A", QTYORIGINAL: "1" } },
        { ORDERID: "MB-4", row: [{ SKU: "A", QTYORIGINAL: "1" }, { SKU: "B" }] },
      ]),
    );
    expect(valid).toHaveLength(1);
    expect(valid[0]!.lines.map((l) => l.sku)).toEqual(["A", "B"]);
    expect(stats.duplicates).toBe(1);
  });

  it("returns nothing for an empty/alien document", () => {
    expect(parseMaterialBank(null).valid).toEqual([]);
    expect(parseMaterialBank({}).valid).toEqual([]);
    expect(parseMaterialBank("nope").valid).toEqual([]);
  });
});

describe("firstText / asArray", () => {
  it("unwraps #text wrappers and skips blanks", () => {
    expect(firstText([{ "#text": " hi " }])).toBe("hi");
    expect(firstText(["", "  ", "x"])).toBe("x");
    expect(firstText(42)).toBe("42");
    expect(firstText(undefined)).toBeNull();
  });
  it("asArray normalizes single values", () => {
    expect(asArray("a")).toEqual(["a"]);
    expect(asArray(["a"])).toEqual(["a"]);
    expect(asArray(null)).toEqual([]);
  });
});

describe("parseBudgetAmount", () => {
  it.each([
    ["$50k-$100k", 75_000],
    ["$50,000 - $100,000", 75_000],
    ["$1M to $2M", 1_500_000],
    ["over $1M", 1_000_000],
    ["$500k+", 500_000],
    [">$2m", 2_000_000],
    ["$250,000", 250_000],
    ["100k", 100_000],
    ["(1.5m)", 1_500_000],
    ["$50k–$100k", 75_000], // en dash
  ])("%s → %d", (raw, expected) => {
    expect(parseBudgetAmount(raw)).toBe(expected);
  });

  it("returns null for empty or non-numeric budgets", () => {
    expect(parseBudgetAmount(null)).toBeNull();
    expect(parseBudgetAmount("")).toBeNull();
    expect(parseBudgetAmount("TBD")).toBeNull();
  });
});

describe("completionDateMs", () => {
  it("maps month names, abbreviations, and numbers to midnight-UTC of the 1st", () => {
    expect(completionDateMs("January", "2027")).toBe(Date.UTC(2027, 0, 1));
    expect(completionDateMs("sept", "2026")).toBe(Date.UTC(2026, 8, 1));
    expect(completionDateMs("12", "2026")).toBe(Date.UTC(2026, 11, 1));
  });
  it("rejects garbage", () => {
    expect(completionDateMs("Someday", "2026")).toBeNull();
    expect(completionDateMs("May", "")).toBeNull();
    expect(completionDateMs(null, "2026")).toBeNull();
    expect(completionDateMs("May", "20261")).toBeNull();
  });
});

describe("description + address builders", () => {
  const order = parseMaterialBank(doc([FULL_ORDER])).valid[0] as MaterialBankOrder;

  it("buildDealDescription mirrors the Make layout and elides blanks", () => {
    expect(buildDealDescription(order)).toBe(
      "Whole-home remodel\n\nProject Phase: Design Development\n\nCompany: Café Design Studio\nCompany Practice: Residential Interior Design",
    );
    expect(
      buildDealDescription({ ...order, project: { ...order.project, description: null, phase: null }, company: { name: null, practice: null } }),
    ).toBe("");
  });

  it("fullProjectAddress elides missing pieces", () => {
    expect(fullProjectAddress(order)).toBe("123 Main St, Austin, TX 78701, United States");
    expect(
      fullProjectAddress({ ...order, address: { street1: null, city: "Austin", state: "TX", zip: null, country: null } }),
    ).toBe("Austin, TX");
  });
});
