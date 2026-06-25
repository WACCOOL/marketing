import { describe, expect, it } from "vitest";
import {
  computeInsideSalesFields,
  parseRepCodes,
  type InsideSalesResolvers,
} from "./insideSales.js";

const resolvers: InsideSalesResolvers = {
  // 464 -> Aaron Jernoske, 463 -> Kiara Machare (from the live data)
  amtToOwner: new Map([
    ["464", "80807344"],
    ["463", "78403193"],
  ]),
  // OS -> Aaron, OSX -> Kiara, PLM/PLD -> same person
  repCodeToOwner: new Map([
    ["OS", "80807344"],
    ["OSX", "78403193"],
    ["PLM", "1386421143"],
    ["PLD", "1386421143"],
  ]),
};

describe("parseRepCodes", () => {
  it("splits comma- and slash-packed codes, trims, uppercases, dedupes", () => {
    expect(parseRepCodes("OS, OSX")).toEqual(["OS", "OSX"]);
    expect(parseRepCodes("SC/SCX")).toEqual(["SC", "SCX"]);
    expect(parseRepCodes("plm/pld")).toEqual(["PLM", "PLD"]);
    expect(parseRepCodes("SDA SDX")).toEqual(["SDA", "SDX"]); // space-separated
    expect(parseRepCodes("TLA  TLX")).toEqual(["TLA", "TLX"]); // collapse repeats
    expect(parseRepCodes("FRT")).toEqual(["FRT"]);
    expect(parseRepCodes("OS, os")).toEqual(["OS"]);
    expect(parseRepCodes("  FRT  ")).toEqual(["FRT"]); // surrounding whitespace
    expect(parseRepCodes("")).toEqual([]);
    expect(parseRepCodes(null)).toEqual([]);
  });
});

describe("computeInsideSalesFields — AMT path", () => {
  it("mirrors the single ISR into from_sap/manager_1/managers and clears manager_2", () => {
    const r = computeInsideSalesFields({ amtRepCode: "464", salesRepCode: "FRT" }, resolvers);
    expect(r.path).toBe("amt");
    expect(r.properties).toEqual({
      inside_sales_rep_from_sap: "80807344",
      inside_sales_manager_1: "80807344",
      inside_sales_manager_2: "",
      inside_sales_managers: "80807344",
    });
    expect(r.unresolved).toEqual([]);
  });

  it("accepts a numeric amt code", () => {
    const r = computeInsideSalesFields({ amtRepCode: 463 }, resolvers);
    expect(r.properties.inside_sales_rep_from_sap).toBe("78403193");
  });

  it("writes nothing (no wipe) when the amt code is unknown", () => {
    const r = computeInsideSalesFields({ amtRepCode: "999", salesRepCode: "OS" }, resolvers);
    expect(r.path).toBe("amt");
    expect(r.properties).toEqual({});
    expect(r.unresolved).toEqual(["999"]);
  });
});

describe("computeInsideSalesFields — rep-code path (no AMT)", () => {
  it("captures two distinct ISRs from a multi-code account and clears from_sap", () => {
    const r = computeInsideSalesFields({ salesRepCode: "OS, OSX" }, resolvers);
    expect(r.path).toBe("rep_code");
    expect(r.properties).toEqual({
      inside_sales_rep_from_sap: "",
      inside_sales_manager_1: "80807344",
      inside_sales_manager_2: "78403193",
      inside_sales_managers: "80807344;78403193",
    });
  });

  it("collapses duplicate owners (two codes, same person) to one", () => {
    const r = computeInsideSalesFields({ salesRepCode: "PLM/PLD" }, resolvers);
    expect(r.properties).toEqual({
      inside_sales_rep_from_sap: "",
      inside_sales_manager_1: "1386421143",
      inside_sales_manager_2: "",
      inside_sales_managers: "1386421143",
    });
  });

  it("flags unresolved rep codes but still sets the resolved ones", () => {
    const r = computeInsideSalesFields({ salesRepCode: "OS, ZZZ" }, resolvers);
    expect(r.properties.inside_sales_manager_1).toBe("80807344");
    expect(r.unresolved).toEqual(["ZZZ"]);
  });

  it("writes nothing when no rep code resolves", () => {
    const r = computeInsideSalesFields({ salesRepCode: "ZZZ" }, resolvers);
    expect(r.properties).toEqual({});
    expect(r.unresolved).toEqual(["ZZZ"]);
  });

  it("returns the none path when there is neither an AMT nor a rep code", () => {
    const r = computeInsideSalesFields({}, resolvers);
    expect(r.path).toBe("none");
    expect(r.properties).toEqual({});
  });
});
