import { describe, expect, it } from "vitest";
import { internalSystem, lightingExpertise, publicSystem, systemFor } from "./prompts.js";
import { GUARDRAIL_TEMPLATE, hasBareWac, normalizeCopy } from "./publicFilter.js";

/** Join a system-block array into one string for lint-style assertions. */
const joined = (blocks: { text: string }[]) => blocks.map((b) => b.text).join("\n\n");



describe("publicSystem copy-lint", () => {
  const text = joined(publicSystem());

  it("contains no em dash character", () => {
    expect(text).not.toContain("—");
  });

  it("contains no bare 'WAC' token (only real brand names)", () => {
    expect(hasBareWac(text)).toBe(false);
  });

  it("bakes in the exact competitor guardrail template", () => {
    expect(text).toContain(GUARDRAIL_TEMPLATE);
  });

  it("carries NO internal CRM / support-ticket guidance", () => {
    expect(text).not.toMatch(/crm_/i);
    expect(text).not.toMatch(/CRM/);
    expect(text).not.toMatch(/support-ticket|zendesk/i);
    expect(text).not.toMatch(/open orders|rep code|turnover/i);
  });

  it("mentions web_search research and the verify framing", () => {
    expect(text).toMatch(/web_search/);
    expect(text).toMatch(/verify/i);
  });

  it("forbids raising budget or pricing on the public surface", () => {
    expect(text).toMatch(/never ask about or bring up budget/i);
  });

  it("puts the cache breakpoint on the last block only", () => {
    const blocks = publicSystem();
    const cached = blocks.filter((b) => b.cache_control);
    expect(cached).toHaveLength(1);
    expect(blocks[blocks.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("lightingExpertise primer", () => {
  it("base block never commands the rank tool; the flagged block adds the bullet", () => {
    // R3: commanding an unadvertised tool re-creates the original superlative
    // failure — the bullet must compose ONLY when the tool is offered.
    expect(lightingExpertise(false)).not.toContain("rank_products_by_spec");
    expect(lightingExpertise(true)).toContain("rank_products_by_spec");
    expect(lightingExpertise(true)).toContain(lightingExpertise(false)); // base + bullet
  });

  it("passes normalizeCopy unchanged (authored to the public copy rules)", () => {
    for (const flag of [false, true]) {
      const primer = lightingExpertise(flag);
      expect(normalizeCopy(primer)).toBe(primer);
      expect(primer).not.toContain("—");
      expect(hasBareWac(primer)).toBe(false);
    }
  });

  it("carries the load-bearing content anchors", () => {
    const primer = lightingExpertise(false);
    // Range guard sentence, the "High Output" NAME trap, units discipline,
    // and the unconditional AHJ energy-code posture.
    expect(primer).toContain("never WAC Group specifications");
    expect(primer).toContain("high-output tape is still a per-foot accent product");
    expect(primer).toContain("candela");
    expect(primer).toContain("authority having jurisdiction");
    expect(primer).toContain("verbatim");
  });

  it("rides on BOTH surfaces, ahead of the tail cache breakpoint", () => {
    for (const flag of [false, true]) {
      for (const blocks of [internalSystem(flag), publicSystem(flag)]) {
        const texts = blocks.map((b) => b.text);
        expect(texts.some((t) => t.includes("Lighting expertise"))).toBe(true);
        // Breakpoint still on the LAST block only — and the primer isn't it.
        const cached = blocks.filter((b) => b.cache_control);
        expect(cached).toHaveLength(1);
        expect(blocks[blocks.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
        expect(texts[texts.length - 1]).not.toContain("Lighting expertise");
      }
    }
  });

  it("systemFor threads the spec-rank flag to both surfaces (default off)", () => {
    expect(systemFor("internal", true).some((b) => b.text.includes("rank_products_by_spec"))).toBe(true);
    expect(systemFor("public", true).some((b) => b.text.includes("rank_products_by_spec"))).toBe(true);
    expect(systemFor("internal").some((b) => b.text.includes("rank_products_by_spec"))).toBe(false);
    expect(systemFor("public").some((b) => b.text.includes("rank_products_by_spec"))).toBe(false);
  });
});

describe("internalSystem is unchanged by the public work", () => {
  it("still carries the CRM + web-search guidance (internal only)", () => {
    const text = joined(internalSystem());
    expect(text).toMatch(/Internal CRM access/);
    expect(text).toMatch(/crm_top_deals/);
    expect(text).toMatch(/web_search/);
  });

  it("systemFor routes by surface", () => {
    expect(systemFor("internal")).toEqual(internalSystem());
    expect(systemFor("public")).toEqual(publicSystem());
  });
});
