import { describe, expect, it } from "vitest";
import { accountForms, specifierAccountNumbers } from "./specifier.js";

describe("specifierAccountNumbers", () => {
  it("collects non-empty slots 1..5", () => {
    expect(
      specifierAccountNumbers({
        specifier_account_number_1: "123456",
        specifier_account_number_2: "654321",
        specifier_account_number_5: "999",
      }),
    ).toEqual(["123456", "654321", "999"]);
  });

  it("skips blank, whitespace, and missing slots", () => {
    expect(
      specifierAccountNumbers({
        specifier_account_number_1: "  ",
        specifier_account_number_2: "",
        specifier_account_number_3: null,
        specifier_account_number_4: "  42  ",
      }),
    ).toEqual(["42"]);
  });

  it("dedupes the same specifier across slots", () => {
    expect(
      specifierAccountNumbers({
        specifier_account_number_1: "123456",
        specifier_account_number_2: "123456",
        specifier_account_number_3: "789",
      }),
    ).toEqual(["123456", "789"]);
  });

  it("returns [] when no specifier slots are present", () => {
    expect(specifierAccountNumbers({ account_number: "1" })).toEqual([]);
  });
});

describe("accountForms", () => {
  it("includes raw, zero-stripped, and 10-padded forms for numeric input", () => {
    expect(accountForms("0000123456")).toEqual(["0000123456", "123456"]);
    expect(accountForms("123456")).toEqual(["123456", "0000123456"]);
  });

  it("does not pad non-numeric values", () => {
    expect(accountForms("ABC123")).toEqual(["ABC123"]);
  });

  it("returns [] for blank input", () => {
    expect(accountForms("   ")).toEqual([]);
  });
});
