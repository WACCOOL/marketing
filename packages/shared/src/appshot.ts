import type { AppShotFixture, AppShotPlacement } from "./types.js";

/**
 * Normalize a shot payload to its fixture list. Multi-fixture payloads carry
 * `fixtures` (rendered back-to-front in list order); legacy single-fixture
 * payloads — old jobs, old clients, Cam Solve — carry `sku` + `placement` and
 * are wrapped into a one-element array. This is the single back-compat point:
 * every reader of `params.shot` (generator, restore links) goes through it.
 */
export function normalizeShotFixtures(shot: {
  sku?: string | null;
  placement?: AppShotPlacement | null;
  fixtures?: AppShotFixture[] | null;
}): AppShotFixture[] {
  if (shot.fixtures?.length) return shot.fixtures;
  if (shot.sku && shot.placement) {
    return [{ sku: shot.sku, placement: shot.placement }];
  }
  throw new Error("shot has no fixtures (need fixtures[] or sku + placement)");
}
