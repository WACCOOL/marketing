import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { userSupabase } from "../supabase.js";
import {
  createShortLink,
  shortLinkUrl,
  updateShortLinkDestination,
} from "../shortlinks.js";

export const shortLinkRoutes = new Hono<AppBindings>();

const CreateSchema = z.object({
  destinationUrl: z.string().url(),
  vanitySlug: z.string().optional(),
});

shortLinkRoutes.post("/", requireAuth, async (c) => {
  const parsed = CreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const result = await createShortLink(c.env, sb, {
    destinationUrl: parsed.data.destinationUrl,
    ownerId: c.get("user").id,
    vanitySlug: parsed.data.vanitySlug,
  });
  if (!result.ok) {
    if ("conflict" in result) {
      return c.json({ error: "vanity slug already taken" }, 409);
    }
    return c.json({ error: result.error }, 500);
  }
  return c.json({
    ...result.row,
    shortUrl: shortLinkUrl(c.env, result.row.slug),
  });
});

const UpdateSchema = z.object({
  destinationUrl: z.string().url(),
});

shortLinkRoutes.patch("/:slug", requireAuth, async (c) => {
  const slug = c.req.param("slug");
  const parsed = UpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const result = await updateShortLinkDestination(c.env, sb, {
    slug,
    destinationUrl: parsed.data.destinationUrl,
  });
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

shortLinkRoutes.get("/", requireAuth, async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("short_links")
    .select("id, slug, destination_url, owner_id, scan_count, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({
    shortLinks: (data ?? []).map((r) => ({
      ...r,
      shortUrl: shortLinkUrl(c.env, (r as { slug: string }).slug),
    })),
  });
});
