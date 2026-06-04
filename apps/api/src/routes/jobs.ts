import { Hono } from "hono";
import { AppImageParamsSchema, GenerationJobRequestSchema } from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { userSupabase } from "../supabase.js";
import {
  createGenerationJob,
  getGenerationJob,
  listGenerationJobs,
  type GenerationJobRow,
} from "../generation.js";

export const jobRoutes = new Hono<AppBindings>();

/** Shape a job row for the client (camelCase, no internal owner_id noise). */
function toJobResponse(row: GenerationJobRow) {
  return {
    jobId: row.id,
    tool: row.tool,
    status: row.status,
    assetId: row.asset_id,
    error: row.error,
    result: row.result_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

/** Enqueue a generation job. */
jobRoutes.post("/", requireAuth, async (c) => {
  const parsed = GenerationJobRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }

  // Per-tool param validation so bad inputs 400 here instead of failing as a
  // dead generation job. appimage carries the scale + compositing contract.
  let params: Record<string, unknown> = parsed.data.params;
  if (parsed.data.tool === "appimage") {
    const appimage = AppImageParamsSchema.safeParse(params);
    if (!appimage.success) {
      return c.json(
        { error: "invalid appimage params", issues: appimage.error.issues },
        400,
      );
    }
    params = appimage.data as Record<string, unknown>;
  }

  const user = c.get("user");
  const sb = userSupabase(c.env, c.get("jwt"));

  const res = await createGenerationJob(c.env, sb, {
    ownerId: user.id,
    tool: parsed.data.tool,
    name: parsed.data.name,
    params,
    tags: parsed.data.tags,
  });
  if (!res.ok) return c.json({ error: res.error }, 500);

  return c.json({ jobId: res.row.id, status: res.row.status }, 202);
});

/** Poll a single job's status. RLS scopes visibility to the caller. */
jobRoutes.get("/:id", requireAuth, async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const row = await getGenerationJob(sb, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(toJobResponse(row));
});

/** List the caller's recent jobs. */
jobRoutes.get("/", requireAuth, async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const rows = await listGenerationJobs(sb);
  return c.json({ jobs: rows.map(toJobResponse) });
});
