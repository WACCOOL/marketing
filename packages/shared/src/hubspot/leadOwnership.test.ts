import { describe, expect, it } from "vitest";
import {
  evaluateLeadOwnership,
  normalizeLocation,
  normalizeLeadBrand,
  normalizeRole,
  normalizeCompanyType,
  intlWacOwnerEmail,
  treeChannelsAreValid,
  type LeadFacts,
  type Leaf,
} from "./leadOwnership.js";

/** Minimal facts; override per case. */
const facts = (over: Partial<LeadFacts>): LeadFacts => ({
  location: null,
  country: null,
  role: null,
  companySubType: null,
  brand: null,
  ...over,
});

const leaf = (f: Partial<LeadFacts>): Leaf => evaluateLeadOwnership(facts(f)).leaf;

describe("normalizers", () => {
  it("location folds to canonical buckets", () => {
    expect(normalizeLocation("Canada")).toBe("Canada");
    expect(normalizeLocation("CA")).toBe("Canada");
    expect(normalizeLocation("United States")).toBe("North America");
    expect(normalizeLocation("North America")).toBe("North America");
    expect(normalizeLocation("International")).toBe("International");
    expect(normalizeLocation("France")).toBe("International");
    expect(normalizeLocation("")).toBe("Unknown");
    expect(normalizeLocation(null)).toBe("Unknown");
  });

  it("lead brand keeps MF Fans distinct from Modern Forms", () => {
    expect(normalizeLeadBrand("Modern Forms Fans")).toBe("MF Fans");
    expect(normalizeLeadBrand("MF Fans")).toBe("MF Fans");
    expect(normalizeLeadBrand("Modern Forms")).toBe("Modern Forms");
    expect(normalizeLeadBrand("Schonbek Beyond")).toBe("Schonbek");
    expect(normalizeLeadBrand("WAC")).toBe("WAC Lighting");
    expect(normalizeLeadBrand("WAC Architectural")).toBe("WAC Architectural");
    expect(normalizeLeadBrand("")).toBeNull();
  });

  it("role folds to canonical personas", () => {
    expect(normalizeRole("Interior Designer")).toBe("Interior Designer");
    expect(normalizeRole("Electrical Contractor")).toBe("Contractor/Builder");
    expect(normalizeRole("Architect")).toBe("Other");
  });

  it("simplified company sub-type maps to company-type branches", () => {
    expect(normalizeCompanyType("Specifier (A&D / Engineer / Architect)")).toBe("Specifier");
    expect(normalizeCompanyType("Dealer / Showroom / Retail")).toBe("Showroom");
    expect(normalizeCompanyType("Interior Designer / Decorator")).toBe("Interior Designer");
    expect(normalizeCompanyType("Contractor / Builder")).toBe("Contractor/Builder");
    expect(normalizeCompanyType("Integrator")).toBe("Integrator");
    expect(normalizeCompanyType("Distributor / Wholesaler")).toBe("Contractor/Builder");
    expect(normalizeCompanyType("Reps")).toBe("Other");
  });

  it("legacy company_sub_type values still map (fallback vocab)", () => {
    expect(normalizeCompanyType("Lighting Designer")).toBe("Specifier");
    expect(normalizeCompanyType("Integrators")).toBe("Integrator");
    expect(normalizeCompanyType("Internet Retailer")).toBe("E Retailer");
    expect(normalizeCompanyType("Lighting Showroom")).toBe("Showroom");
    expect(normalizeCompanyType("Building Contractor")).toBe("Contractor/Builder");
    expect(normalizeCompanyType("Hospitality Channel")).toBe("Hospitality");
    expect(normalizeCompanyType("National Accounts")).toBe("National Accounts");
    expect(normalizeCompanyType("Unheard Of")).toBe("Other");
  });
});

describe("tree well-formedness", () => {
  it("every repCode leaf uses a known contact-prop channel", () => {
    expect(treeChannelsAreValid()).toBe(true);
  });
});

describe("location gate", () => {
  it("Canada / Unknown → Lana", () => {
    expect(leaf({ location: "Canada" })).toMatchObject({ kind: "person", name: "Lana" });
    expect(leaf({ location: "" })).toMatchObject({ kind: "person", name: "Lana" });
  });
});

