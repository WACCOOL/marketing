import { describe, expect, it } from "vitest";
import {
  DEAL_STAGE_IDS,
  UNIVERSAL_PIPELINE_ID,
  deriveDealStageAndCloseDate,
  lineItemDates,
  toEpochMs,
  type ExistingDealState,
} from "./dealStage.js";

const MS_2024_05_01 = Date.UTC(2024, 4, 1);
const MS_2024_06_15 = Date.UTC(2024, 5, 15);
const MS_2026_02_05 = Date.UTC(2026, 1, 5);

function existing(over: Partial<ExistingDealState> = {}): ExistingDealState {
  return {
    stageOfProject: "AWARDED",
    dealstage: DEAL_STAGE_IDS.awarded,
    closedateMs: null,
    pipeline: UNIVERSAL_PIPELINE_ID,
    quoteConversionDateMs: null,
    ...over,
  };
}

describe("toEpochMs", () => {
  it("accepts SAP and HubSpot date shapes", () => {
    expect(toEpochMs("05/01/2024")).toBe(MS_2024_05_01);
    expect(toEpochMs("2024-05-01")).toBe(MS_2024_05_01);
    expect(toEpochMs("20240501")).toBe(MS_2024_05_01);
    expect(toEpochMs(String(MS_2024_05_01))).toBe(MS_2024_05_01);
    expect(toEpochMs(MS_2024_05_01)).toBe(MS_2024_05_01);
    expect(toEpochMs("2024-05-01T00:00:00Z")).toBe(MS_2024_05_01);
    expect(toEpochMs("2024-05-01T12:30:00.500Z")).toBe(MS_2024_05_01 + 45_000_500);
  });

  it("rejects sentinels, blanks and garbage", () => {
    expect(toEpochMs("00/00/0000")).toBeNull();
    expect(toEpochMs("0000-00-00")).toBeNull();
    expect(toEpochMs("")).toBeNull();
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs(undefined)).toBeNull();
    expect(toEpochMs("not a date")).toBeNull();
  });
});

describe("lineItemDates", () => {
  it("reads raw SAP products and HubSpot line-item properties alike", () => {
    expect(
      lineItemDates([
        { quote_conversion_date: "05/01/2024", rejection_date: "00/00/0000" },
        { quote_conversion_date: "2024-06-15", rejection_date: "2026-02-05" },
        { quote_product_name: "no dates" },
      ]),
    ).toEqual([
      { conversionMs: MS_2024_05_01, rejectionMs: null },
      { conversionMs: MS_2024_06_15, rejectionMs: MS_2026_02_05 },
      { conversionMs: null, rejectionMs: null },
    ]);
  });
});

describe("deriveDealStageAndCloseDate — stage mapping (wf 1741406037)", () => {
  it.each([
    ["BIDDING", DEAL_STAGE_IDS.bidding],
    ["REBIDDING", DEAL_STAGE_IDS.bidding],
    ["BUDGETING", DEAL_STAGE_IDS.db],
    ["DESIGN PHASE", DEAL_STAGE_IDS.db],
    ["VALUE ENGINEERING", DEAL_STAGE_IDS.db],
    ["REJECTED", DEAL_STAGE_IDS.closedLost],
    ["COVID-19 HOLD", DEAL_STAGE_IDS.closedLost],
  ])("maps %s on a new deal (with pipeline)", (sop, stage) => {
    const r = deriveDealStageAndCloseDate({ stageOfProject: sop, existing: null, lineItems: [] });
    expect(r.properties).toEqual({ dealstage: stage, pipeline: UNIVERSAL_PIPELINE_ID });
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ property: "dealstage", to: stage, action: "derived" });
  });

  it("is case/whitespace-insensitive", () => {
    const r = deriveDealStageAndCloseDate({ stageOfProject: "  bidding ", existing: null, lineItems: [] });
    expect(r.properties.dealstage).toBe(DEAL_STAGE_IDS.bidding);
  });

  it("new AWARDED deal with a conversion date → Closed Won + closedate", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "AWARDED",
      existing: null,
      lineItems: [{ conversionMs: MS_2024_06_15, rejectionMs: null }, { conversionMs: MS_2024_05_01, rejectionMs: null }],
    });
    expect(r.properties).toEqual({
      dealstage: DEAL_STAGE_IDS.closedWon,
      pipeline: UNIVERSAL_PIPELINE_ID,
      closedate: String(MS_2024_05_01), // oldest
      quote_conversion_date: String(MS_2024_05_01),
    });
    expect(r.actions.map((a) => a.property).sort()).toEqual(["closedate", "dealstage", "quote_conversion_date"]);
    expect(r.actions.find((a) => a.property === "closedate")?.reason).toContain("closedate_set");
  });

  it("new AWARDED deal with no dates → Awarded, no closedate", () => {
    const r = deriveDealStageAndCloseDate({ stageOfProject: "AWARDED", existing: null, lineItems: [] });
    expect(r.properties).toEqual({ dealstage: DEAL_STAGE_IDS.awarded, pipeline: UNIVERSAL_PIPELINE_ID });
  });

  it("blank or unknown stage_of_project → no writes", () => {
    expect(deriveDealStageAndCloseDate({ stageOfProject: "", existing: null, lineItems: [] }).properties).toEqual({});
    expect(deriveDealStageAndCloseDate({ stageOfProject: "SOMETHING NEW", existing: null, lineItems: [] }).properties).toEqual({});
    expect(deriveDealStageAndCloseDate({ stageOfProject: null, existing: existing(), lineItems: [] }).properties).toEqual({});
  });
});

