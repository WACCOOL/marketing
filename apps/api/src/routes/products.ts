import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { userSupabase } from "../supabase.js";
import { makeProductAdapter } from "../saleslayer.js";

export const productRoutes = new Hono<AppBindings>();

// Columns returned to the client. raw_json is intentionally excluded — it can be
// large and is only needed server-side by later generation phases.
const PRODUCT_COLS =
  "id, sku, name, category, dimensions_mm, primary_image_url, image_urls, variants, synced_at";

const ListQuerySchema = z.object({
  q: z.string().trim().optional(),
  category: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

productRoutes.get("/", requireAuth, async (c) => {
  const parsed = ListQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
  }
  const { q, category, limit, offset } = parsed.data;

  const sb = userSupabase(c.env, c.get("jwt"));
  let query = sb
    .from("products")
    .select(PRODUCT_COLS, { count: "exact" })
    .order("name", { ascending: true })
    .range(offset, offset + limit - 1);

  if (category) query = query.eq("category", category);
  if (q) {
    // Partial match on product name/SKU and any variant model number/finish
    // (variant_search). Strip PostgREST `or` control characters so user input
    // can't break the filter expression.
    const safe = q.replace(/[(),]/g, " ").trim();
    if (safe) {
      query = query.or(
        `name.ilike.%${safe}%,sku.ilike.%${safe}%,variant_search.ilike.%${safe}%`,
      );
    }
  }

  const { data, error, count } = await query;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ products: data ?? [], total: count ?? 0 });
});

// Admin-only proxy of the live Sales Layer field schema (types for
// products/variants/categories). Useful for inspecting upstream field names.
// Declared before "/:sku" so it isn't swallowed by the param route.
productRoutes.get("/_schema", requireAuth, async (c) => {
  if (c.get("user").role !== "admin") {
    return c.json({ error: "admin only" }, 403);
  }
  const adapter = makeProductAdapter(c.env);
  const schema = await adapter.fetchSchema();
  return c.json({ schema });
});

// Admin-only manual cache refresh from Sales Layer. The catalog is large, so the
// sync runs in the background (via waitUntil) and we return 202 immediately —
// blocking the HTTP request would exceed Worker limits. Poll the products list /
// reload to see the refreshed data. (Phase 2b moves this onto a queue.)
productRoutes.post("/sync", requireAuth, async (c) => {
  if (c.get("user").role !== "admin") {
    return c.json({ error: "admin only" }, 403);
  }
  const adapter = makeProductAdapter(c.env);
  c.executionCtx.waitUntil(
    adapter
      .sync()
      .then((r) =>
        console.log(
          `[products] manual sync: upserted ${r.upserted}, variants ${r.variants}, pruned ${r.pruned}`,
        ),
      )
      .catch((e) => console.error("[products] manual sync failed", e)),
  );
  return c.json({ ok: true, started: true }, 202);
});

productRoutes.get("/:sku", requireAuth, async (c) => {
  const sku = c.req.param("sku");
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("products")
    .select(PRODUCT_COLS)
    .eq("sku", sku)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json({ product: data });
});
