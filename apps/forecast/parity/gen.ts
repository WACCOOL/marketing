/**
 * Parity-fixture generator: runs the REAL @wac/shared dealRollups math over
 * deterministic synthetic inputs and dumps inputs+outputs as JSON for the
 * Python port's pytest (tests/test_quote_visibility_parity.py).
 *
 * Regenerate after any change to packages/shared/src/hubspot/dealRollups.ts:
 *   pnpm --filter @wac/forecast-parity gen   (or: node esbuild bundle, see README)
 *
 * Synthetic data only — safe to commit.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adjustedValueHitRate,
  aggregateExtendedRollups,
  creationSeasonality,
  creationValueInWindow,
  dealRollupWindows,
  expectedFutureCreationWins,
  pickRollupCompanyId,
  pipelineInYearYield,
} from "../../../packages/shared/src/hubspot/dealRollups.js";

// Deterministic LCG so the fixture is reproducible.
let seed = 42;
const rand = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;

const NOW = Date.UTC(2026, 6, 13, 15, 30); // 2026-07-13T15:30Z
const windows = dealRollupWindows(NOW);

const DAY = 86_400_000;
const companies = ["c1", "c2", "c3", "c4", "c5"];
const maybe = <T>(v: T): T | null => (rand() < 0.15 ? null : v);

const mkDeal = (i: number) => {
  const created = Date.UTC(2024, 0, 1) + Math.floor(rand() * 920) * DAY + Math.floor(rand() * 24) * 3_600_000;
  const closed = rand() < 0.6 ? created + Math.floor(rand() * 400) * DAY : null;
  return {
    companyId: companies[i % companies.length]!,
    createdateMs: maybe(created),
    closedateMs: closed,
    won: rand() < 0.5,
    preQualified: rand() < 0.1,
    amount: rand() < 0.1 ? "" : Math.round(rand() * 500_000 * 100) / 100,
    maxAmount: rand() < 0.3 ? null : Math.round(rand() * 600_000 * 100) / 100,
  };
};

const cohort = Array.from({ length: 400 }, (_, i) => mkDeal(i));
const won = cohort.filter((d) => d.won && d.closedateMs !== null);
const lost = cohort.filter((d) => !d.won && d.closedateMs !== null);
const open = cohort.filter((d) => d.closedateMs === null);

const snapshotMs = windows.priorYtdEndMs - DAY;
const yieldRes = pipelineInYearYield(cohort, snapshotMs, windows.priorYearEndMs);
const seasonality = creationSeasonality(cohort, 2025);
const hitRate = adjustedValueHitRate(won, lost, NOW - 365 * DAY, NOW);
const futureWins = expectedFutureCreationWins(seasonality, NOW, 1.234);
const creationWindowValue = creationValueInWindow(cohort, windows.ytdStartMs, NOW);

const creationByCompany = new Map<string, number>([
  ["c1", 120_000.55],
  ["c2", 0],
  ["c3", 98_765.43],
]);
const aggregated = aggregateExtendedRollups(
  { won, lost, open, creationByCompany },
  windows,
  { pipelineYield: yieldRes.yield, visibilityRate: 0.1234 },
);

const assocCases = [
  { assocs: [{ companyId: "a", typeIds: [5] }, { companyId: "b", typeIds: [3] }], expected: "a" },
  { assocs: [{ companyId: "b", typeIds: [3] }], expected: "b" },
  { assocs: [{ companyId: "a", typeIds: [3] }, { companyId: "b", typeIds: [4] }], expected: null },
  { assocs: [{ companyId: "a", typeIds: [5] }, { companyId: "b", typeIds: [5] }], expected: null },
  { assocs: [], expected: null },
];

// Feb-29 leap handling: windows computed on 2024-02-29 (leap) roll the
// prior-year cutoff to Mar 1 2023.
const leapWindows = dealRollupWindows(Date.UTC(2024, 1, 29, 12));

const fixture = {
  nowMs: NOW,
  windows,
  leapWindows,
  cohort,
  snapshotMs,
  yieldRes,
  seasonality,
  hitRate,
  yoyFactor: 1.234,
  futureWins,
  creationWindowValue,
  creationByCompany: Object.fromEntries(creationByCompany),
  visibilityRate: 0.1234,
  aggregated: Object.fromEntries(aggregated),
  assocCases,
};

const out =
  process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "rollup_parity.json");
writeFileSync(out, JSON.stringify(fixture, null, 1));
console.log(`wrote ${out}`);
