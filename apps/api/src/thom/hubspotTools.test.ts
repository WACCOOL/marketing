import { describe, expect, it } from "vitest";
import type { HsObject } from "@wac/shared";
import {
  assembleRepCode,
  capRows,
  day,
  dealStageLabel,
  filterInvoicesSince,
  formatDealRow,
  formatInvoiceRow,
  formatOpenOrderRow,
  hubspotDispatch,
  invoiceTotal,
  isOpenDeal,
  money,
  newestSalesGroup,
  sinceMs,
} from "./hubspotTools.js";
import type { ToolContext } from "./types.js";

const obj = (id: string, properties: Record<string, string | null>): HsObject => ({ id, properties });

describe("money", () => {
  it("formats numeric + string money to USD", () => {
    expect(money("1234.5")).toBe("$1,234.50");
    expect(money(1000000)).toBe("$1,000,000.00");
    expect(money("$2,500.00")).toBe("$2,500.00");
  });
  it("renders an em dash for blank / nullish", () => {
    expect(money(null)).toBe("—");
    expect(money("")).toBe("—");
    expect(money(undefined)).toBe("—");
  });
  it("passes non-numeric text through unchanged", () => {
    expect(money("N/A")).toBe("N/A");
  });
});

describe("day", () => {
  it("renders ms-epoch strings as YYYY-MM-DD", () => {
    expect(day(String(Date.UTC(2026, 0, 15)))).toBe("2026-01-15");
  });
  it("renders ISO datetimes as their UTC day", () => {
    expect(day("2026-07-04T12:00:00.000Z")).toBe("2026-07-04");
  });
  it("renders an em dash for blank", () => {
    expect(day(null)).toBe("—");
    expect(day("")).toBe("—");
  });
});

describe("sinceMs", () => {
  it("parses a YYYY-MM-DD bound to a UTC-midnight epoch", () => {
    expect(sinceMs("2026-01-01")).toBe(Date.UTC(2026, 0, 1));
  });
  it("returns null for blank / unparseable", () => {
    expect(sinceMs(null)).toBeNull();
    expect(sinceMs("not-a-date")).toBeNull();
  });
});

describe("dealStageLabel / isOpenDeal", () => {
  it("maps a known stage id to its label and falls back to the raw id", () => {
    expect(dealStageLabel("1054295854")).toBe("Closed Won");
    expect(dealStageLabel("9999999")).toBe("9999999");
    expect(dealStageLabel(null)).toBe("—");
  });
  it("treats won/lost as closed and everything else as open", () => {
    expect(isOpenDeal(obj("1", { dealstage: "1054295854" }))).toBe(false); // won
    expect(isOpenDeal(obj("2", { dealstage: "1054295855" }))).toBe(false); // lost
    expect(isOpenDeal(obj("3", { dealstage: "1054295852" }))).toBe(true); // bidding
    expect(isOpenDeal(obj("4", { dealstage: null }))).toBe(true); // unknown → open
  });
});

describe("capRows", () => {
  it("returns everything with no note when under the cap", () => {
    const { shown, moreNote } = capRows([1, 2, 3], 5);
    expect(shown).toEqual([1, 2, 3]);
    expect(moreNote).toBe("");
  });
  it("truncates and reports the overflow count", () => {
    const { shown, moreNote } = capRows([1, 2, 3, 4, 5], 2);
    expect(shown).toEqual([1, 2]);
    expect(moreNote).toContain("3 more");
  });
});

describe("row formatters", () => {
  it("formats a deal row with stage label + currency", () => {
    const row = formatDealRow(
      obj("d1", {
        dealname: "Acme Tower",
        sap_quote_number: "5500123",
        dealstage: "1054295854",
        amount: "12500",
        sales_group: "R123",
        closedate: String(Date.UTC(2026, 5, 1)),
      }),
    );
    expect(row).toContain("Acme Tower");
    expect(row).toContain("quote 5500123");
    expect(row).toContain("Closed Won");
    expect(row).toContain("$12,500.00");
    expect(row).toContain("2026-06-01");
  });

  it("formats an open-order row", () => {
    const row = formatOpenOrderRow(
      obj("o1", {
        sales_order_id: "SO900",
        po_number: "PO-77",
        hs_total_price: "4200",
        credit_status: "OK",
        risk_code: "A",
      }),
    );
    expect(row).toContain("SO SO900");
    expect(row).toContain("PO PO-77");
    expect(row).toContain("$4,200.00");
    expect(row).toContain("credit OK");
  });

  it("formats an invoice row", () => {
    const row = formatInvoiceRow(
      obj("i1", {
        billing_document: "INV555",
        billing_date: String(Date.UTC(2026, 2, 10)),
        hs_total_price: "999.99",
        brand: "WAC Lighting",
        quotation_ref: "5500123",
      }),
    );
    expect(row).toContain("Invoice INV555");
    expect(row).toContain("billed 2026-03-10");
    expect(row).toContain("$999.99");
    expect(row).toContain("WAC Lighting");
  });
});

