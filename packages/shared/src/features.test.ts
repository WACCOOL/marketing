import { describe, expect, it } from "vitest";
import {
  ALL_FEATURE_KEYS,
  computeFeatures,
  DEFAULT_FEATURES,
  featureForPath,
  firstAccessiblePath,
  hasFeature,
} from "./features.js";

describe("computeFeatures", () => {
  it("gives admins every feature regardless of overrides", () => {
    expect(computeFeatures("admin")).toEqual(ALL_FEATURE_KEYS);
    expect(
      computeFeatures("admin", [{ feature: "utm", allowed: false }]),
    ).toEqual(ALL_FEATURE_KEYS);
  });

  it("returns the role default when there are no overrides", () => {
    expect(computeFeatures("rep")).toEqual(DEFAULT_FEATURES.rep);
    expect(computeFeatures("internal")).toEqual(DEFAULT_FEATURES.internal);
  });

  it("grants internal users the Thom Knowledge (thom-content) feature by default", () => {
    expect(computeFeatures("internal")).toContain("thom-content");
    // Reps do not get it.
    expect(computeFeatures("rep")).not.toContain("thom-content");
  });

  it("adds a feature via an allow override", () => {
    expect(computeFeatures("rep", [{ feature: "utm", allowed: true }])).toContain(
      "utm",
    );
  });

  it("removes a feature via a deny override", () => {
    const result = computeFeatures("internal", [
      { feature: "ppt", allowed: false },
    ]);
    expect(result).not.toContain("ppt");
    expect(result).toContain("utm");
  });

  it("ignores unknown feature keys in overrides", () => {
    expect(
      computeFeatures("rep", [{ feature: "bogus", allowed: true }]),
    ).toEqual(DEFAULT_FEATURES.rep);
  });

  it("returns features in stable catalog order", () => {
    const result = computeFeatures("rep", [
      { feature: "data", allowed: true },
      { feature: "utm", allowed: true },
    ]);
    // Catalog order is utm, image, ppt, product, data, ...
    expect(result).toEqual(["utm", "image", "ppt", "data"]);
  });
});

describe("hasFeature", () => {
  it("is true for any feature when admin", () => {
    expect(hasFeature({ role: "admin", features: [] }, "data")).toBe(true);
  });
  it("checks the effective feature list for non-admins", () => {
    expect(hasFeature({ role: "rep", features: ["image"] }, "image")).toBe(true);
    expect(hasFeature({ role: "rep", features: ["image"] }, "data")).toBe(false);
  });
});

describe("featureForPath", () => {
  it("maps known routes to their feature", () => {
    expect(featureForPath("/builder")).toBe("utm");
    expect(featureForPath("/ppt/templates")).toBe("ppt-templates");
    expect(featureForPath("/data/pricing")).toBe("pricing");
    expect(featureForPath("/thom-content")).toBe("thom-content");
  });
  it("returns null for unrestricted routes", () => {
    expect(featureForPath("/admin")).toBeNull();
    expect(featureForPath("/totally-unknown")).toBeNull();
  });
});

describe("firstAccessiblePath", () => {
  it("sends admins to the builder", () => {
    expect(firstAccessiblePath([], true)).toBe("/builder");
  });
  it("sends a user to their highest-priority granted feature", () => {
    // rep default is [image, ppt] -> image wins by priority.
    expect(firstAccessiblePath(["image", "ppt"], false)).toBe("/app-image");
    expect(firstAccessiblePath(["ppt"], false)).toBe("/ppt/builder");
  });
  it("returns null when a non-admin has no features", () => {
    expect(firstAccessiblePath([], false)).toBeNull();
  });
});