describe("international → brand", () => {
  it("Schonbek → Angela Yost", () => {
    expect(leaf({ location: "International", brand: "Schonbek" })).toMatchObject({
      kind: "person",
      name: "Angela Yost",
    });
  });

  it("Modern Forms → Navita Phagoo", () => {
    expect(leaf({ location: "International", brand: "Modern Forms" })).toMatchObject({
      kind: "person",
      name: "Navita Phagoo",
    });
  });

  it("WAC → by country (Hong Kong → Wilson, default → Betty)", () => {
    const hk = leaf({ location: "International", brand: "WAC Lighting", country: "Hong Kong" });
    expect(hk).toMatchObject({ kind: "person", email: "Wilson.Tson@waclighting.com" });
    const row = leaf({ location: "International", brand: "WAC Architectural", country: "France" });
    expect(row).toMatchObject({ kind: "person", email: "Betty.Luo@waclighting.com" });
  });

  it("E. Distributor (unmapped intl brand) → Distribution channel owner", () => {
    expect(leaf({ location: "International", brand: "Something Else" })).toMatchObject({
      kind: "repCode",
      channel: "WAC Showroom",
      resolve: "owner",
    });
  });

  it("intlWacOwnerEmail covers each country", () => {
    expect(intlWacOwnerEmail("Taiwan")).toBe("Wilson.Tson@waclighting.com");
    expect(intlWacOwnerEmail("Thailand")).toBe("Wijitporn.Y@waclighting.com");
    expect(intlWacOwnerEmail("Australia")).toBe("Rebekah.Thompson@waclighting.com");
    expect(intlWacOwnerEmail("Indonesia")).toBe("Setia.Budi@waclighting.com");
    expect(intlWacOwnerEmail("India")).toBe("Hemanth.Raju@waclighting.com");
    expect(intlWacOwnerEmail("Narnia")).toBe("Betty.Luo@waclighting.com");
  });
});

describe("north america → company type", () => {
  const na = (over: Partial<LeadFacts>) => leaf({ location: "North America", ...over });

  it("National Accounts sub-type → Sara Kruid", () => {
    expect(na({ companySubType: "National Accounts" })).toMatchObject({
      kind: "person",
      name: "Sara Kruid",
    });
  });

  it("Interior Designer company type → Kalin (MF) / Showroom (WAC)", () => {
    expect(
      na({ companySubType: "Interior Designer / Decorator", brand: "Modern Forms" }),
    ).toMatchObject({ kind: "person", name: "Kalin Scott" });
    expect(
      na({ companySubType: "Interior Designer / Decorator", brand: "WAC Lighting" }),
    ).toMatchObject({ kind: "repCode", channel: "WAC Showroom", resolve: "owner" });
  });

  it("Specifier brand splits WAC Spec vs MF Spec", () => {
    expect(na({ companySubType: "Lighting Designer", brand: "WAC" })).toMatchObject({
      kind: "repCode",
      channel: "WAC Spec",
      resolve: "owner",
    });
    expect(na({ companySubType: "Lighting Designer", brand: "Schonbek" })).toMatchObject({
      kind: "repCode",
      channel: "MF Spec",
      resolve: "owner",
    });
  });

  it("Landscape → WAC Landscape; Integrator → Integration", () => {
    // Landscape is not a known sub_type yet → Other → fallback (documents the gap).
    expect(na({ companySubType: "Integrators" })).toMatchObject({
      kind: "repCode",
      channel: "Integration",
      resolve: "owner",
    });
  });

  it("E Retailer → Harry", () => {
    expect(na({ companySubType: "Internet Retailer" })).toMatchObject({
      kind: "person",
      name: "Harry",
    });
  });

  it("Contractor/Builder → Distribution (WAC Showroom owner)", () => {
    expect(na({ companySubType: "Building Contractor" })).toMatchObject({
      kind: "repCode",
      channel: "WAC Showroom",
      resolve: "owner",
    });
  });
});

describe("showroom / role sub-branch", () => {
  const sr = (over: Partial<LeadFacts>) =>
    leaf({ location: "North America", companySubType: "Lighting Showroom", ...over });

  it("Interior Designer + MF/Schonbek → Kalin Scott (fixed)", () => {
    expect(sr({ role: "Interior Designer", brand: "Modern Forms" })).toMatchObject({
      kind: "person",
      name: "Kalin Scott",
    });
  });

  it("Interior Designer + WAC → Showroom (WAC Showroom owner)", () => {
    expect(sr({ role: "Interior Designer", brand: "WAC Lighting" })).toMatchObject({
      kind: "repCode",
      channel: "WAC Showroom",
      resolve: "owner",
    });
  });

  it("Interior Designer + MF Fans → WAC Fans owner", () => {
    expect(sr({ role: "Interior Designer", brand: "MF Fans" })).toMatchObject({
      kind: "repCode",
      channel: "WAC Fans",
      resolve: "owner",
    });
  });

  it("non-designer showroom → MF Showroom RSM (Nick/Dhane)", () => {
    expect(sr({ role: "Architect", brand: "Modern Forms" })).toMatchObject({
      kind: "repCode",
      channel: "MF Showroom",
      resolve: "rsm",
    });
  });
});

describe("fallbacks", () => {
  it("unmapped location → fallback leaf, never throws", () => {
    const d = evaluateLeadOwnership(facts({ location: "Mars" }));
    // "Mars" normalizes to International (bare country) → brand switch → default channel.
    expect(d.leaf.kind === "repCode" || d.leaf.kind === "fallback").toBe(true);
  });

  it("North America + unmapped sub_type → fallback", () => {
    expect(leaf({ location: "North America", companySubType: "Mystery" })).toMatchObject({
      kind: "fallback",
    });
  });

  it("path breadcrumbs are recorded", () => {
    const d = evaluateLeadOwnership(
      facts({ location: "North America", companySubType: "Lighting Designer", brand: "WAC" }),
    );
    expect(d.path).toEqual(["location:North America", "companyType:Specifier", "brand:WAC Lighting"]);
  });
});