describe("invoiceTotal / filterInvoicesSince", () => {
  const rows = [
    obj("1", { hs_total_price: "100", billing_date: String(Date.UTC(2026, 0, 1)) }),
    obj("2", { hs_total_price: "250.50", billing_date: String(Date.UTC(2026, 5, 1)) }),
    obj("3", { hs_total_price: "", billing_date: null }),
  ];

  it("sums hs_total_price and ignores blanks", () => {
    expect(invoiceTotal(rows)).toBe(350.5);
  });

  it("passes all rows through when no bound is given", () => {
    expect(filterInvoicesSince(rows, null)).toHaveLength(3);
  });

  it("keeps only rows on/after the bound and drops undated rows", () => {
    const kept = filterInvoicesSince(rows, Date.UTC(2026, 3, 1));
    expect(kept.map((r) => r.id)).toEqual(["2"]);
  });
});

describe("newestSalesGroup", () => {
  it("picks the sales_group from the row with the newest billing_date", () => {
    const rows = [
      obj("1", { sales_group: "R100", billing_date: String(Date.UTC(2026, 0, 1)) }),
      obj("2", { sales_group: "R200", billing_date: String(Date.UTC(2026, 5, 1)) }),
      obj("3", { sales_group: "R150", billing_date: String(Date.UTC(2026, 2, 1)) }),
    ];
    expect(newestSalesGroup(rows)).toBe("R200");
  });

  it("falls back to po_date when billing_date is absent", () => {
    const rows = [
      obj("1", { sales_group: "R100", po_date: String(Date.UTC(2025, 0, 1)) }),
      obj("2", { sales_group: "R200", po_date: String(Date.UTC(2026, 0, 1)) }),
    ];
    expect(newestSalesGroup(rows)).toBe("R200");
  });

  it("skips rows with a blank sales_group even if they are newer", () => {
    const rows = [
      obj("1", { sales_group: "R100", billing_date: String(Date.UTC(2026, 0, 1)) }),
      obj("2", { sales_group: "", billing_date: String(Date.UTC(2026, 11, 1)) }),
      obj("3", { sales_group: null, billing_date: String(Date.UTC(2026, 10, 1)) }),
    ];
    expect(newestSalesGroup(rows)).toBe("R100");
  });

  it("returns null when no row carries a sales_group", () => {
    expect(newestSalesGroup([obj("1", { sales_group: null, billing_date: "123" })])).toBeNull();
    expect(newestSalesGroup([])).toBeNull();
  });
});

describe("assembleRepCode", () => {
  it("assembles the resolved fields, skipping blanks", () => {
    const out = assembleRepCode(
      obj("r1", {
        rep_code: "R123",
        agency: "Bright Reps",
        account: "0002011239",
        channel: "Agency",
        region: "Northeast",
        city: null,
        state: "NY",
        brands: "WAC;Schonbek",
        status: "Active",
        hubspot_owner_id: "555",
      }),
    );
    expect(out).toContain("Rep code R123 — Bright Reps");
    expect(out).toContain("Channel: Agency");
    expect(out).toContain("State: NY");
    expect(out).not.toContain("City:"); // null → skipped
    expect(out).toContain("Owner (HubSpot user id): 555");
  });
});

describe("hubspotDispatch guard", () => {
  it("returns 'not configured' when HUBSPOT_READ_TOKEN is unset", async () => {
    const ctx = { env: {}, sb: {} } as unknown as ToolContext;
    const out = await hubspotDispatch(ctx, "crm_get_company", { account_number: "2011239" });
    expect(out.content).toBe("CRM tools are not configured.");
    expect(out.cards).toEqual([]);
    expect(out.citations).toEqual([]);
  });

  it("does not touch the network for an unknown crm tool when a token is present", async () => {
    const ctx = { env: { HUBSPOT_READ_TOKEN: "x" }, sb: {} } as unknown as ToolContext;
    const out = await hubspotDispatch(ctx, "crm_bogus", {});
    expect(out.content).toContain("Unknown CRM tool");
  });
});
