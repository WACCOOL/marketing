import { describe, expect, it } from "vitest";
import {
  COMPANY_FIELD_MAP,
  DEAL_FIELD_MAP,
  LINE_ITEM_FIELD_MAP,
  dedupKeyFor,
  detectUnmappedFields,
  sapChangedAtFor,
  toDecimalPercent,
  toHubspotDate,
  toNumber,
} from "./mapping.js";

describe("toHubspotDate", () => {
  it("converts MM/DD/YYYY to a midnight-UTC ms timestamp", () => {
    expect(toHubspotDate("04/18/2024")).toBe(Date.UTC(2024, 3, 18));
    expect(toHubspotDate("12/17/2024")).toBe(Date.UTC(2024, 11, 17));
  });
  it("returns null for SAP's 00/00/0000 null sentinel", () => {
    expect(toHubspotDate("00/00/0000")).toBeNull();
  });
  it("returns null for empty/invalid/non-date input", () => {
    expect(toHubspotDate("")).toBeNull();
    expect(toHubspotDate(null)).toBeNull();
    expect(toHubspotDate(undefined)).toBeNull();
    expect(toHubspotDate("not a date")).toBeNull();
    expect(toHubspotDate("13/01/2024")).toBeNull(); // month out of range
  });
});

describe("field maps preserve real-world quirks", () => {
  it("maps both opportunity_type spellings to the same target", () => {
    expect(DEAL_FIELD_MAP.opportunity_type).toBe("opportunity_type");
    expect(DEAL_FIELD_MAP.oppourtunity_type).toBe("opportunity_type");
  });
  it("keeps the unit_of_measurment typo target and material__ -> hs_sku", () => {
    expect(LINE_ITEM_FIELD_MAP.unit_of_measurement).toBe("unit_of_measurment");
    expect(LINE_ITEM_FIELD_MAP.material__).toBe("hs_sku");
  });
  it("maps project_name_customer_po__ to dealname and name -> sap_company_name", () => {
    expect(DEAL_FIELD_MAP.project_name_customer_po__).toBe("dealname");
    expect(COMPANY_FIELD_MAP.name).toBe("sap_company_name");
  });
});

describe("dedupKeyFor", () => {
  it("uses quotation_number for deals (trimmed, stringified)", () => {
    expect(dedupKeyFor("deals", { quotation_number: 25103216 })).toBe("25103216");
    expect(dedupKeyFor("deals", { quotation_number: "  Q-1 " })).toBe("Q-1");
  });
  it("uses account_number_ for companies", () => {
    expect(dedupKeyFor("companies", { account_number_: "0001234" })).toBe("0001234");
  });
  it("returns null when the key is missing or blank", () => {
    expect(dedupKeyFor("deals", {})).toBeNull();
    expect(dedupKeyFor("deals", { quotation_number: "   " })).toBeNull();
  });
});

describe("sapChangedAtFor", () => {
  it("parses quote_last_changed_date for deals to ISO", () => {
    expect(sapChangedAtFor("deals", { quote_last_changed_date: "2026-06-22" })).toBe(
      new Date("2026-06-22").toISOString(),
    );
  });
  it("returns null for companies (no change-date) and bad/empty dates", () => {
    expect(sapChangedAtFor("companies", { account_number_: "1" })).toBeNull();
    expect(sapChangedAtFor("deals", { quote_last_changed_date: "" })).toBeNull();
    expect(sapChangedAtFor("deals", { quote_last_changed_date: "nope" })).toBeNull();
  });
});

describe("newly-mapped company fields (2026-06-23)", () => {
  const added = [
    "sales_rep_",
    "terms_of_payment",
    "program_level",
    "price_list_description",
    "risk_category_description",
    "price_group_description",
    "buying_group_description",
    "inside_sales_rep_description",
    "freight_allowed_description",
    "freight_policy_description",
  ];
  it("maps each 1:1 to its HubSpot property", () => {
    for (const f of added) expect(COMPANY_FIELD_MAP[f]).toBe(f);
  });
  it("no longer flags them as unmapped", () => {
    const payload = Object.fromEntries([["account_number_", "1"], ...added.map((f) => [f, "x"])]);
    expect(detectUnmappedFields("companies", payload)).toEqual([]);
  });
});

describe("coercions", () => {
  it("toNumber parses SAP money strings, passes through non-numerics", () => {
    expect(toNumber("$1,234.50")).toBe(1234.5);
    expect(toNumber("65")).toBe(65);
    expect(toNumber("")).toBe("");
    expect(toNumber("N/A")).toBe("N/A");
    expect(toNumber(undefined)).toBeUndefined();
  });
  it("toDecimalPercent divides whole percents by 100", () => {
    expect(toDecimalPercent("5")).toBe(0.05);
    expect(toDecimalPercent("12.5%")).toBe(0.125);
    expect(toDecimalPercent("")).toBe("");
    expect(toDecimalPercent("oops")).toBe("oops");
  });
});

describe("detectUnmappedFields", () => {
  it("flags genuinely unexpected deal keys but not mapped or known-ignored ones", () => {
    const found = detectUnmappedFields("deals", {
      quotation_number: "1", // mapped
      account_number: "A", // mapped
      opportunity_id: "9", // known-ignored
      products: [], // known-ignored (structural)
      brand_new_sap_field: "x", // unexpected
    });
    expect(found).toEqual([{ objectType: "deals", property: "brand_new_sap_field" }]);
  });

  it("scans line items and reports each unexpected key once", () => {
    const found = detectUnmappedFields("deals", {
      quotation_number: "1",
      products: [
        { quote_product_name: "p1", surprise: 1 },
        { quote_product_name: "p2", surprise: 2, another: 3 },
      ],
    });
    expect(found).toContainEqual({ objectType: "line_items", property: "surprise" });
    expect(found).toContainEqual({ objectType: "line_items", property: "another" });
    expect(found.filter((f) => f.property === "surprise")).toHaveLength(1);
  });

  it("flags unexpected company keys", () => {
    const found = detectUnmappedFields("companies", {
      account_number_: "1",
      name: "Acme",
      mystery: "?",
    });
    expect(found).toEqual([{ objectType: "companies", property: "mystery" }]);
  });
});
