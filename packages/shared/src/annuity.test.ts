import { describe, it, expect } from "vitest";
import { parseWildcards, wildcardToRegExp, matchesAnyWildcard, parseAnnuityYearHeader } from "./annuity.js";

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
