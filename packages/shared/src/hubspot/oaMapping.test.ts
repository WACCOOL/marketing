import { describe, expect, it } from "vitest";

import {
  OA_STAGE_LABELS,
  oaCurrency,
  oaDateTimeToMs,
  oaDateToHubspotDate,
  oaDealProps,
  oaCompanyProps,
  oaDestination,
  oaDestinationOf,
  oaLineItems,
  oaLineKey,
  oaOrderProps,
  oaRecordHash,
  oaStageForStatus,
  type OaOrderDetail,
  type OaQuotation,
} from "./oaMapping.js";

/** The example payload from the Order Detail API documentation. */
const DETAIL: OaOrderDetail = {
  updateDate: "2025-12-26 16:14:10",
  orderNumber: "43788",
  quotationId: "QT2025120014",
  expectedDeliveryDate: "2026-01-22 00:00:00",
  orderRemark: "仅仅OA测试流程",
  receivedPrepaymentAmount: 11389.14,
  orderDiscount: 10.0,
  receivedPrepayment: true,
  id: "2025120010",
  receivedBalancePaymentAmount: 0.0,
  quotation: {
    prepaymentPercentage: 100.0,
    estimatedOrderDate: "2025-12-25 00:00:00",
    project: { name: "1000-标品Test1", location: "korea", finishedDate: "2025-12-31 00:00:00" },
    discount: 10.0,
    title: "1000-标品Test1",
    prepayment: 11389.14,
    quotationNo: "000152",
    shipmentTerms: "BY T/T TRANSFER",
    requestDate: "2025-12-25 00:00:00",
    currency: "USD",
    id: "QT2025120014",
    balancePayment: 0.0,
    paymentTerms: "T/T100%payment before production",
    discountTotalAmount: 11389.14,
    totalAmount: 12654.6,
    leadtime: "30",
    remarks: "",
    productList: [
      {
        quotePrice: 175.31,
        quantity: 10.0,
        material: "ADLN35-LM13N330BWT",
        customiseRemark: "",
        description: "ULTRA 3IN 13WMAX 3000K 36D BK NON WT",
        lampPosition: "",
      },
      {
        quotePrice: 218.03,
        quantity: 50.0,
        material: "ADLN35-LM13N340BWT",
        customiseRemark: "",
        description: "ULTRA 3IN 13WMAX 4000K 36D BK NON WT",
        lampPosition: "",
      },
    ],
    customer: { code: "0001009999", name: "example co., ltd.", coefficient: 1.665, contacts: "kim" },
  },
  receivedBalancePayment: true,
  remarks: "",
  createDate: "2025-12-26 09:29:36",
};

describe("oa dates", () => {
  it("converts China-time datetimes to epoch instants", () => {
    // 2025-12-26 16:14:10 +08:00 == 08:14:10 UTC
    expect(oaDateTimeToMs("2025-12-26 16:14:10")).toBe(Date.UTC(2025, 11, 26, 8, 14, 10));
  });

  it("maps any date/datetime to noon UTC of the China-local day", () => {
    const noon = Date.UTC(2026, 0, 22) + 43_200_000;
    expect(oaDateToHubspotDate("2026-01-22 00:00:00")).toBe(noon);
    expect(oaDateToHubspotDate("2026-01-22")).toBe(noon);
  });

  it("rejects blanks and sentinels", () => {
    for (const v of [null, undefined, "", "0000-00-00", "not a date", "12/26/2025"]) {
      expect(oaDateToHubspotDate(v)).toBeNull();
      expect(oaDateTimeToMs(v)).toBeNull();
    }
  });
});

describe("oaCurrency", () => {
  it("normalizes RMB to CNY and passes ISO codes through", () => {
    expect(oaCurrency("RMB")).toBe("CNY");
    expect(oaCurrency(" usd ")).toBe("USD");
    expect(oaCurrency("EUR")).toBe("EUR");
  });

  it("returns null for unknown/blank so the property is skipped", () => {
    expect(oaCurrency("YEN")).toBeNull();
    expect(oaCurrency("")).toBeNull();
    expect(oaCurrency(null)).toBeNull();
  });
});

describe("oaDestination", () => {
  it("classifies explicit non-China countries as international", () => {
    expect(oaDestination({ country: "Korea" })).toBe("international");
    expect(oaDestination({ country: "United Arab Emirates" })).toBe("international");
  });

  it("classifies China by country or free-text location", () => {
    expect(oaDestination({ country: "China" })).toBe("china");
    expect(oaDestination({ country: "CN" })).toBe("china");
    expect(oaDestination({ location: "Shanghai" })).toBe("china");
    expect(oaDestination({ location: "项目在中国" })).toBe("china");
    expect(oaDestination({ location: "Shenzhen, Guangdong" })).toBe("china");
  });

  it("treats HK/Macau/Taiwan as international, even styled 'Taiwan, China'", () => {
    expect(oaDestination({ location: "Hong Kong" })).toBe("international");
    expect(oaDestination({ country: "Taiwan, China" })).toBe("international");
    expect(oaDestination({ location: "Macau" })).toBe("international");
  });

  it("fails closed: blank or unrecognized bare locations are unknown", () => {
    expect(oaDestination({})).toBe("unknown");
    expect(oaDestination({ location: "" })).toBe("unknown");
    expect(oaDestination({ location: "seoul" })).toBe("unknown"); // no country given
  });

  it("reads project fields from a quotation", () => {
    expect(oaDestinationOf(DETAIL.quotation as OaQuotation)).toBe("unknown"); // "korea" is a bare location
    expect(
      oaDestinationOf({ project: { country: "korea", location: "seoul" } } as OaQuotation),
    ).toBe("international");
  });
});

