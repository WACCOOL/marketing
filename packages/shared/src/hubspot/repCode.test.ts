import { describe, expect, it } from "vitest";
import {
  repCodeInactiveFromCompanyStatus,
  repCodeSyncProperties,
  resolveRepCodeSchema,
  type HsPropertyDef,
} from "./repCode.js";

const PROPS: HsPropertyDef[] = [
  { name: "agency", label: "Agency" },
  { name: "city", label: "City" },
  { name: "brands", label: "Brands" },
  { name: "state", label: "State", options: [{ label: "Texas", value: "Texas" }] },
  {
    name: "status",
    label: "Status",
    options: [
      { label: "Active", value: "true" },
      { label: "Inactive", value: "false" },
    ],
  },
];

describe("resolveRepCodeSchema", () => {
  it("resolves names by label and status option values by label", () => {
    const s = resolveRepCodeSchema(PROPS);
    expect(s).toEqual({
      agency: "agency",
      city: "city",
      brands: "brands",
      state: "state",
      status: "status",
      statusActiveValue: "true",
      statusInactiveValue: "false",
    });
  });
  it("matches labels case-insensitively even when internal names differ", () => {
    const s = resolveRepCodeSchema([
      { name: "rep_agency_name", label: "agency" },
      { name: "brand_list", label: "BRANDS" },
    ]);
    expect(s.agency).toBe("rep_agency_name");
    expect(s.brands).toBe("brand_list");
  });
  it("leaves unresolved fields null (never guesses)", () => {
    const s = resolveRepCodeSchema([{ name: "rep_code", label: "Rep Code" }]);
    expect(s.agency).toBeNull();
    expect(s.status).toBeNull();
    expect(s.statusInactiveValue).toBeNull();
  });
  it("works when status uses non-boolean option values (active/inactive)", () => {
    const s = resolveRepCodeSchema([
      {
        name: "status",
        label: "Status",
        options: [
          { label: "Active", value: "active" },
          { label: "Inactive", value: "inactive" },
          { label: "Unknown", value: "unknown" },
        ],
      },
    ]);
    expect(s.statusActiveValue).toBe("active");
    expect(s.statusInactiveValue).toBe("inactive");
  });
});

describe("repCodeSyncProperties", () => {
  const schema = resolveRepCodeSchema(PROPS);
  it("maps agency company fields, state abbr → full name, status → option value", () => {
    expect(
      repCodeSyncProperties(
        { companyName: "ACME REP CO", city: "Dallas", productBrand: "WAC", stateAbbr: "TX", companyStatus: "false" },
        schema,
      ),
    ).toEqual({ agency: "ACME REP CO", city: "Dallas", brands: "WAC", state: "Texas", status: "false" });
  });
  it('Active company status → the Active option value', () => {
    expect(repCodeSyncProperties({ companyStatus: "true" }, schema)).toEqual({ status: "true" });
  });
  it("skips blanks, unmapped states, unknown status, and unresolved props", () => {
    expect(
      repCodeSyncProperties({ companyName: "  ", stateAbbr: "ZZ", companyStatus: null }, schema),
    ).toEqual({});
  });
});

describe("repCodeInactiveFromCompanyStatus", () => {
  it("false → inactive, true → active, null/undefined → unknown", () => {
    expect(repCodeInactiveFromCompanyStatus("false")).toBe(true);
    expect(repCodeInactiveFromCompanyStatus("true")).toBe(false);
    expect(repCodeInactiveFromCompanyStatus(null)).toBeNull();
    expect(repCodeInactiveFromCompanyStatus(undefined)).toBeNull();
  });
});
