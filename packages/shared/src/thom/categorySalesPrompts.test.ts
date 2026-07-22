// =============================================================================
// Category-sales prompt composition (plan §D/§E, CS6): the CRM guidance's
// sales bullets exist ONLY when the tool is actually offered — flag off means
// ZERO mention anywhere in the prompt (static guidance would advertise a tool
// that doesn't exist and the model would promise or hallucinate sales
// aggregates); flag on means guidance and tool appear together, atomically.
// The public surface NEVER mentions it, flag or no flag.
// =============================================================================
import { describe, expect, it } from "vitest";
import { crmGuidance, internalSystem, publicSystem, systemFor } from "./prompts.js";
import { categorySalesEnabled } from "./agent.js";
import type { ThomEnv } from "./env.js";

const joined = (blocks: { text: string }[]): string => blocks.map((b) => b.text).join("\n");

describe("category-sales guidance composition (CS6)", () => {
  it("is absent from internalSystem() when the flag is off", () => {
    const text = joined(internalSystem(false, false, false));
    expect(text).not.toContain("crm_sales_by_category");
    // Default args too (existing callers unchanged).
    expect(joined(internalSystem())).not.toContain("crm_sales_by_category");
  });

  it("is present in internalSystem() when the flag is on, with the load-bearing rules", () => {
    const text = joined(internalSystem(false, false, true));
    expect(text).toContain("crm_sales_by_category");
    // Not real time / keep the as-of line / never extrapolate a partial day.
    expect(text).toMatch(/as-of line/);
    expect(text).toMatch(/never extrapolate a partial day/);
    // Backlog scope (CS4) and the per-customer routing seam.
    expect(text).toMatch(/backlog = WAC family only/);
    expect(text).toContain("crm_get_invoice_history");
    // crm_top_companies seam (plan §D routing seam).
    expect(text).toMatch(/crm_top_companies owns "top companies by sales"/);
    // 0068: fixture-type questions route through mounting_type, never name
    // matching; the downlight vs in-ground/landscape split is spelled out.
    expect(text).toMatch(/filter by mounting_type/);
    expect(text).toMatch(/never by name matching/);
    expect(text).toContain("'Recessed Downlights'");
    expect(text).toMatch(/NOT downlights/);
  });

  it("crmGuidance(false) is byte-identical to the pre-existing CRM block (no drift for flag-off callers)", () => {
    expect(crmGuidance(true).startsWith(crmGuidance(false))).toBe(true);
    expect(crmGuidance(false)).not.toContain("crm_sales_by_category");
  });

  it("NEVER appears on the public surface, regardless of flags", () => {
    expect(joined(publicSystem(true, true))).not.toContain("crm_sales_by_category");
    expect(joined(systemFor("public", true, true, true))).not.toContain("crm_sales_by_category");
  });

  it("systemFor threads the flag to the internal surface", () => {
    expect(joined(systemFor("internal", false, false, true))).toContain("crm_sales_by_category");
    expect(joined(systemFor("internal", false, false, false))).not.toContain("crm_sales_by_category");
  });
});

describe("categorySalesEnabled", () => {
  const env = (v?: string): ThomEnv => ({ AI: null, THOM_CATEGORY_SALES: v });
  it("is ON only for the explicit '1'", () => {
    expect(categorySalesEnabled(env("1"))).toBe(true);
    expect(categorySalesEnabled(env("0"))).toBe(false);
    expect(categorySalesEnabled(env(""))).toBe(false);
    expect(categorySalesEnabled(env(undefined))).toBe(false);
  });
});
