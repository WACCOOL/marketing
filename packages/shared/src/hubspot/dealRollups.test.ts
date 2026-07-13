import { describe, expect, it } from "vitest";
import {
  DEAL_TO_COMPANY_PRIMARY_TYPE_ID,
  ROLLUP_PROP_PRIOR_YEAR,
  ROLLUP_PROP_PRIOR_YTD,
  ROLLUP_PROP_YTD,
  aggregateDealRollups,
  buildRollupWrites,
  dealRollupWindows,
  pickRollupCompanyId,
  type RollupDeal,
} from "./dealRollups.js";

const DAY = 86_400_000;
// Mid-day UTC on 2026-07-06 — mirrors a real daily run.
const NOW = Date.UTC(2026, 6, 6, 14, 30);

const deal = (over: Partial<RollupDeal>): RollupDeal => ({
  companyId: "c1",
  closedateMs: Date.UTC(2026, 2, 15),
  amount: "100",
  ...over,
});

describe("dealRollupWindows", () => {
  it("mid-year: prior-YTD cutoff is the whole same date last year", () => {
    const w = dealRollupWindows(NOW);
    expect(w.ytdStartMs).toBe(Date.UTC(2026, 0, 1));
    expect(w.priorStartMs).toBe(Date.UTC(2025, 0, 1));
    expect(w.priorYtdEndMs).toBe(Date.UTC(2025, 6, 7)); // 2025-07-06 inclusive
    expect(w.priorYearEndMs).toBe(Date.UTC(2026, 0, 1));
  });

  it("Jan 1: YTD covers only today; prior YTD covers only Jan 1 last year", () => {
    const w = dealRollupWindows(Date.UTC(2027, 0, 1, 9));
    expect(w.ytdStartMs).toBe(Date.UTC(2027, 0, 1));
    expect(w.priorYtdEndMs).toBe(Date.UTC(2026, 0, 2));
  });

  it("Dec 31: prior YTD spans the full prior year (≈ prior-year total)", () => {
    const w = dealRollupWindows(Date.UTC(2026, 11, 31, 12));
    expect(w.priorYtdEndMs).toBe(Date.UTC(2026, 0, 1));
    expect(w.priorYtdEndMs).toBe(w.priorYearEndMs);
  });

  it("Feb 29 in a leap year: prior-year cutoff rolls to Mar 1 (documented)", () => {
    const w = dealRollupWindows(Date.UTC(2028, 1, 29, 8));
    // 2027 has no Feb 29 — Date.UTC rolls to Mar 1, +1 day → Mar 2 exclusive.
    expect(w.priorYtdEndMs).toBe(Date.UTC(2027, 2, 2));
  });
});

describe("aggregateDealRollups", () => {
  const w = dealRollupWindows(NOW);

  it("buckets by closedate with inclusive boundaries", () => {
    const rows = aggregateDealRollups(
      [
        deal({ closedateMs: Date.UTC(2026, 0, 1) }), // first ms of current year → YTD
        deal({ closedateMs: Date.UTC(2025, 6, 6) }), // cutoff day → prior YTD + prior year
        deal({ closedateMs: Date.UTC(2025, 6, 7) }), // day after cutoff → prior year only
        deal({ closedateMs: Date.UTC(2025, 0, 1) }), // first ms of prior year → both prior buckets
      ],
      w,
    );
    expect(rows.get("c1")).toEqual({
      [ROLLUP_PROP_YTD]: 100,
      [ROLLUP_PROP_PRIOR_YTD]: 200,
      [ROLLUP_PROP_PRIOR_YEAR]: 300,
    });
  });

  it("sums multiple deals per company and rounds to cents", () => {
    const rows = aggregateDealRollups(
      [deal({ amount: "10.005" }), deal({ amount: "20.10" }), deal({ companyId: "c2", amount: 5 })],
      w,
    );
    expect(rows.get("c1")![ROLLUP_PROP_YTD]).toBe(30.11);
    expect(rows.get("c2")![ROLLUP_PROP_YTD]).toBe(5);
  });

  it("skips blank/NaN amounts and null closedates entirely", () => {
    const rows = aggregateDealRollups(
      [
        deal({ amount: null }),
        deal({ amount: "" }),
        deal({ amount: "abc" }),
        deal({ closedateMs: null }),
      ],
      w,
    );
    expect(rows.size).toBe(0);
  });

  it("keeps a company whose only deal falls outside every window (0-filled)", () => {
    // e.g. a won deal post-dated later this year: still 0s so staleness clears.
    const rows = aggregateDealRollups([deal({ closedateMs: Date.UTC(2026, 11, 25) })], w);
    expect(rows.get("c1")).toEqual({
      [ROLLUP_PROP_YTD]: 0,
      [ROLLUP_PROP_PRIOR_YTD]: 0,
      [ROLLUP_PROP_PRIOR_YEAR]: 0,
    });
  });
});

