import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AppBindings } from "../auth.js";
import { requireAuth, requireFeature } from "../auth.js";
import { serviceSupabase } from "../supabase.js";

/**
 * Thom dictionary admin — CRUD behind the "Dictionary" page (Thom Bot group).
 *
 * Terms listed here are protected from the public copy normalizer's bare-WAC
 * upgrade ("My WAC" must never become "My WAC Group"). The public agent reads
 * the table anonymously with a 5-minute cache; edits here are live within that
 * window, no deploy needed. Code-level DEFAULT_PROTECTED_TERMS (the core brand
 * names) always apply and cannot be removed here.
 *
 * Same gate as Thom Knowledge (feature thom-content + internal/admin); writes
 * use the service client (table is service-role-write by RLS).
 */

export const thomDictionaryRoutes = new Hono<AppBindings>();

const requireInternal = createMiddleware<AppBindings>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "internal" && user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
});

thomDictionaryRoutes.use("*", requireAuth, requireFeature("thom-content"), requireInternal);

thomDictionaryRoutes.get("/", async (c) => {
  const sb = serviceSupabase(c.env);
  const { data, error } = await sb
    .from("thom_dictionary")
    .select("id, term, note, updated_at")
    .order("term", { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ items: data ?? [] });
});

const TermInput = z.object({
  term: z
    .string()
    .trim()
    .min(2, "term is too short")
    .max(80, "term is too long")
    .refine((t) => /wac/i.test(t), 'a protected term must contain "WAC"'),
  note: z.string().trim().max(300).optional().nullable(),
});

thomDictionaryRoutes.post("/", async (c) => {
  const parsed = TermInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
  }
  const sb = serviceSupabase(c.env);
  const { data, error } = await sb
    .from("thom_dictionary")
    .upsert(
      { term: parsed.data.term, note: parsed.data.note ?? null },
      { onConflict: "term" },
    )
    .select("id, term, note, updated_at")
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ item: data });
});

thomDictionaryRoutes.delete("/:id", async (c) => {
  const sb = serviceSupabase(c.env);
  const { error } = await sb.from("thom_dictionary").delete().eq("id", c.req.param("id"));
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});
