import { describe, expect, it } from "vitest";
import { parseRiskCodes } from "./riskCodes.js";

// Rows as they arrive from sheet_to_json on the "Customer Risk Codes" tab
// (header on the first row → keys are the column headers).
function legendRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "Risk Code": "102",
    "Code Description": "Pays as promised",
    Meaning: "release orders based on credit line and if under 30 days past due",
    ...over,
  };
}

describe("parseRiskCodes", () => {
  it("maps code -> description + meaning", () => {
    const row = parseRiskCodes([legendRow()])[0]!;
    expect(row).toEqual({
      code: "102",
      codeDescription: "Pays as promised",
      meaning: "release orders based on credit line and if under 30 days past due",
    });
  });

  it("coerces numeric codes to trimmed strings", () => {
    const row = parseRiskCodes([legendRow({ "Risk Code": 100, "Code Description": "A List Customer" })])[0]!;
    expect(row.code).toBe("100");
    expect(row.codeDescription).toBe("A List Customer");
  });

  it("trims stray whitespace on codes and text", () => {
    const row = parseRiskCodes([
      legendRow({ "Risk Code": "EOF ", "Code Description": "Check on file ", Meaning: null }),
    ])[0]!;
    expect(row.code).toBe("EOF");
    expect(row.codeDescription).toBe("Check on file");
    expect(row.meaning).toBeNull();
  });

  it("nulls a blank Meaning", () => {
    const row = parseRiskCodes([legendRow({ "Risk Code": "106", "Code Description": "Slow Payer", Meaning: null })])[0]!;
    expect(row.meaning).toBeNull();
    expect(row.codeDescription).toBe("Slow Payer");
  });

  it("skips rows with no code", () => {
    const rows = parseRiskCodes([legendRow(), { "Risk Code": "", "Code Description": "orphan" }, { Meaning: "nope" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code).toBe("102");
  });

  it("dedupes by code — last occurrence wins", () => {
    const rows = parseRiskCodes([
      legendRow({ "Code Description": "old" }),
      legendRow({ "Code Description": "new" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeDescription).toBe("new");
  });

  it("is whitespace/case tolerant on headers", () => {
    const row = parseRiskCodes([{ "risk code ": "300", "code description": "Rep accounts", meaning: "Rep accounts " }])[0]!;
    expect(row).toEqual({ code: "300", codeDescription: "Rep accounts", meaning: "Rep accounts" });
  });
});
