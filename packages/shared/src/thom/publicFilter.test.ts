import { describe, expect, it, vi } from "vitest";
import {
  GUARDRAIL_TEMPLATE,
  normalizeCopy,
  parseFlagged,
  screenCompetitors,
  screenCompetitorsSync,
} from "./publicFilter.js";

describe("normalizeCopy", () => {
  it("replaces an em dash with a comma", () => {
    expect(normalizeCopy("Bright, warm — and dimmable")).toBe("Bright, warm, and dimmable");
    expect(normalizeCopy("A—B")).toBe("A, B");
  });

  it("leaves text with no em dash unchanged", () => {
    const s = "A clean sentence with no long dashes.";
    expect(normalizeCopy(s)).toBe(s);
  });

  it("upgrades a standalone bare WAC to WAC Group", () => {
    expect(normalizeCopy("Check the WAC 3011 downlight")).toBe("Check the WAC Group 3011 downlight");
    // Primary-brand and hyphenated product names are NEVER expanded:
    expect(normalizeCopy("WAC Architectural offers indoor and outdoor lines")).toBe(
      "WAC Architectural offers indoor and outdoor lines",
    );
    expect(normalizeCopy("the WAC-Mesh PSC 96W driver")).toBe("the WAC-Mesh PSC 96W driver");
    expect(normalizeCopy("see WAC Home for residential")).toBe("see WAC Home for residential");
    expect(normalizeCopy("Made by WAC.")).toBe("Made by WAC Group.");
    expect(normalizeCopy("WAC's catalog")).toBe("WAC Group's catalog");
  });

  it("preserves real brand names (never corrupts them)", () => {
    for (const brand of ["WAC Lighting", "WAC Group", "WAC Landscape", "WAC Modern Forms"]) {
      expect(normalizeCopy(`The ${brand} line`)).toBe(`The ${brand} line`);
    }
  });

  it("is idempotent", () => {
    const once = normalizeCopy("WAC makes it — really");
    expect(normalizeCopy(once)).toBe(once);
    expect(once).toBe("WAC Group makes it, really");
  });

  it("returns falsy input untouched", () => {
    expect(normalizeCopy("")).toBe("");
  });
});

describe("screenCompetitorsSync", () => {
  it("replaces on a denylisted competitor brand", () => {
    const out = screenCompetitorsSync("You could use a Lutron dimmer with 600W capacity.");
    expect(out.flagged).toBe(true);
    expect(out.text).toBe(GUARDRAIL_TEMPLATE);
  });

  it("catches other denylisted brands case-insensitively", () => {
    for (const name of ["signify", "Philips", "CREE", "Kichler", "Cooper"]) {
      expect(screenCompetitorsSync(`Consider ${name} here`).flagged).toBe(true);
    }
  });

  it("passes clean WAC-only text through unchanged", () => {
    const clean = "The WAC Group Aether downlight delivers 1200 lumens at 3000K.";
    const out = screenCompetitorsSync(clean);
    expect(out.flagged).toBe(false);
    expect(out.text).toBe(clean);
  });
});

describe("parseFlagged", () => {
  it("reads a flagged JSON object", () => {
    expect(parseFlagged('{"flagged": true}')).toBe(true);
    expect(parseFlagged('here you go: {"flagged":true} ')).toBe(true);
  });
  it("returns false for not-flagged or unparseable", () => {
    expect(parseFlagged('{"flagged": false}')).toBe(false);
    expect(parseFlagged("no json here")).toBe(false);
    expect(parseFlagged("{ broken")).toBe(false);
  });
});

describe("screenCompetitors (async)", () => {
  it("short-circuits on the denylist without calling the judge", async () => {
    const judge = vi.fn().mockResolvedValue(false);
    const out = await screenCompetitors("A Lutron system", { judge });
    expect(out).toBe(GUARDRAIL_TEMPLATE);
    expect(judge).not.toHaveBeenCalled();
  });

  it("replaces when the judge flags clean-looking text", async () => {
    const judge = vi.fn().mockResolvedValue(true);
    const out = await screenCompetitors("Some competitor by another name", { judge });
    expect(out).toBe(GUARDRAIL_TEMPLATE);
  });

  it("keeps text when neither the denylist nor the judge flags", async () => {
    const judge = vi.fn().mockResolvedValue(false);
    const clean = "The WAC Group Aether line fits that use case.";
    expect(await screenCompetitors(clean, { judge })).toBe(clean);
  });

  it("falls back to denylist-only when the judge throws", async () => {
    const judge = vi.fn().mockRejectedValue(new Error("network"));
    const clean = "A WAC Group fixture works here.";
    expect(await screenCompetitors(clean, { judge })).toBe(clean);
  });

  it("works with no judge (denylist-only)", async () => {
    expect(await screenCompetitors("A Cree fixture")).toBe(GUARDRAIL_TEMPLATE);
    expect(await screenCompetitors("A WAC Group fixture")).toBe("A WAC Group fixture");
  });
});
