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

describe("constraint bullets (attribute-filter plan §C, THOM_SPEC_FILTER-gated)", () => {
  it("compose ONLY when the filter tool is offered (R3 rule)", () => {
    expect(lightingExpertise(false)).not.toContain("filter_products");
    expect(lightingExpertise(true)).not.toContain("filter_products");
    expect(lightingExpertise(false, true)).toContain("filter_products");
    expect(lightingExpertise(true, true)).toContain(lightingExpertise(true, false)); // base+rank preserved
  });

  it("never command the RANK tool when only the filter flag is on (each half flag-gated)", () => {
    expect(lightingExpertise(false, true)).not.toContain("rank_products_by_spec");
    // Both on: the division-of-labor bullet appears.
    expect(lightingExpertise(true, true)).toContain(
      "filter first, then compare the survivors",
    );
  });

  it("carry the load-bearing constraint contract lines", () => {
    const primer = lightingExpertise(true, true);
    // Constraints are requirements, not preferences.
    expect(primer).toContain("requirements, not preferences");
    expect(primer).toContain("MUST NOT present any product that violates a stated constraint");
    // O12: only filter results are recommendable while a constraint is active.
    expect(primer).toContain(
      "only products returned by filter_products may be recommended",
    );
    // O6: constraints persist across turns.
    expect(primer).toContain("remain binding until the user changes them");
    // O10: units pass through, never model arithmetic.
    expect(primer).toContain("unit parameter instead of converting values yourself");
    // Unknown-vs-violating honesty + near-miss labeling.
    expect(primer).toContain("without confirmed dimensions were not considered");
    expect(primer).toContain("does NOT meet the stated requirement, never as a match");
    // ADA verify-projection line.
    expect(primer).toContain("verify the projection on the spec sheet");
    // Addendum 1: metric answering from the tool's dual-unit values.
    expect(primer).toContain("unit system the user used");
    // 0068: fixture-type questions route through mounting_type, never name
    // matching; in-ground/landscape are never downlights.
    expect(primer).toContain("filter by the mounting_type parameter");
    expect(primer).toContain("never by matching words in product names");
    expect(primer).toContain("'Recessed Downlights'");
    expect(primer).toContain("never downlights");
  });

  it("carries the wall-orientation honesty bullet (no orientation data; long/cross axes, never an axis claim)", () => {
    const primer = lightingExpertise(false, true);
    expect(primer).toContain("does not record mounting orientation for wall-mounted fixtures");
    expect(primer).toContain("long axis and cross axis");
    expect(primer).toContain("never assert which axis is the width or the height");
    expect(primer).toContain("a vertically mounted sconce's long axis is its height");
    // Flag-gated with the rest of the filter bullets (R3).
    expect(lightingExpertise(true, false)).not.toContain("mounting orientation");
  });

  it("carries the no-re-present rule: a rejected product never comes back unless asked (Davis 2026-07-22)", () => {
    const primer = lightingExpertise(false, true);
    expect(primer).toContain("rejects or corrects a recommended product");
    expect(primer).toContain("never present that product or its card again");
    expect(primer).toContain("unless the user asks for it");
    expect(primer).toContain("continue with alternatives");
    // Flag-gated with the rest of the filter bullets (R3).
    expect(lightingExpertise(true, false)).not.toContain("rejects or corrects");
  });

  it("pass normalizeCopy unchanged (public copy lints) in every flag combination", () => {
    for (const rank of [false, true]) {
      for (const filter of [false, true]) {
        const primer = lightingExpertise(rank, filter);
        expect(normalizeCopy(primer)).toBe(primer);
        expect(primer).not.toContain("—");
        expect(hasBareWac(primer)).toBe(false);
      }
    }
  });

  it("systemFor threads the filter flag to both surfaces (default off), breakpoint intact", () => {
    for (const surface of ["internal", "public"] as const) {
      expect(systemFor(surface, true, true).some((b) => b.text.includes("filter_products"))).toBe(true);
      expect(systemFor(surface).some((b) => b.text.includes("filter_products"))).toBe(false);
      const blocks = systemFor(surface, true, true);
      const cached = blocks.filter((b) => b.cache_control);
      expect(cached).toHaveLength(1);
      expect(blocks[blocks.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
    }
  });
});

describe("product identifier rules (PPID vs variant SKU, Davis 2026-07-22)", () => {
  it("internal persona forbids presenting a PPID as a part number and asks for links + variant SKUs", () => {
    const text = joined(internalSystem());
    expect(text).toContain("PPID");
    expect(text).toMatch(/internal identifier/i);
    expect(text).toContain("variant-level SKUs");
    expect(text).toContain("markdown links to their product page");
  });

  it("public persona keeps the internal-identifier rule and adds the variant-SKU + link guidance", () => {
    const text = joined(publicSystem());
    expect(text).toContain("internal identifier");
    expect(text).toContain("qualifying variant SKU");
    expect(text).toContain("real orderable part number");
    expect(text).toContain("markdown links to their product page");
  });

  it("filter bullets route named applications through the application parameter, flag-gated (R3)", () => {
    const primer = lightingExpertise(true, true);
    expect(primer).toContain("application parameter");
    expect(primer).toContain("clearly labeled alternatives");
    expect(primer).toContain("never mixed into the main results");
    expect(primer).toContain("qualifying variant SKU(s)");
    // Off when the filter tool isn't offered — never command an unadvertised tool.
    expect(lightingExpertise(true, false)).not.toContain("application parameter");
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
