import { describe, it, expect } from "vitest";
import { parseWildcards, wildcardToRegExp, matchesAnyWildcard, parseAnnuityYearHeader, parseAnnuityGrid } from "./annuity.js";

describe("parseWildcards", () => {
  it("splits, trims, lowercases, drops blanks", () => {
    expect(parseWildcards("*Culver's*, *Culvers*")).toEqual(["*culver's*", "*culvers*"]);
    expect(parseWildcards("*better*buzz*")).toEqual(["*better*buzz*"]);
    expect(parseWildcards(" *a* , , *b* ")).toEqual(["*a*", "*b*"]);
  });
  it("handles empty/nullish", () => {
    expect(parseWildcards("")).toEqual([]);
    expect(parseWildcards(null)).toEqual([]);
    expect(parseWildcards(undefined)).toEqual([]);
  });
});

describe("wildcardToRegExp / matchesAnyWildcard", () => {
  it("treats * as any run and is a contains-match when flanked by *", () => {
    const re = wildcardToRegExp("*better*buzz*");
    expect(re.test("better buzz coffee co".toLowerCase())).toBe(true);
    expect(re.test("acme better tasting buzz drinks")).toBe(true);
    expect(re.test("buzz better")).toBe(false); // order matters
  });
  it("is case-insensitive", () => {
    expect(wildcardToRegExp("*rbc*").test("RBC Wealth - Tower")).toBe(true);
  });
  it("escapes regex metacharacters (e.g. apostrophes, dots) literally", () => {
    expect(wildcardToRegExp("*culver's*").test("the culver's on main")).toBe(true);
    expect(wildcardToRegExp("*a.b*").test("xa.byz")).toBe(true);
    expect(wildcardToRegExp("*a.b*").test("xaXbyz")).toBe(false); // '.' is literal, not any-char
  });
  it("matchesAnyWildcard ORs the patterns", () => {
    const pats = parseWildcards("*culver's*, *culvers*");
    expect(matchesAnyWildcard("culvers restaurant", pats)).toBe(true);
    expect(matchesAnyWildcard("Culver's #42", pats)).toBe(true);
    expect(matchesAnyWildcard("burger king", pats)).toBe(false);
  });
  it("anchors fully so a bare token without * does not contains-match", () => {
    expect(matchesAnyWildcard("a target store", ["target"])).toBe(false);
    expect(matchesAnyWildcard("a target store", ["*target*"])).toBe(true);
  });
});

describe("parseAnnuityYearHeader", () => {
  it("extracts the year from an annuity column header", () => {
    expect(parseAnnuityYearHeader("2026 Annuity")).toBe(2026);
    expect(parseAnnuityYearHeader(" 2027 Annuity ")).toBe(2027);
    expect(parseAnnuityYearHeader("Annuity 2028")).toBe(2028);
  });
  it("returns null for non-annuity or non-year headers", () => {
    expect(parseAnnuityYearHeader("Opportunity Name")).toBeNull();
    expect(parseAnnuityYearHeader("Monthly Annuity Amount")).toBeNull();
    expect(parseAnnuityYearHeader("HubSpot Record ID")).toBeNull();
    expect(parseAnnuityYearHeader(null)).toBeNull();
    expect(parseAnnuityYearHeader("")).toBeNull();
  });
});

describe("parseAnnuityGrid", () => {
  const grid: unknown[][] = [
    ["NA End User", "Wild Card SAP", "HubSpot Record ID", "Opportunity Name", "2026 Annuity", "2027 Annuity"],
    ["Better Buzz", "*better*buzz*", 56136806766, "Better Buzz Coffee", 1393.03, null],
    ["Clayton Tile", "*clayton*tile*", 56136807035, "Clayton Tile", 0, null], // zero → no year
    ["Culver’s", "*culver's*, *culvers*", 50100955662, "Culver’s", 4005.9, 4200],
    [null, "*ignored*", null, "No ID Row", 999, null], // dropped: no record id
  ];

  it("detects year columns and maps rows", () => {
    const { accounts, years } = parseAnnuityGrid(grid);
    expect(years).toEqual([2026, 2027]);
    expect(accounts).toHaveLength(3); // no-id row dropped
    const bb = accounts[0]!;
    expect(bb.companyId).toBe("56136806766");
    expect(bb.wildcards).toEqual(["*better*buzz*"]);
    expect(bb.annualByYear).toEqual({ 2026: 1393.03 }); // 2027 blank → absent
  });
  it("omits zero/blank year amounts but keeps the account", () => {
    const { accounts } = parseAnnuityGrid(grid);
    expect(accounts[1]!.annualByYear).toEqual({}); // Clayton Tile, all zero/blank
    expect(accounts[2]!.annualByYear).toEqual({ 2026: 4005.9, 2027: 4200 });
  });
  it("throws when a required column is missing", () => {
    expect(() => parseAnnuityGrid([["NA End User", "Opportunity Name", "2026 Annuity"]])).toThrow(/missing required column/);
  });
});
