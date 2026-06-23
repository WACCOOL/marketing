import { describe, expect, it } from "vitest";
import { aliasKey, normalizeWithLearning, type OptionDef } from "./hubspotHeal.js";

const OPTIONS: OptionDef[] = [
  { label: "Commercial - Retail", value: "Commercial - Retail" },
  { label: "Closed Won", value: "Closed Won" },
];
const dealOptions = () => new Map([["project_type", OPTIONS]]);

describe("normalizeWithLearning", () => {
  it("applies a learned alias instantly and leaves other fields untouched", () => {
    const aliases = new Map([[aliasKey("project_type", "Comm Retail"), "Commercial - Retail"]]);
    const r = normalizeWithLearning("deals", "deal", { project_type: "Comm Retail", dealname: "x" }, new Map(), aliases);
    expect(r.properties.project_type).toBe("Commercial - Retail");
    expect(r.properties.dealname).toBe("x");
    expect(r.actions[0]).toMatchObject({ property: "project_type", action: "normalized", to: "Commercial - Retail" });
    expect(r.learn).toEqual([]); // alias hits aren't re-learned
  });

  it("keeps a value that's already a valid option (no action)", () => {
    const r = normalizeWithLearning("deals", "deal", { project_type: "Closed Won" }, dealOptions(), new Map());
    expect(r.actions).toEqual([]);
    expect(r.properties.project_type).toBe("Closed Won");
  });

  it("smart-matches a near-miss against cached options AND learns it", () => {
    const r = normalizeWithLearning("deals", "deal", { project_type: "Commercial - Retai" }, dealOptions(), new Map());
    expect(r.properties.project_type).toBe("Commercial - Retail");
    expect(r.actions[0]).toMatchObject({ action: "normalized" });
    expect(r.learn[0]).toMatchObject({
      objectType: "deals",
      property: "project_type",
      canonicalOption: "Commercial - Retail",
    });
  });

  it("drops a truly-unknown value (never auto-creates an option)", () => {
    const r = normalizeWithLearning("deals", "deal", { project_type: "Totally Unknown" }, dealOptions(), new Map());
    expect("project_type" in r.properties).toBe(false);
    expect(r.actions[0]).toMatchObject({ property: "project_type", action: "dropped" });
    expect(r.learn).toEqual([]);
  });

  it("leaves non-enum properties (no options, no alias) untouched", () => {
    const r = normalizeWithLearning("deals", "deal", { dealname: "X", amount: 5 }, dealOptions(), new Map());
    expect(r.actions).toEqual([]);
    expect(r.properties).toEqual({ dealname: "X", amount: 5 });
  });
});