describe("deriveDealStageAndCloseDate — stage-write gate (manual moves survive)", () => {
  it("blocks when incoming stage_of_project equals the stored value", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "BIDDING",
      existing: existing({ stageOfProject: "BIDDING", dealstage: DEAL_STAGE_IDS.prequal }),
      lineItems: [],
    });
    expect(r.properties).toEqual({}); // human moved it to Pre-Qualified; SAP unchanged → survives
  });

  it("passes on change", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "REJECTED",
      existing: existing({ stageOfProject: "BIDDING", dealstage: DEAL_STAGE_IDS.bidding }),
      lineItems: [],
    });
    expect(r.properties).toEqual({ dealstage: DEAL_STAGE_IDS.closedLost });
  });

  it("no dealstage write when the target equals the current stage (diff-only)", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "BIDDING",
      existing: existing({ stageOfProject: "REBIDDING", dealstage: DEAL_STAGE_IDS.bidding }),
      lineItems: [],
    });
    expect(r.properties).toEqual({});
  });

  it("manual move to an open stage while SAP stays AWARDED → no stage/closedate writes (conversion mirror still runs)", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "AWARDED",
      existing: existing({ stageOfProject: "AWARDED", dealstage: DEAL_STAGE_IDS.bidding }),
      lineItems: [{ conversionMs: MS_2024_05_01, rejectionMs: null }],
    });
    expect(r.properties).toEqual({ quote_conversion_date: String(MS_2024_05_01) });
  });
});

describe("deriveDealStageAndCloseDate — Awarded→ClosedWon promotion (wf 1765878069)", () => {
  it("promotes a stuck Awarded deal when a conversion date exists (ungated)", () => {
    // The 307: stage_of_project unchanged, dealstage=Awarded, closedate unknown, lines converted.
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "AWARDED",
      existing: existing(),
      lineItems: [{ conversionMs: MS_2024_05_01, rejectionMs: null }],
    });
    expect(r.properties).toEqual({
      dealstage: DEAL_STAGE_IDS.closedWon,
      closedate: String(MS_2024_05_01),
      quote_conversion_date: String(MS_2024_05_01),
    });
    expect(r.actions.find((a) => a.property === "dealstage")?.reason).toContain("promotion");
  });

  it("promotes on a manually-set closedate with no conversion dates (wf A parity), closedate untouched", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "AWARDED",
      existing: existing({ closedateMs: MS_2024_06_15 }),
      lineItems: [],
    });
    expect(r.properties).toEqual({ dealstage: DEAL_STAGE_IDS.closedWon });
  });

  it("does not promote an Awarded deal with no closedate signal", () => {
    const r = deriveDealStageAndCloseDate({ stageOfProject: "AWARDED", existing: existing(), lineItems: [] });
    expect(r.properties).toEqual({});
  });
});