describe("pickRollupCompanyId", () => {
  const primary = { companyId: "p", typeIds: [DEAL_TO_COMPANY_PRIMARY_TYPE_ID, 341] };
  const other = { companyId: "s", typeIds: [341] };

  it("prefers the primary association over others", () => {
    expect(pickRollupCompanyId([other, primary])).toBe("p");
  });

  it("falls back to the sole associated company", () => {
    expect(pickRollupCompanyId([other])).toBe("s");
    // duplicate rows for the same company still count as one
    expect(pickRollupCompanyId([other, { companyId: "s", typeIds: [123] }])).toBe("s");
  });

  it("returns null for multiple companies with no primary, or none at all", () => {
    expect(pickRollupCompanyId([other, { companyId: "t", typeIds: [341] }])).toBeNull();
    expect(pickRollupCompanyId([])).toBeNull();
  });
});

describe("buildRollupWrites", () => {
  const freshProps = { [ROLLUP_PROP_YTD]: 10, [ROLLUP_PROP_PRIOR_YTD]: 0, [ROLLUP_PROP_PRIOR_YEAR]: 5 };

  it("keeps fresh values and zero-fills companies that dropped out (ALL rollup props)", () => {
    const writes = buildRollupWrites(new Map([["c1", freshProps]]), ["c1", "c2"]);
    expect(writes.get("c1")).toEqual(freshProps);
    const zeroed = writes.get("c2")!;
    expect(Object.values(zeroed).every((v) => v === 0)).toBe(true);
    expect(Object.keys(zeroed).length).toBeGreaterThanOrEqual(6);
  });

  it("first run (nothing existing) writes only the fresh set", () => {
    const writes = buildRollupWrites(new Map([["c1", freshProps]]), []);
    expect([...writes.keys()]).toEqual(["c1"]);
  });
});

// --- extended rollups (lost / pipeline / projection) --------------------------

import {
  PIPELINE_FRESH_DAYS,
  ROLLUP_PROP_PIPELINE,
  ROLLUP_PROP_PROJECTED,
  ROLLUP_PROP_YTD_LOST,
  adjustedValueHitRate,
  aggregateExtendedRollups,
  lostValue,
  zeroRollupProps,
  type LostRollupDeal,
  type OpenRollupDeal,
  type WonRollupDeal,
} from "./dealRollups.js";

const wonDeal = (over: Partial<WonRollupDeal>): WonRollupDeal => ({
  companyId: "c1",
  closedateMs: Date.UTC(2026, 2, 15),
  createdateMs: Date.UTC(2026, 0, 10),
  amount: "100",
  ...over,
});

const lostDeal = (over: Partial<LostRollupDeal>): LostRollupDeal => ({
  companyId: "c1",
  closedateMs: Date.UTC(2026, 3, 1),
  createdateMs: Date.UTC(2026, 0, 5),
  maxAmount: "500",
  amount: "0",
  ...over,
});

const openDeal = (over: Partial<OpenRollupDeal>): OpenRollupDeal => ({
  companyId: "c1",
  createdateMs: NOW - 30 * DAY,
  amount: "1000",
  ...over,
});

describe("lostValue", () => {
  it("prefers max_amount, falls back to amount", () => {
    expect(lostValue({ maxAmount: "500", amount: "20" })).toBe(500);
    expect(lostValue({ maxAmount: "", amount: "20" })).toBe(20);
    expect(lostValue({ maxAmount: null, amount: null })).toBeNull();
  });
});

describe("adjustedValueHitRate", () => {
  it("won/(won+lost) on current-year closes, excluding same-day closes", () => {
    const w = dealRollupWindows(NOW);
    const won = [
      wonDeal({ amount: "300" }),
      // same-day close (retroactive quote) — excluded from the rate
      wonDeal({ amount: "9999", closedateMs: Date.UTC(2026, 1, 3), createdateMs: Date.UTC(2026, 1, 3, 8) }),
      // prior-year close — outside the YTD rate window
      wonDeal({ amount: "9999", closedateMs: Date.UTC(2025, 5, 1) }),
    ];
    const lost = [lostDeal({ maxAmount: "700" })];
    expect(adjustedValueHitRate(won, lost, w.ytdStartMs, w.nowMs)).toBeCloseTo(300 / 1000, 10);
  });

  it("trailing window includes prior-year closes", () => {
    const w = dealRollupWindows(NOW);
    const won = [wonDeal({ amount: "100", closedateMs: Date.UTC(2025, 9, 1) })];
    expect(adjustedValueHitRate(won, [], NOW - 365 * DAY, NOW)).toBe(1);
  });

  it("null when nothing resolved", () => {
    const w = dealRollupWindows(NOW);
    expect(adjustedValueHitRate([], [], w.ytdStartMs, w.nowMs)).toBeNull();
  });
});

