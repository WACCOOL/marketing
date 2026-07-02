import { describe, expect, it } from "vitest";
import {
  SHOWROOM_CLOSED_WON_STAGE_ID,
  SHOWROOM_DEAL_PROPERTY_DEFS,
  SHOWROOM_ORDER_KEY_PROP,
  SHOWROOM_OWNER_ID,
  SHOWROOM_PIPELINE_ID,
  showroomDealName,
  showroomDealProperties,
} from "./map.js";
import type { ShowroomOrder } from "./parse.js";

const ORDER: ShowroomOrder = {
  agencyKey: "williams",
  agencyName: "Williams Lighting Supply",
  row: 2,
  timestampMs: Date.UTC(2026, 5, 10, 14, 22, 19),
  submittedBy: "office@example.com",
  salesRep: "Carter Likes",
  accountName: "United Electric",
  accountNumber: "BY171664",
  orderSource: "Existing Designer",
  tradeShow: "",
  designer: "",
  brand: "Schonbek",
  po: "1734954",
  amount: 1797.75,
  orderKey: "williams:1734954:schonbek",
};

describe("showroomDealName", () => {
  it("names by account, brand, and PO", () => {
    expect(showroomDealName(ORDER)).toBe("United Electric — Schonbek PO 1734954");
  });
  it("falls back to the submission date when PO is blank", () => {
    expect(showroomDealName({ ...ORDER, po: "" })).toBe("United Electric — Schonbek 2026-06-10");
  });
});

describe("showroomDealProperties", () => {
  it("maps every field with the fixed pipeline/stage/owner", () => {
    expect(showroomDealProperties(ORDER)).toEqual({
      [SHOWROOM_ORDER_KEY_PROP]: "williams:1734954:schonbek",
      dealname: "United Electric — Schonbek PO 1734954",
      pipeline: SHOWROOM_PIPELINE_ID,
      dealstage: SHOWROOM_CLOSED_WON_STAGE_ID,
      hubspot_owner_id: SHOWROOM_OWNER_ID,
      showroom_agency: "Williams Lighting Supply",
      amount: "1797.75",
      closedate: String(ORDER.timestampMs),
      po_number: "1734954",
      account_number: "BY171664",
      showroom_sales_rep: "Carter Likes",
      showroom_submitted_by: "office@example.com",
      showroom_order_source: "Existing Designer",
      showroom_brand: "Schonbek",
    });
  });

  it("omits blank/null optionals instead of sending empty strings", () => {
    const props = showroomDealProperties({
      ...ORDER,
      amount: null,
      timestampMs: null,
      tradeShow: "",
      accountNumber: "",
    });
    expect(props).not.toHaveProperty("amount");
    expect(props).not.toHaveProperty("closedate");
    expect(props).not.toHaveProperty("showroom_trade_show");
    expect(props).not.toHaveProperty("showroom_designer");
    expect(props).not.toHaveProperty("account_number");
  });

  it("maps the designer column when the form has one", () => {
    const props = showroomDealProperties({ ...ORDER, designer: "Studio McGee" });
    expect(props.showroom_designer).toBe("Studio McGee");
  });

  it("declares the dedupe key property as unique", () => {
    const key = SHOWROOM_DEAL_PROPERTY_DEFS.find((d) => d.name === SHOWROOM_ORDER_KEY_PROP);
    expect(key?.hasUniqueValue).toBe(true);
  });
});