describe("deriveDealStageAndCloseDate — close-date maintenance", () => {
  it("corrects a drifted Closed Won closedate (the 4,618)", () => {
    const stamped = Date.UTC(2026, 5, 24, 20, 41, 3, 866); // backfill stage-move stamp
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "AWARDED",
      existing: existing({ dealstage: DEAL_STAGE_IDS.closedWon, closedateMs: stamped }),
      lineItems: [{ conversionMs: MS_2024_05_01, rejectionMs: null }],
    });
    expect(r.properties).toEqual({
      closedate: String(MS_2024_05_01),
      quote_conversion_date: String(MS_2024_05_01),
    });
    expect(r.actions[0]?.reason).toContain("closedate_corrected");
  });

  it("exact match → no-op (idempotent)", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "AWARDED",
      existing: existing({
        dealstage: DEAL_STAGE_IDS.closedWon,
        closedateMs: MS_2024_05_01,
        quoteConversionDateMs: MS_2024_05_01,
      }),
      lineItems: [{ conversionMs: MS_2024_05_01, rejectionMs: null }],
    });
    expect(r.properties).toEqual({});
    expect(r.actions).toEqual([]);
  });

  it("Closed Won with no conversion dates → closedate untouched", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "AWARDED",
      existing: existing({ dealstage: DEAL_STAGE_IDS.closedWon, closedateMs: MS_2024_06_15 }),
      lineItems: [],
    });
    expect(r.properties).toEqual({});
  });

  it("a line with BOTH conversion and rejection dates still counts as won", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "AWARDED",
      existing: existing(),
      lineItems: [{ conversionMs: MS_2024_05_01, rejectionMs: MS_2026_02_05 }],
    });
    expect(r.properties.dealstage).toBe(DEAL_STAGE_IDS.closedWon);
    expect(r.properties.closedate).toBe(String(MS_2024_05_01));
  });
});

describe("deriveDealStageAndCloseDate — lost close dates (toggle)", () => {
  const lost = existing({ stageOfProject: "REJECTED", dealstage: DEAL_STAGE_IDS.closedLost, closedateMs: MS_2024_05_01 });

  it("off by default → never writes", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "REJECTED",
      existing: lost,
      lineItems: [{ conversionMs: null, rejectionMs: MS_2026_02_05 }],
    });
    expect(r.properties).toEqual({});
  });

  it("on → newest rejection_date", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "REJECTED",
      existing: lost,
      lineItems: [
        { conversionMs: null, rejectionMs: MS_2024_06_15 },
        { conversionMs: null, rejectionMs: MS_2026_02_05 },
      ],
      options: { lostCloseDates: true },
    });
    expect(r.properties).toEqual({ closedate: String(MS_2026_02_05) });
    expect(r.actions[0]?.reason).toContain("newest rejection_date");
  });

  it("on, no rejection dates → quote_last_changed_date fallback; neither → no write", () => {
    const withFallback = deriveDealStageAndCloseDate({
      stageOfProject: "REJECTED",
      existing: lost,
      lineItems: [],
      quoteLastChangedMs: MS_2024_06_15,
      options: { lostCloseDates: true },
    });
    expect(withFallback.properties).toEqual({ closedate: String(MS_2024_06_15) });
    const neither = deriveDealStageAndCloseDate({
      stageOfProject: "REJECTED",
      existing: lost,
      lineItems: [],
      options: { lostCloseDates: true },
    });
    expect(neither.properties).toEqual({});
  });
});

describe("deriveDealStageAndCloseDate — reopen clear (toggle)", () => {
  const won = existing({ stageOfProject: "AWARDED", dealstage: DEAL_STAGE_IDS.closedWon, closedateMs: MS_2024_05_01 });

  it("on → clears closedate when the gate passes into an open stage", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "BIDDING",
      existing: won,
      lineItems: [],
      options: { clearCloseDateOnReopen: true },
    });
    expect(r.properties).toEqual({ dealstage: DEAL_STAGE_IDS.bidding, closedate: "" });
    expect(r.actions.find((a) => a.property === "closedate")?.reason).toContain("closedate_cleared");
  });

  it("off → stage only", () => {
    const r = deriveDealStageAndCloseDate({ stageOfProject: "BIDDING", existing: won, lineItems: [] });
    expect(r.properties).toEqual({ dealstage: DEAL_STAGE_IDS.bidding });
  });
});