describe("aggregateExtendedRollups", () => {
  const w = dealRollupWindows(NOW);
  const rates = { pipelineYield: 0.25, visibilityRate: 0.2 };

  it("fills all six properties, values lost at max_amount, weights pipeline by hit rate", () => {
    const out = aggregateExtendedRollups(
      {
        won: [wonDeal({ amount: "100" })],
        lost: [lostDeal({ maxAmount: "500" })],
        open: [openDeal({ amount: "1000" })],
      },
      w,
      rates,
    );
    const p = out.get("c1")!;
    expect(Object.keys(p).sort()).toEqual(Object.keys(zeroRollupProps()).sort());
    expect(p[ROLLUP_PROP_YTD]).toBe(100);
    expect(p[ROLLUP_PROP_YTD_LOST]).toBe(500);
    expect(p[ROLLUP_PROP_PIPELINE]).toBe(250); // 1000 × 0.25
    expect(p[ROLLUP_PROP_PROJECTED]).toBe(1750); // (100 + 250) / 0.2
  });

  it("pipeline drops deals outside the fresh window or past the Nov-1 ceiling", () => {
    const out = aggregateExtendedRollups(
      {
        won: [],
        lost: [],
        open: [
          openDeal({ createdateMs: NOW - (PIPELINE_FRESH_DAYS + 5) * DAY }), // stale
          openDeal({ createdateMs: Date.UTC(2026, 10, 15) }), // after Nov 1
          openDeal({ createdateMs: NOW - 10 * DAY, amount: "400" }),
        ],
      },
      w,
      rates,
    );
    expect(out.get("c1")![ROLLUP_PROP_PIPELINE]).toBe(100); // only 400 × 0.25
  });

  it("null rates zero the derived props instead of dividing", () => {
    const out = aggregateExtendedRollups(
      { won: [wonDeal({})], lost: [], open: [openDeal({})] },
      w,
      { pipelineYield: null, visibilityRate: null },
    );
    expect(out.get("c1")![ROLLUP_PROP_PIPELINE]).toBe(0);
    expect(out.get("c1")![ROLLUP_PROP_PROJECTED]).toBe(0);
  });

  it("lost outside the current year does not count", () => {
    const out = aggregateExtendedRollups(
      { won: [], lost: [lostDeal({ closedateMs: Date.UTC(2025, 10, 1) })], open: [] },
      w,
      rates,
    );
    expect(out.size).toBe(0);
  });
});

// --- future creation (seasonality) --------------------------------------------

import {
  ROLLUP_PROP_CREATION,
  creationSeasonality,
  creationValueInWindow,
  expectedFutureCreationWins,
  pipelineInYearYield,
  type CreationCohortDeal,
} from "./dealRollups.js";

const cohortDeal = (over: Partial<CreationCohortDeal>): CreationCohortDeal => ({
  createdateMs: Date.UTC(2025, 0, 10),
  closedateMs: null,
  won: false,
  amount: "100",
  maxAmount: "100",
  ...over,
});

describe("creationSeasonality", () => {
  it("buckets creation value by month and in-year wins by CREATION month", () => {
    const s = creationSeasonality(
      [
        cohortDeal({ createdateMs: Date.UTC(2025, 0, 5), maxAmount: "1000" }),
        cohortDeal({ createdateMs: Date.UTC(2025, 0, 20), won: true, closedateMs: Date.UTC(2025, 4, 1), amount: "300", maxAmount: "400" }),
        // won but only AFTER year end — not an in-year win
        cohortDeal({ createdateMs: Date.UTC(2025, 11, 1), won: true, closedateMs: Date.UTC(2026, 1, 1), amount: "999", maxAmount: "999" }),
        // outside the cohort year entirely
        cohortDeal({ createdateMs: Date.UTC(2024, 5, 1), maxAmount: "5000" }),
      ],
      2025,
    );
    expect(s.creationValueByMonth[0]).toBe(1400);
    expect(s.winsByCreationMonth[0]).toBe(300); // won amount, not max
    expect(s.creationValueByMonth[11]).toBe(999);
    expect(s.winsByCreationMonth[11]).toBe(0);
  });
});

