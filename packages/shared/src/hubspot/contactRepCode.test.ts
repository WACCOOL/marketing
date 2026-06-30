import { describe, expect, it } from "vitest";
import {
  CHANNEL_TO_CONTACT_PROP,
  CONTACT_REP_CODE_PROPS,
  buildContactRepCodeProps,
} from "./contactRepCode.js";

describe("contact rep-code props", () => {
  it("maps all 10 channels to distinct rep_code_* properties", () => {
    const props = Object.values(CHANNEL_TO_CONTACT_PROP);
    expect(props).toHaveLength(10);
    expect(new Set(props).size).toBe(10);
    expect(props.every((p) => /^rep_code_[a-z0-9_]+$/.test(p))).toBe(true);
    expect(CONTACT_REP_CODE_PROPS).toEqual(props);
  });

  it("fills every owned property, mapping channels to their rep code", () => {
    const props = buildContactRepCodeProps({
      "WAC Showroom": "ABC",
      "MF Spec": "XYZ",
    });
    // every owned property present
    expect(Object.keys(props).sort()).toEqual([...CONTACT_REP_CODE_PROPS].sort());
    expect(props.rep_code_wac_showroom).toBe("ABC");
    expect(props.rep_code_mf_spec).toBe("XYZ");
  });

  it("clears (\"\") channels with no rep code for the zip", () => {
    const props = buildContactRepCodeProps({ "WAC Showroom": "ABC" });
    expect(props.rep_code_wac_showroom).toBe("ABC");
    expect(props.rep_code_wac_spec).toBe("");
    expect(props.rep_code_contract_mf).toBe("");
  });

  it("ignores channels with no matching property", () => {
    const props = buildContactRepCodeProps({ "Unknown Channel": "ZZZ" });
    expect(Object.values(props).every((v) => v === "")).toBe(true);
    expect(props).not.toHaveProperty("Unknown Channel");
  });

  it("treats a non-string code as empty", () => {
    const props = buildContactRepCodeProps({
      "WAC Showroom": undefined as unknown as string,
    });
    expect(props.rep_code_wac_showroom).toBe("");
  });
});
