// =============================================================================
// Thom plane-3 capture-forward staging (category-sales plan §C, CS14):
// buildDealQuoteLineRows / captureDealQuoteLines in hubspotPush.ts.
//
// The load-bearing rule: an EMPTY or MISSING payload.products is a NO-OP —
// NEVER a delete. SAP payload shapes vary by transaction type; an absent array
// must not be read as "this quote now has no lines" (the HubSpot-line-items-
// zeroed lesson: SAP zeroes, never deletes — neither do we). The lostValue()
// convention this plane will consume (max_amount WITH amount fallback, CS9) is
// pinned by packages/shared/src/hubspot/dealRollups.test.ts.
// =============================================================================
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDealQuoteLineRows, captureDealQuoteLines } from "./hubspotPush.js";

const NOW = new Date("2026-07-21T12:00:00Z");

const line = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  quote_product_name: "Q123-10",
  quote_line: "10",
  material__: "5011-27BK",
  material_description: "LEDme Step Light",
  item_quantity: "4",
  unit_price: "62.25",
  doc__currency: "USD",
  ...over,
});

describe("buildDealQuoteLineRows (pure, CS14)", () => {
  it("returns [] for an empty or missing products array (NO-OP, never delete)", () => {
    expect(buildDealQuoteLineRows("Q123", [], NOW)).toEqual([]);
    expect(buildDealQuoteLineRows("Q123", undefined, NOW)).toEqual([]);
    expect(buildDealQuoteLineRows("Q123", null, NOW)).toEqual([]);
    expect(buildDealQuoteLineRows("Q123", "not-an-array", NOW)).toEqual([]);
  });

  it("returns [] without a quote number (deal key = sap_quote_number)", () => {
    expect(buildDealQuoteLineRows(null, [line()], NOW)).toEqual([]);
    expect(buildDealQuoteLineRows("  ", [line()], NOW)).toEqual([]);
  });

  it("maps one row per line keyed by quote_product_name, with the push's net_value derivation", () => {
    const rows = buildDealQuoteLineRows("Q123", [line()], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({
      quote_product_name: "Q123-10",
      sap_quote_number: "Q123",
      quote_line: "10",
      material: "5011-27BK",
      material_description: "LEDme Step Light",
      quantity: 4,
      unit_price: 62.25,
      net_value: 249, // 4 x 62.25, rounded to cents
      currency: "USD",
    });
    expect(rows[0]!.raw_json).toMatchObject({ material__: "5011-27BK" });
  });

  it("keeps qty-0 lines (intentional quote text — the ROLLUP excludes them, not the mirror)", () => {
    const rows = buildDealQuoteLineRows("Q123", [line({ item_quantity: "0" })], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity).toBe(0);
    expect(rows[0]!.net_value).toBe(0);
  });

  it("skips lines without the PK and dedupes last-wins (mirroring upsertLineItems)", () => {
    const rows = buildDealQuoteLineRows(
      "Q123",
      [
        line({ quote_product_name: "" }),
        line({ quote_product_name: null }),
        line({ unit_price: "1" }),
        line({ unit_price: "2" }), // same PK — last wins
      ],
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unit_price).toBe(2);
  });

  it("stores null money fields when qty/price are unparseable", () => {
    const rows = buildDealQuoteLineRows("Q123", [line({ item_quantity: "n/a", unit_price: "" })], NOW);
    expect(rows[0]!).toMatchObject({ quantity: null, unit_price: null, net_value: null });
  });
});

function mockSb(): { sb: SupabaseClient; from: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> } {
  const upsert = vi.fn(async () => ({ error: null }));
  const from = vi.fn(() => ({ upsert }));
  return { sb: { from } as unknown as SupabaseClient, from, upsert };
}

describe("captureDealQuoteLines (I/O hook)", () => {
  it("is a strict NO-OP on empty/missing products — zero DB calls, no deletes issued (CS14)", async () => {
    const { sb, from } = mockSb();
    await captureDealQuoteLines(sb, "Q123", []);
    await captureDealQuoteLines(sb, "Q123", undefined);
    await captureDealQuoteLines(sb, null, [line()]);
    expect(from).not.toHaveBeenCalled();
  });

  it("upserts by quote_product_name (never delete) when lines are present", async () => {
    const { sb, from, upsert } = mockSb();
    await captureDealQuoteLines(sb, "Q123", [line()]);
    expect(from).toHaveBeenCalledWith("deal_quote_lines");
    expect(upsert).toHaveBeenCalledTimes(1);
    const [rows, opts] = upsert.mock.calls[0] as [unknown[], { onConflict: string }];
    expect(rows).toHaveLength(1);
    expect(opts).toEqual({ onConflict: "quote_product_name" });
  });

  it("is non-fatal: a staging error never throws into the push", async () => {
    const upsert = vi.fn(async () => ({ error: { message: "boom" } }));
    const sb = { from: vi.fn(() => ({ upsert })) } as unknown as SupabaseClient;
    await expect(captureDealQuoteLines(sb, "Q123", [line()])).resolves.toBeUndefined();
    const throwing = { from: vi.fn(() => { throw new Error("down"); }) } as unknown as SupabaseClient;
    await expect(captureDealQuoteLines(throwing, "Q123", [line()])).resolves.toBeUndefined();
  });
});
