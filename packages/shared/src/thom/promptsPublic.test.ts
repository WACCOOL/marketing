import { describe, expect, it } from "vitest";
import { internalSystem, publicSystem, systemFor } from "./prompts.js";
import { GUARDRAIL_TEMPLATE } from "./publicFilter.js";

/** Join a system-block array into one string for lint-style assertions. */
const joined = (blocks: { text: string }[]) => blocks.map((b) => b.text).join("\n\n");

// A "bare WAC" is the token WAC NOT immediately followed by a real brand word.
const BARE_WAC = /\bWAC\b(?!\s+(?:Group|Lighting|Landscape|Modern|Forms))/;

describe("publicSystem copy-lint", () => {
  const text = joined(publicSystem());

  it("contains no em dash character", () => {
    expect(text).not.toContain("—");
  });

  it("contains no bare 'WAC' token (only real brand names)", () => {
    expect(BARE_WAC.test(text)).toBe(false);
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

  it("puts the cache breakpoint on the last block only", () => {
    const blocks = publicSystem();
    const cached = blocks.filter((b) => b.cache_control);
    expect(cached).toHaveLength(1);
    expect(blocks[blocks.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
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
