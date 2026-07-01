import { describe, it, expect } from "vitest";
import { overrideFor, mfAccount, nameIsElectricalSupply } from "./companyClassifyOverrides.js";

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

describe("nameIsElectricalSupply", () => {
  it("electrical-supply / distributor names → true", () => {
    for (const n of ["HERMITAGE ELECTRIC SUPPLY", "City Electric Supply", "A&S ELECTRICAL SUPPLY",
      "Consolidated Electrical Distributors", "Wholesale Electric Supply Co"]) {
      expect(nameIsElectricalSupply(n)).toBe(true);
    }
  });
  it("decorative showrooms mislabeled 'Distributor' are NOT pinned by name", () => {
    // The polluted sub_type says Distributor, but the NAME carries no electrical-supply
    // signal, so we don't force Functional — the AI's decorative call stands.
    expect(nameIsElectricalSupply("LIGHTING INCORPORATED")).toBe(false);
    expect(nameIsElectricalSupply("Reflections L&M")).toBe(false);
    expect(nameIsElectricalSupply("Stokes Electric Company")).toBe(false); // "electric company", not supply/distribution
    expect(nameIsElectricalSupply("")).toBe(false);
    expect(nameIsElectricalSupply(null)).toBe(false);
  });
});