describe("expectedFutureCreationWins", () => {
  it("prorates the current month and sums the rest of the curve, scaled YoY", () => {
    const s: ReturnType<typeof creationSeasonality> = {
      winsByCreationMonth: [0, 0, 0, 0, 0, 0, 310, 100, 50, 0, 0, 40],
      creationValueByMonth: Array(12).fill(0),
    };
    // 2026-07-13 → July has 31 days, 18 remaining → 310×(18/31) = 180
    const v = expectedFutureCreationWins(s, Date.UTC(2026, 6, 13, 12), 1.1);
    expect(v).toBeCloseTo((180 + 100 + 50 + 40) * 1.1, 6);
  });

  it("December run counts only the month remainder", () => {
    const s = { winsByCreationMonth: Array(12).fill(0).map((_, i) => (i === 11 ? 62 : 0)), creationValueByMonth: Array(12).fill(0) };
    expect(expectedFutureCreationWins(s, Date.UTC(2026, 11, 30, 12), 1)).toBeCloseTo(62 * (1 / 31), 6);
  });
});

describe("creationValueInWindow", () => {
  it("sums max_amount-fallback creation value inside [start, end)", () => {
    const v = creationValueInWindow(
      [
        cohortDeal({ createdateMs: Date.UTC(2026, 0, 5), maxAmount: "10" }),
        cohortDeal({ createdateMs: Date.UTC(2026, 2, 5), maxAmount: "", amount: "7" }),
        cohortDeal({ createdateMs: Date.UTC(2025, 11, 31), maxAmount: "999" }),
      ],
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 6, 1),
    );
    expect(v).toBe(17);
  });
});

describe("aggregateExtendedRollups with creation shares", () => {
  it("adds the distributed creation share and includes it in the projection", () => {
    const w = dealRollupWindows(NOW);
    const out = aggregateExtendedRollups(
      { won: [wonDeal({ amount: "100" })], lost: [], open: [], creationByCompany: new Map([["c1", 50], ["c2", 25]]) },
      w,
      { pipelineYield: 0.25, visibilityRate: 0.2 },
    );
    expect(out.get("c1")![ROLLUP_PROP_CREATION]).toBe(50);
    expect(out.get("c1")![ROLLUP_PROP_PROJECTED]).toBe(750); // (100 + 0 + 50) / 0.2
    expect(out.get("c2")![ROLLUP_PROP_CREATION]).toBe(25);
    expect(out.get("c2")![ROLLUP_PROP_PROJECTED]).toBe(125); // (0 + 0 + 25) / 0.2
  });
});

describe("pipelineInYearYield", () => {
  const SNAP = Date.UTC(2025, 6, 14);
  const YEND = Date.UTC(2026, 0, 1);
  it("bases on fresh deals still open at the snapshot, wins on in-year closes", () => {
    const r = pipelineInYearYield(
      [
        // fresh, open at snapshot, won in-year → base + win
        cohortDeal({ createdateMs: Date.UTC(2025, 4, 1), closedateMs: Date.UTC(2025, 9, 1), won: true, amount: "200", maxAmount: "300" }),
        // fresh, open at snapshot, still open → base only
        cohortDeal({ createdateMs: Date.UTC(2025, 5, 1), closedateMs: null, maxAmount: "700" }),
        // closed BEFORE the snapshot → not in the base
        cohortDeal({ createdateMs: Date.UTC(2025, 3, 1), closedateMs: Date.UTC(2025, 5, 1), won: true, amount: "9999", maxAmount: "9999" }),
        // created too long ago (stale) → excluded
        cohortDeal({ createdateMs: SNAP - 200 * 86400000, closedateMs: null, maxAmount: "9999" }),
        // pre-qualified now → excluded
        cohortDeal({ createdateMs: Date.UTC(2025, 5, 15), closedateMs: null, preQualified: true, maxAmount: "9999" }),
        // won but only AFTER year end → base, not an in-year win
        cohortDeal({ createdateMs: Date.UTC(2025, 6, 1), closedateMs: Date.UTC(2026, 1, 1), won: true, amount: "500", maxAmount: "500" }),
      ],
      SNAP,
      YEND,
    );
    expect(r.base).toBe(300 + 700 + 500);
    expect(r.wins).toBe(200);
    expect(r.eventualWins).toBe(200 + 500); // in-year + spillover
    expect(r.yield).toBeCloseTo(200 / 1500, 10);
    expect(r.timing).toBeCloseTo(200 / 700, 10);
  });

  it("null yield on an empty base", () => {
    expect(pipelineInYearYield([], SNAP, YEND).yield).toBeNull();
  });
});