describe("oaStageForStatus", () => {
  it("maps the draft status vocabulary onto mirrored stage labels", () => {
    expect(oaStageForStatus("New Lead")).toBe(OA_STAGE_LABELS.prequal);
    expect(oaStageForStatus("Re-design")).toBe(OA_STAGE_LABELS.spec);
    expect(oaStageForStatus("Price negotiation")).toBe(OA_STAGE_LABELS.bid);
    expect(oaStageForStatus("  ON  HOLD ")).toBe(OA_STAGE_LABELS.bid);
    // Commit = "order promised, PO pending" — Construction doesn't imply that.
    expect(oaStageForStatus("Construction")).toBe(OA_STAGE_LABELS.bid);
    expect(oaStageForStatus("Complete")).toBe(OA_STAGE_LABELS.buy);
    expect(oaStageForStatus("Cancellation")).toBe(OA_STAGE_LABELS.lost);
  });

  it("returns null for unknown statuses", () => {
    expect(oaStageForStatus("Something new")).toBeNull();
    expect(oaStageForStatus(null)).toBeNull();
  });
});

describe("oaDealProps", () => {
  const props = oaDealProps(DETAIL.quotation as OaQuotation);

  it("maps the documented quotation payload", () => {
    expect(props).toMatchObject({
      oa_quote_number: "QT2025120014",
      dealname: "1000-标品Test1",
      project_location: "korea",
      subtotal: 12654.6,
      amount: 11389.14,
      discount: 10,
      oa_prepayment: 11389.14,
      oa_prepayment_percentage: 100,
      oa_payment_terms: "T/T100%payment before production",
      oa_shipment_terms: "BY T/T TRANSFER",
      oa_leadtime: "30",
      customer_name: "example co., ltd.",
      oa_account_number: "0001009999",
      customer_coefficient: 1.665,
      requested_by: "kim",
      deal_currency_code: "USD",
    });
    expect(props.quote_creation_date).toBe(Date.UTC(2025, 11, 25) + 43_200_000);
  });

  it("skips blank fields (remarks is empty in the fixture) and never emits SAP keys", () => {
    expect(props).not.toHaveProperty("oa_quote_remarks");
    expect(props).not.toHaveProperty("sap_quote_number");
    expect(props).not.toHaveProperty("account_number_");
  });

  it("emits balance payment of 0 (numeric zero is a real value, not blank)", () => {
    expect(props.oa_balance_payment).toBe(0);
  });
});

describe("oaCompanyProps", () => {
  it("builds the minimal v1 bag from the order-detail customer", () => {
    expect(oaCompanyProps(DETAIL.quotation!.customer!)).toEqual({
      oa_account_number: "0001009999",
      name: "example co., ltd.",
      customer_coefficient: 1.665,
    });
  });

  it("routes a future domain field to website, never domain", () => {
    const props = oaCompanyProps({ code: "1", domain: "example.com" });
    expect(props.website).toBe("example.com");
    expect(props).not.toHaveProperty("domain");
  });
});

describe("oaOrderProps", () => {
  const props = oaOrderProps(DETAIL);

  it("maps the documented order payload", () => {
    expect(props).toMatchObject({
      oa_order_id: "2025120010",
      oa_order_number: "43788",
      hs_order_name: "43788",
      oa_quote_number: "QT2025120014",
      customer_account: "0001009999",
      customer_name: "example co., ltd.",
      oa_order_discount: 10,
      oa_received_prepayment_amount: 11389.14,
      oa_received_balance_payment_amount: 0,
      oa_received_prepayment: "true",
      oa_received_balance_payment: "true",
      oa_order_remark: "仅仅OA测试流程",
      hs_currency_code: "USD",
    });
    expect(props.expected_delivery_date).toBe(Date.UTC(2026, 0, 22) + 43_200_000);
  });

  it("never writes the SAP-owned order keys", () => {
    expect(props).not.toHaveProperty("sales_order_id");
    expect(props).not.toHaveProperty("billing_document");
  });
});

describe("oaLineItems", () => {
  const lines = oaLineItems(DETAIL.quotation as OaQuotation);

  it("keys lines by quote + position + material", () => {
    expect(lines.map((l) => l.key)).toEqual([
      "QT2025120014-001-ADLN35-LM13N330BWT",
      "QT2025120014-002-ADLN35-LM13N340BWT",
    ]);
    expect(oaLineKey("QT1", 0, " M ")).toBe("QT1-001-M");
  });

  it("maps line props and keeps zero-adjacent values sane", () => {
    expect(lines[0]!.props).toEqual({
      oa_line_key: "QT2025120014-001-ADLN35-LM13N330BWT",
      name: "ADLN35-LM13N330BWT",
      material_description: "ULTRA 3IN 13WMAX 3000K 36D BK NON WT",
      quantity: 10,
      price: 175.31,
    });
    expect(lines[0]!.props).not.toHaveProperty("hs_sku");
  });

  it("drops negative prices and handles missing product lists", () => {
    const [line] = oaLineItems({ id: "QT1", productList: [{ material: "M", quotePrice: -5 }] });
    expect(line!.props).not.toHaveProperty("price");
    expect(oaLineItems({ id: "QT1" })).toEqual([]);
    expect(oaLineItems({ productList: [{ material: "M" }] })).toEqual([]);
  });
});

describe("oaRecordHash", () => {
  it("is stable across key order and sensitive to values", () => {
    const a = oaRecordHash({ x: 1, y: [1, 2], z: { b: 2, a: 1 } });
    const b = oaRecordHash({ z: { a: 1, b: 2 }, y: [1, 2], x: 1 });
    expect(a).toBe(b);
    expect(oaRecordHash({ x: 2 })).not.toBe(oaRecordHash({ x: 1 }));
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});