describe("deriveDealStageAndCloseDate — pipeline guard", () => {
  it("never writes dealstage outside the Universal Pipeline; closedate still maintained", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "REJECTED",
      existing: existing({
        stageOfProject: "BIDDING",
        dealstage: "1390766200", // National Accounts Annuities stage
        pipeline: "914645760",
      }),
      lineItems: [{ conversionMs: MS_2024_05_01, rejectionMs: null }],
    });
    expect(r.properties.dealstage).toBeUndefined();
    // effective stage is the foreign-pipeline stage — not awarded/closedWon → no closedate write either
    expect(r.properties.closedate).toBeUndefined();
    // the conversion mirror is pipeline-agnostic
    expect(r.properties.quote_conversion_date).toBe(String(MS_2024_05_01));
  });

  it("maintains closedate on a foreign-pipeline deal whose stage matches awarded semantics is NOT attempted (stage ids are pipeline-specific)", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "AWARDED",
      existing: existing({ pipeline: "914645760", dealstage: DEAL_STAGE_IDS.awarded }),
      lineItems: [{ conversionMs: MS_2024_05_01, rejectionMs: null }],
    });
    // promotion blocked by pipeline guard; closedate: effective stage IS the awarded id → maintained
    expect(r.properties.dealstage).toBeUndefined();
    expect(r.properties.closedate).toBe(String(MS_2024_05_01));
  });
});

describe("deriveDealStageAndCloseDate — quote_conversion_date mirror (stage-agnostic)", () => {
  const openStage = existing({ stageOfProject: "BUDGETING", dealstage: DEAL_STAGE_IDS.db });

  it("sets the oldest conversion date on an open-stage deal without touching stage/closedate", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "BUDGETING", // unchanged → stage gate blocks
      existing: openStage,
      lineItems: [
        { conversionMs: MS_2024_06_15, rejectionMs: null },
        { conversionMs: MS_2024_05_01, rejectionMs: null },
        { conversionMs: null, rejectionMs: null },
      ],
    });
    expect(r.properties).toEqual({ quote_conversion_date: String(MS_2024_05_01) });
    expect(r.actions[0]?.reason).toContain("conversion_date_set");
  });

  it("corrects drift from the stored value", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "BUDGETING",
      existing: existing({ ...openStage, quoteConversionDateMs: MS_2024_06_15 }),
      lineItems: [{ conversionMs: MS_2024_05_01, rejectionMs: null }],
    });
    expect(r.properties).toEqual({ quote_conversion_date: String(MS_2024_05_01) });
    expect(r.actions[0]?.reason).toContain("conversion_date_corrected");
  });

  it("exact match → no write (idempotent)", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "BUDGETING",
      existing: existing({ ...openStage, quoteConversionDateMs: MS_2024_05_01 }),
      lineItems: [{ conversionMs: MS_2024_05_01, rejectionMs: null }],
    });
    expect(r.properties).toEqual({});
  });

  it("no conversion dates → never written, never cleared", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "BUDGETING",
      existing: existing({ ...openStage, quoteConversionDateMs: MS_2024_05_01 }),
      lineItems: [{ conversionMs: null, rejectionMs: MS_2026_02_05 }],
    });
    expect(r.properties).toEqual({});
  });

  it("written on new deals (alongside stage/pipeline)", () => {
    const r = deriveDealStageAndCloseDate({
      stageOfProject: "BUDGETING",
      existing: null,
      lineItems: [{ conversionMs: MS_2024_05_01, rejectionMs: null }],
    });
    expect(r.properties).toEqual({
      dealstage: DEAL_STAGE_IDS.db,
      pipeline: UNIVERSAL_PIPELINE_ID,
      quote_conversion_date: String(MS_2024_05_01),
    });
  });
});
