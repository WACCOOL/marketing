import { Hono } from "hono";
import { requireAuthOrAdmin } from "../auth.js";
import type { AppBindings } from "../auth.js";
import { lastShowroomRun, runShowroomOrdersSync } from "../showroomOrders.js";

/**
 * Manual trigger + status for the Showroom PO Orders sync (showroomOrders.ts).
 *
 *   POST /api/hubspot/showroom-orders/sync      run now; body { dryRun?, agencyKeys?, force? }
 *   GET  /api/hubspot/showroom-orders/last-run  last non-dry-run summary (KV)
 *
 * Admin-only (real admin session or the ADMIN_API_TOKEN service token) — this
 * writes deals, so it must not be reachable by rep/internal users. The cron
 * covers steady state; this route exists for the backfill and for debugging.
 */
export const showroomOrderRoutes = new Hono<AppBindings>();

showroomOrderRoutes.use("/showroom-orders/*", requireAuthOrAdmin);
showroomOrderRoutes.use("/showroom-orders/*", async (c, next) => {
  if (c.get("user")?.role !== "admin") return c.json({ error: "admin only" }, 403);
  await next();
});

showroomOrderRoutes.post("/showroom-orders/sync", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    dryRun?: boolean;
    agencyKeys?: string[];
    force?: boolean;
  };
  try {
    // A full 20-sheet backfill is many sequential HubSpot calls — allow 5 min.
    const summary = await runShowroomOrdersSync(
      c.env,
      {
        dryRun: body.dryRun === true,
        force: body.force === true,
        agencyKeys: Array.isArray(body.agencyKeys) ? body.agencyKeys.map(String) : undefined,
      },
      AbortSignal.timeout(300_000),
    );
    return c.json(summary, summary.ok ? 200 : 207);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

showroomOrderRoutes.get("/showroom-orders/last-run", async (c) => {
  const summary = await lastShowroomRun(c.env);
  if (!summary) return c.json({ error: "no runs recorded yet" }, 404);
  return c.json(summary);
});
