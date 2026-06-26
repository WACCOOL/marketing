import { describe, expect, it } from "vitest";
import { STATE_ABBR_TO_NAME, stateAbbrToName } from "./state.js";

describe("stateAbbrToName", () => {
  it("maps a US 2-letter code to its full name", () => {
    expect(stateAbbrToName("TX")).toBe("Texas");
    expect(stateAbbrToName("NY")).toBe("New York");
    expect(stateAbbrToName("DC")).toBe("District of Columbia");
  });
  it("maps Canadian provinces too", () => {
    expect(stateAbbrToName("ON")).toBe("Ontario");
    expect(stateAbbrToName("QC")).toBe("Quebec");
  });
  it("trims and upper-cases the input", () => {
    expect(stateAbbrToName(" tx ")).toBe("Texas");
    expect(stateAbbrToName("ca")).toBe("California");
  });
  it("returns null for blank, null, or unrecognized codes", () => {
    expect(stateAbbrToName("")).toBeNull();
    expect(stateAbbrToName("   ")).toBeNull();
    expect(stateAbbrToName(null)).toBeNull();
    expect(stateAbbrToName(undefined)).toBeNull();
    expect(stateAbbrToName("ZZ")).toBeNull();
    expect(stateAbbrToName("Texas")).toBeNull(); // full name in, not an abbr
  });
  it("covers all 50 states + DC + the Canadian provinces the workflow listed", () => {
    // Mirrors the workflow's VALUE_BY_ABBR exactly: 50 states + DC + 10 provinces.
    expect(Object.keys(STATE_ABBR_TO_NAME)).toHaveLength(61);
  });
});
