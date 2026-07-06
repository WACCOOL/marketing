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

  it("keeps fresh values and zero-fills companies that dropped out", () => {
    const writes = buildRollupWrites(new Map([["c1", freshProps]]), ["c1", "c2"]);
    expect(writes.get("c1")).toEqual(freshProps);
    expect(writes.get("c2")).toEqual({
      [ROLLUP_PROP_YTD]: 0,
      [ROLLUP_PROP_PRIOR_YTD]: 0,
      [ROLLUP_PROP_PRIOR_YEAR]: 0,
    });
  });

  it("first run (nothing existing) writes only the fresh set", () => {
    const writes = buildRollupWrites(new Map([["c1", freshProps]]), []);
    expect([...writes.keys()]).toEqual(["c1"]);
  });
});
