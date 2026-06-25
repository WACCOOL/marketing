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

describe("computeInsideSalesFields — writes only inside_sales_rep_from_sap (AMT path)", () => {
  it("writes the AMT-derived ISR to from_sap, nothing else", () => {
    const r = computeInsideSalesFields({ amtRepCode: "464", salesRepCode: "FRT" }, resolvers);
    expect(r.path).toBe("amt");
    expect(r.properties).toEqual({ inside_sales_rep_from_sap: "80807344" });
    expect(r.unresolved).toEqual([]);
  });

  it("accepts a numeric amt code", () => {
    const r = computeInsideSalesFields({ amtRepCode: 463 }, resolvers);
    expect(r.properties).toEqual({ inside_sales_rep_from_sap: "78403193" });
  });

  it("writes nothing (no wipe) when the amt code is unknown", () => {
    const r = computeInsideSalesFields({ amtRepCode: "999", salesRepCode: "OS" }, resolvers);
    expect(r.path).toBe("amt");
    expect(r.properties).toEqual({});
    expect(r.unresolved).toEqual(["999"]);
  });

  it("writes nothing for a no-AMT company (its ISR lives in the calculated manager fields)", () => {
    const r = computeInsideSalesFields({ salesRepCode: "OS, OSX" }, resolvers);
    expect(r.path).toBe("none");
    expect(r.properties).toEqual({});
  });

  it("returns the none path when there is no AMT", () => {
    const r = computeInsideSalesFields({}, resolvers);
    expect(r.path).toBe("none");
    expect(r.properties).toEqual({});
  });
});
