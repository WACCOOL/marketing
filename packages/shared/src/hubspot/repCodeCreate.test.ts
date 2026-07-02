import { describe, expect, it } from "vitest";
import {
  buildRepCodeCreateProperties,
  buildRepCodeTaskContent,
  normalizeRepCodeForCreate,
} from "./repCodeCreate.js";

describe("normalizeRepCodeForCreate", () => {
  it("accepts real rep-code shapes, trimmed and uppercased", () => {
    expect(normalizeRepCodeForCreate("OS")).toBe("OS");
    expect(normalizeRepCodeForCreate(" osx ")).toBe("OSX");
    expect(normalizeRepCodeForCreate("SDA")).toBe("SDA");
    expect(normalizeRepCodeForCreate("AB2")).toBe("AB2");
    expect(normalizeRepCodeForCreate("tla")).toBe("TLA");
  });

  it("rejects empty and whitespace values", () => {
    expect(normalizeRepCodeForCreate("")).toBeNull();
    expect(normalizeRepCodeForCreate("   ")).toBeNull();
    expect(normalizeRepCodeForCreate(null)).toBeNull();
    expect(normalizeRepCodeForCreate(undefined)).toBeNull();
  });

  it("rejects numeric AMT codes and junk", () => {
    expect(normalizeRepCodeForCreate("441")).toBeNull();
    expect(normalizeRepCodeForCreate("0")).toBeNull();
    expect(normalizeRepCodeForCreate(999)).toBeNull();
    expect(normalizeRepCodeForCreate("N/A")).toBeNull();
    expect(normalizeRepCodeForCreate("John Smith")).toBeNull();
    expect(normalizeRepCodeForCreate("x")).toBeNull(); // single char
    expect(normalizeRepCodeForCreate("ABCDEFGHI")).toBeNull(); // 9 chars
    expect(normalizeRepCodeForCreate("rep@wac.com")).toBeNull();
  });

  it("rejects placeholder values that pass the shape test", () => {
    for (const junk of ["NA", "none", "Null", "TBD", "TEST", "HOUSE", "unknown"]) {
      expect(normalizeRepCodeForCreate(junk)).toBeNull();
    }
  });
});

describe("buildRepCodeCreateProperties", () => {
  it("sets rep_code only when no owner resolved", () => {
    expect(buildRepCodeCreateProperties("OSX")).toEqual({ rep_code: "OSX" });
    expect(buildRepCodeCreateProperties("OSX", null)).toEqual({ rep_code: "OSX" });
    expect(buildRepCodeCreateProperties("OSX", "")).toEqual({ rep_code: "OSX" });
  });

  it("includes the owner when resolved", () => {
    expect(buildRepCodeCreateProperties("OSX", "12345")).toEqual({
      rep_code: "OSX",
      hubspot_owner_id: "12345",
    });
  });
});

describe("buildRepCodeTaskContent", () => {
  it("names the code and the triggering account", () => {
    const { subject, body } = buildRepCodeTaskContent({
      repCode: "ZZQ",
      sourceType: "company",
      sourceLabel: "0001234567",
      ownerSet: true,
    });
    expect(subject).toContain('"ZZQ"');
    expect(body).toContain("account 0001234567");
    expect(body).toContain("owner (ISR) was resolved");
  });

  it("describes the backfill scan for backfill-created codes", () => {
    const { subject, body } = buildRepCodeTaskContent({
      repCode: "ZZQ",
      sourceType: "backfill",
      sourceLabel: "3 companies and 7 deals",
      ownerSet: false,
    });
    expect(subject).toContain('"ZZQ"');
    expect(body).toContain("backfill scan found 3 companies and 7 deals");
    expect(body).toContain("No owner (ISR) could be resolved");
  });

  it("names the triggering quote and flags a missing owner", () => {
    const { subject, body } = buildRepCodeTaskContent({
      repCode: "ZZQ2",
      sourceType: "deal",
      sourceLabel: "20012345",
      ownerSet: false,
    });
    expect(subject).toContain('"ZZQ2"');
    expect(body).toContain("quote 20012345");
    expect(body).toContain("No owner (ISR) could be resolved");
  });
});
