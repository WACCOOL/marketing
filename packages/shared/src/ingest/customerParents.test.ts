import { describe, expect, it } from "vitest";
import {
  parseCustomerParents,
  parseParentRefs,
  stripAccountPrefix,
} from "./customerParents.js";

function customer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "Customer Name": "2000003 Cooper/Friedman Electric Supply Co.",
    "Customer Reference": "2000003",
    "Start Date": null,
    "End Date": null,
    "AMT Rep": "450",
    Parent: "2012923",
    "Price Group": "-",
    "Sales District Description": "-",
    "Sales Grp.": "-",
    "Group Key": "SONEPAR",
    "City Coordinates": "COOPER",
    ...overrides,
  };
}

describe("parseCustomerParents", () => {
  it("parses account, stripped name, and parent", () => {
    const { valid, errors } = parseCustomerParents([customer()]);
    expect(errors).toEqual([]);
    expect(valid).toEqual([
      expect.objectContaining({
        account: "2000003",
        customerName: "Cooper/Friedman Electric Supply Co.",
        parentAccount: "2012923",
      }),
    ]);
  });

  it("treats SAP's '-' placeholder as no parent", () => {
    const { valid } = parseCustomerParents([customer({ Parent: "-" })]);
    expect(valid[0]!.parentAccount).toBeNull();
  });

  it("normalizes self-parented customers to null parent", () => {
    const { valid, stats } = parseCustomerParents([
      customer({ "Customer Reference": "2000002", "Customer Name": "2000002 FERGUSON ENTERPRISES INC", Parent: "2000002" }),
    ]);
    expect(valid[0]!.parentAccount).toBeNull();
    expect(stats.selfParented).toBe(1);
  });

  it("errors on a missing account and dedupes repeats (last wins)", () => {
    const { valid, errors, stats } = parseCustomerParents([
      customer({ "Customer Reference": "" }),
      customer({ Parent: "2000004" }),
      customer({ Parent: "2000005" }),
    ]);
    expect(errors).toEqual([
      { rowIndex: 2, messages: ["missing Customer Reference"] },
    ]);
    expect(stats.duplicates).toBe(1);
    expect(valid).toHaveLength(1);
    expect(valid[0]!.parentAccount).toBe("2000005");
  });
});

describe("parseParentRefs", () => {
  it("parses the parents legend with stripped names", () => {
    const { valid } = parseParentRefs([
      { "Parent Name": "2000005 GRAYBAR ELECTRIC", "Parent Reference": "2000005" },
    ]);
    expect(valid).toEqual([{ account: "2000005", name: "GRAYBAR ELECTRIC" }]);
  });
});

describe("stripAccountPrefix", () => {
  it("strips by explicit account, generic digits, or leaves plain names", () => {
    expect(stripAccountPrefix("2000004 GEXPRO", "2000004")).toBe("GEXPRO");
    expect(stripAccountPrefix("2000004 GEXPRO")).toBe("GEXPRO");
    expect(stripAccountPrefix("GEXPRO")).toBe("GEXPRO");
  });
});
