import { describe, expect, it } from "vitest";
import { parseOpenOrders } from "./openOrders.js";

// A representative SAP row (subset of the 44 columns; the parser carries the
// rest through `raw` untouched).
function sapRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    SO: "0055231690",
    PO: "0055105200",
    "PO Date": new Date(Date.UTC(2026, 4, 12)),
    "Customer Account": "0002011239",
    "Customer Name": "MARRIOTT INTERNATIONAL",
    POSNR: 10,
    Material: "PD-77515R-BC",
    "Order Qty": 3,
    "Net Price": 2031.5,
    "Line Net Value": 6094.5,
    "Sales Group": "JCF",
    "AMT Rep": "Rudy Soni",
    "Sales Territory": "Contract",
    BU: "DL",
    "Back Order Qty": 3,
    "Risk Code": "102",
    ...over,
  };
}

describe("parseOpenOrders", () => {
  it("extracts typed fields and carries the full row in raw", () => {
    const { valid, errors, stats } = parseOpenOrders([sapRow()]);
    expect(errors).toEqual([]);
    expect(stats.valid).toBe(1);
    const row = valid[0]!;
    expect(row.so).toBe("0055231690");
    expect(row.posnr).toBe("10");
    expect(row.poNumber).toBe("0055105200");
    expect(row.poDate).toBe("2026-05-12");
    expect(row.customerAccount).toBe("0002011239");
    expect(row.salesGroup).toBe("JCF");
    expect(row.amtRep).toBe("Rudy Soni");
    expect(row.businessUnit).toBe("DL");
    expect(row.material).toBe("PD-77515R-BC");
    expect(row.orderQty).toBe(3);
    expect(row.netPrice).toBe(2031.5);
    expect(row.lineNetValue).toBe(6094.5);
    expect(row.backOrderQty).toBe(3);
    // raw keeps every column (incl. ones with no typed slot, like Risk Code).
    expect(row.raw["Risk Code"]).toBe("102");
  });

  it("is tolerant of header case/whitespace", () => {
    const { valid } = parseOpenOrders([
      { so: "5", " POSNR ": 20, material: "X-1", "order qty": "4" },
    ]);
    expect(valid[0]!.so).toBe("5");
    expect(valid[0]!.posnr).toBe("20");
    expect(valid[0]!.material).toBe("X-1");
    expect(valid[0]!.orderQty).toBe(4);
  });

  it("records a row missing its key as an error, not a throw", () => {
    const { valid, errors } = parseOpenOrders([
      sapRow(),
      sapRow({ SO: "", POSNR: "" }),
      sapRow({ SO: "0055231691", POSNR: "" }),
    ]);
    expect(valid).toHaveLength(1);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.messages).toContain("missing SO (sales order)");
    expect(errors[0]!.messages).toContain("missing POSNR (line item)");
    expect(errors[1]!.messages).toEqual(["missing POSNR (line item)"]);
  });

  it("dedups on (SO, POSNR) — last occurrence wins", () => {
    const { valid, stats } = parseOpenOrders([
      sapRow({ "Order Qty": 3 }),
      sapRow({ "Order Qty": 9 }), // same SO+POSNR
    ]);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.orderQty).toBe(9);
    expect(stats.duplicates).toBe(1);
  });

  it("distinguishes lines of the same order by POSNR", () => {
    const { valid } = parseOpenOrders([
      sapRow({ POSNR: 10, Material: "A" }),
      sapRow({ POSNR: 20, Material: "B" }),
    ]);
    expect(valid).toHaveLength(2);
    expect(valid.map((r) => r.material)).toEqual(["A", "B"]);
    expect(valid.every((r) => r.so === "0055231690")).toBe(true);
  });
});
