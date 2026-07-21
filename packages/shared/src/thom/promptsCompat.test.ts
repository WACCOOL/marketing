// =============================================================================
// COMPATIBILITY_GUIDANCE lints (plan v2.1 §C/§E): copy rules, placement ahead
// of the tail cache breakpoint on BOTH surfaces, and the load-bearing content
// anchors (source ordering, the true H/J/L rule, spec-sheet table caveat,
// existence/fitment split, public unresolved-code shape, dimmer rule).
// =============================================================================
import { describe, expect, it } from "vitest";
import { compatibilityGuidance, internalSystem, publicSystem } from "./prompts.js";
import { hasBareWac, normalizeCopy } from "./publicFilter.js";

describe("compatibilityGuidance copy lints", () => {
  it("passes normalizeCopy unchanged on BOTH surfaces (authored to the public copy rules)", () => {
    for (const surface of ["internal", "public"] as const) {
      const text = compatibilityGuidance(surface);
      expect(normalizeCopy(text)).toBe(text);
      expect(text).not.toContain("—");
      expect(hasBareWac(text)).toBe(false);
    }
  });

  it("carries the source-ordering rule: explicit rows authoritative, family expansion labeled verify-fitment", () => {
    const text = compatibilityGuidance("internal");
    expect(text).toContain("AUTHORITATIVE");
    expect(text).toContain("get_related_products");
    expect(text).toContain("search_docs");
    expect(text).toContain("same family or category, verify fitment");
    expect(text).toMatch(/Never invent or infer fitment/);
  });

  it("carries the TRUE track rule (PL2): name/variant-prefix markers, not the track table", () => {
    const text = compatibilityGuidance("internal");
    expect(text).toContain("H/J/L Track Luminaire");
    expect(text).toContain("search_products");
    expect(text).toMatch(/cannot list which heads fit a track/);
  });

  it("carries the spec-sheet accessory-table caveat (PL3)", () => {
    const text = compatibilityGuidance("internal");
    expect(text).toMatch(/scrambled column pairings/i);
    expect(text).toMatch(/NEVER reconstruct/);
    expect(text).toMatch(/cite the sheet/);
  });

  it("splits existence from fitment (PL8c)", () => {
    const text = compatibilityGuidance("internal");
    expect(text).toMatch(/never-assert-absence/);
    expect(text).toMatch(/honest non-confirmation/);
  });

  it("routes dimmer compatibility to search_docs with a citation", () => {
    expect(compatibilityGuidance("internal")).toMatch(/Dimmer compatibility:.*search_docs and cite/);
  });

  it("notes AiSpire custom-integrator availability (PL8b)", () => {
    for (const surface of ["internal", "public"] as const) {
      expect(compatibilityGuidance(surface)).toMatch(/AiSpire.*custom-integrator/);
    }
  });

  it("public shape: NEVER bare unresolved codes publicly; internal may see them (PL8a)", () => {
    const pub = compatibilityGuidance("public");
    expect(pub).toContain("NEVER show such a raw code");
    expect(pub).toContain("available through your WAC Group sales rep");
    const int = compatibilityGuidance("internal");
    expect(int).toContain("show the raw code to internal users");
    // The public variant never mentions the internal allowance and vice versa.
    expect(pub).not.toContain("internal users");
  });
});

describe("compatibility block placement (both surfaces, breakpoint preserved)", () => {
  it("rides on BOTH surfaces ahead of the tail cache breakpoint", () => {
    for (const blocks of [internalSystem(), publicSystem()]) {
      const texts = blocks.map((b) => b.text);
      expect(texts.some((t) => t.includes("Compatibility and accessories:"))).toBe(true);
      // Breakpoint still on the LAST block only — and the compat block isn't it.
      const cached = blocks.filter((b) => b.cache_control);
      expect(cached).toHaveLength(1);
      expect(blocks[blocks.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
      expect(texts[texts.length - 1]).not.toContain("Compatibility and accessories:");
    }
  });

  it("the public system embeds the PUBLIC variant (sales-rep framing), the internal one the internal variant", () => {
    const pub = publicSystem().map((b) => b.text).join("\n\n");
    expect(pub).toContain("NEVER show such a raw code");
    expect(pub).not.toContain("show the raw code to internal users");
    const int = internalSystem().map((b) => b.text).join("\n\n");
    expect(int).toContain("show the raw code to internal users");
  });
});
