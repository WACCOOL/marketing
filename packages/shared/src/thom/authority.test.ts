import { describe, expect, it } from "vitest";
import {
  AUTHORITY_BAND_DEFAULT,
  AUTHORITY_TIERS,
  AUTHORITY_WEIGHT_DEFAULT,
  authorityBias,
  authorityWeightFor,
  detectDocsQueryIntent,
  rankedScore,
} from "./authority.js";

// Realistic RRF magnitudes from 0043's fusion: each branch contributes
// 1/(60+rank), so a rank-1-in-both-branches chunk scores ~0.0328 and a
// mid-pool single-branch chunk ~0.014.
const TOP_BOTH_BRANCHES = 1 / 61 + 1 / 61; // ≈ 0.0328
const MID_POOL = 1 / 72; // ≈ 0.0139

describe("authorityBias — the launch-gate invariants", () => {
  it("T0 neutral: weight 0 (the rollout default) biases nothing, ever", () => {
    expect(authorityBias(TOP_BOTH_BRANCHES, TOP_BOTH_BRANCHES, AUTHORITY_TIERS.wacGroupCorporate, 0)).toBe(0);
    expect(authorityBias(MID_POOL, TOP_BOTH_BRANCHES, AUTHORITY_TIERS.wacGroupCorporate, 0)).toBe(0);
  });

  it("T1 contamination: a mid-pool high-authority chunk is OUTSIDE the band and gets zero bias", () => {
    // The failure mode the plan names: weakly-relevant wacgroup /about chunk
    // (mid-pool, authority 1.5) must not float above the genuinely-best
    // product chunk (top, authority 1.0).
    const corporate = rankedScore(MID_POOL, TOP_BOTH_BRANCHES, AUTHORITY_TIERS.wacGroupCorporate);
    const product = rankedScore(TOP_BOTH_BRANCHES, TOP_BOTH_BRANCHES, AUTHORITY_TIERS.marketingBaseline);
    expect(authorityBias(MID_POOL, TOP_BOTH_BRANCHES, AUTHORITY_TIERS.wacGroupCorporate)).toBe(0);
    expect(product).toBeGreaterThan(corporate);
  });

  it("T2 band boundary: just below band * max receives zero; at/above receives the bias", () => {
    const max = TOP_BOTH_BRANCHES;
    const justBelow = AUTHORITY_BAND_DEFAULT * max - 1e-9;
    const atBand = AUTHORITY_BAND_DEFAULT * max;
    expect(authorityBias(justBelow, max, AUTHORITY_TIERS.wacGroupCorporate)).toBe(0);
    expect(authorityBias(atBand, max, AUTHORITY_TIERS.wacGroupCorporate)).toBeGreaterThan(0);
  });

  it("T3 goal-5 tiebreak: in-band near-tie, higher authority wins — corporate over brand over aiSpire", () => {
    const a = TOP_BOTH_BRANCHES;
    const b = TOP_BOTH_BRANCHES - 1e-4; // near-tie, both in band
    const wacGroup = rankedScore(b, a, AUTHORITY_TIERS.wacGroupCorporate);
    const brand = rankedScore(a, a, AUTHORITY_TIERS.brandCorporate);
    // Δauthority 0.3 ⇒ bias gap 0.0012 > the 1e-4 relevance gap: corporate wins the near-tie.
    expect(wacGroup).toBeGreaterThan(brand);
    // And the aiSpire tier (1.1) loses the same near-tie against a main brand (1.2).
    const aispire = rankedScore(a, a, AUTHORITY_TIERS.aispireCorporate);
    const mainBrand = rankedScore(b, a, AUTHORITY_TIERS.brandCorporate);
    expect(mainBrand).toBeGreaterThan(aispire - 1e-4 + 0); // brand's bias (0.0008) beats aispire's (0.0004) + its 1e-4 head start
  });

  it("bias magnitude is capped at 0.002 — smaller than a real rank-1 vs rank-5 gap", () => {
    const maxBias = authorityBias(
      TOP_BOTH_BRANCHES,
      TOP_BOTH_BRANCHES,
      AUTHORITY_TIERS.wacGroupCorporate,
    );
    expect(maxBias).toBeCloseTo(AUTHORITY_WEIGHT_DEFAULT * 0.5, 10);
    expect(maxBias).toBeLessThanOrEqual(0.002);
    // A rank-1-both vs rank-5-both fused gap (~0.004) exceeds the max bias:
    const rank5 = 1 / 65 + 1 / 65;
    expect(TOP_BOTH_BRANCHES - rank5).toBeGreaterThan(maxBias);
  });

  it("negative tiers get a small clamped negative nudge, never below -0.3 * weight", () => {
    const navBias = authorityBias(TOP_BOTH_BRANCHES, TOP_BOTH_BRANCHES, AUTHORITY_TIERS.resourceNav);
    expect(navBias).toBeCloseTo(AUTHORITY_WEIGHT_DEFAULT * -0.3, 10);
    // Even an absurd authority 0 clamps to the same floor.
    const floor = authorityBias(TOP_BOTH_BRANCHES, TOP_BOTH_BRANCHES, 0);
    expect(floor).toBe(navBias);
  });

  it("tier ordering matches the ratified hierarchy", () => {
    const t = AUTHORITY_TIERS;
    expect(t.wacGroupCorporate).toBeGreaterThan(t.brandCorporate);
    expect(t.brandCorporate).toBeGreaterThan(t.aispireCorporate);
    expect(t.aispireCorporate).toBeGreaterThan(t.marketingBaseline);
    expect(t.marketingBaseline).toBeGreaterThan(t.news);
    expect(t.news).toBeGreaterThan(t.webProduct);
    expect(t.webProduct).toBeGreaterThan(t.resourceNav);
  });
});

describe("detectDocsQueryIntent + authorityWeightFor (D.2 intent gating)", () => {
  it("SKU/model-code-shaped queries are product intent", () => {
    expect(detectDocsQueryIntent("FR-W1801 warranty")).toBe("product");
    expect(detectDocsQueryIntent("cutout size for A2RU-447-27")).toBe("product");
    expect(detectDocsQueryIntent("spec sheet for 1302E")).toBe("product");
    expect(detectDocsQueryIntent("dimming for ppid 4324")).toBe("product");
  });

  it("company/capability-shaped queries are company intent", () => {
    expect(detectDocsQueryIntent("who is WAC Group")).toBe("company");
    expect(detectDocsQueryIntent("tell me about your manufacturing capabilities")).toBe("company");
    expect(detectDocsQueryIntent("sustainability commitments")).toBe("company");
  });

  it("everything else is ambiguous", () => {
    expect(detectDocsQueryIntent("how do I clean crystal")).toBe("ambiguous");
  });

  it("gate off ⇒ weight 0 for EVERY intent (pre-0054 ordering preserved)", () => {
    expect(authorityWeightFor("product", false)).toBe(0);
    expect(authorityWeightFor("company", false)).toBe(0);
    expect(authorityWeightFor("ambiguous", false)).toBe(0);
  });

  it("gate on ⇒ product stays 0; company/ambiguous get the default λ", () => {
    expect(authorityWeightFor("product", true)).toBe(0);
    expect(authorityWeightFor("company", true)).toBe(AUTHORITY_WEIGHT_DEFAULT);
    expect(authorityWeightFor("ambiguous", true)).toBe(AUTHORITY_WEIGHT_DEFAULT);
  });
});
