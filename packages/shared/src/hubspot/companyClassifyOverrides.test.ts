import { describe, it, expect } from "vitest";
import { overrideFor, mfAccount, nameIsElectricalBusiness } from "./companyClassifyOverrides.js";

describe("overrideFor", () => {
  it("name overrides win (Graybar/CED→Functional, Ferguson→Decorative)", () => {
    expect(overrideFor({ name: "GRAYBAR ELECTRIC" })).toBe("Functional");
    expect(overrideFor({ name: "CED Greentech" })).toBe("Functional");
    expect(overrideFor({ name: "Ferguson Bath & Lighting" })).toBe("Decorative");
  });
  it("MF account → Decorative; no signal → null", () => {
    expect(overrideFor({ accountNumber: "MF01693" })).toBe("Decorative");
    expect(mfAccount("mf001")).toBe(true);
    expect(overrideFor({ name: "Some Lighting Co", accountNumber: "WF0022" })).toBeNull();
  });
});

describe("nameIsElectricalBusiness", () => {
  it("electrical business names → true (supply, distributor, co., contractor, trailing Electric)", () => {
    for (const n of ["HERMITAGE ELECTRIC SUPPLY", "City Electric Supply", "A&S ELECTRICAL SUPPLY",
      "Consolidated Electrical Distributors", "Wholesale Electric Supply Co", "Stokes Electric Company",
      "STOKES ELECTRIC", "ABC Electrical", "Wilcox Electric Co.", "Metro Electrical Contractors"]) {
      expect(nameIsElectricalBusiness(n)).toBe(true);
    }
  });
  it("decorative 'Lighting' names (incl. those mislabeled 'Distributor') are NOT pinned", () => {
    // The NAME carries no "Electric(al)" business token, so we don't force Functional —
    // the AI's decorative call stands.
    expect(nameIsElectricalBusiness("LIGHTING INCORPORATED")).toBe(false);
    expect(nameIsElectricalBusiness("Reflections L&M")).toBe(false);
    expect(nameIsElectricalBusiness("Hermitage Lighting Gallery")).toBe(false);
    expect(nameIsElectricalBusiness("Electric Avenue Lighting")).toBe(false); // "electric" mid-name, not a business token
    expect(nameIsElectricalBusiness("")).toBe(false);
    expect(nameIsElectricalBusiness(null)).toBe(false);
  });
});
