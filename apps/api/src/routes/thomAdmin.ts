import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { wordFrequencies } from "@wac/shared/thom";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { serviceSupabase, userSupabase } from "../supabase.js";

/**
 * Thom admin — chat viewer + analytics (Davis 2026-07-21). ADMIN ONLY:
 * transcripts include other users' conversations and CRM tool output, and the
 * 0057 RLS mirrors this (own-or-admin), so even a direct PostgREST caller
 * can't read further than these routes allow.
 *
 * Reads use the admin's OWN JWT (userSupabase) wherever RLS suffices — the
 * service client appears only for the user-email join.
 */

export const thomAdminRoutes = new Hono<AppBindings>();

const requireAdmin = createMiddleware<AppBindings>(async (c, next) => {
  if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
  await next();
});

thomAdminRoutes.use("*", requireAuth, requireAdmin);

const ListQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  surface: z.enum(["all", "internal", "public"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Conversations list with turn counts + the owning user's email.
thomAdminRoutes.get("/conversations", async (c) => {
  const q = ListQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const sb = userSupabase(c.env, c.get("jwt"));
  const since = new Date(Date.now() - q.days * 864e5).toISOString();

  let query = sb
    .from("thom_conversations")
    .select("id, scope, user_id, surface, site_key, title, created_at, updated_at", { count: "exact" })
    .gte("created_at", since)
    .order("updated_at", { ascending: false })
    .range(q.offset, q.offset + q.limit - 1);
  if (q.surface !== "all") query = query.eq("scope", q.surface);
  const { data, error, count } = await query;
  if (error) return c.json({ error: error.message }, 500);
  const convs = data ?? [];

  // Owner emails (service client — users table is not admin-readable via RLS
  // beyond self) + user-question counts per conversation.
  const admin = serviceSupabase(c.env);
  const userIds = [...new Set(convs.map((r) => r.user_id).filter(Boolean))] as string[];
  const emails = new Map<string, string>();
  if (userIds.length) {
    const { data: users } = await admin.from("users").select("id, email").in("id", userIds);
    for (const u of users ?? []) emails.set(u.id as string, u.email as string);
  }
  const ids = convs.map((r) => r.id);
  const questions = new Map<string, number>();
  if (ids.length) {
    const { data: msgs } = await admin
      .from("thom_messages")
      .select("conversation_id")
      .eq("role", "user")
      .in("conversation_id", ids);
    for (const m of msgs ?? []) {
      const k = m.conversation_id as string;
      questions.set(k, (questions.get(k) ?? 0) + 1);
    }
  }

  return c.json({
    total: count ?? convs.length,
    items: convs.map((r) => ({
      ...r,
      user_email: r.user_id ? emails.get(r.user_id as string) ?? null : null,
      questions: questions.get(r.id as string) ?? 0,
    })),
  });
});

// Full thread. Tool RESULTS are omitted deliberately (bulky, and internal ones
// carry raw CRM payloads); tool_calls stay so the admin sees what Thom did.
thomAdminRoutes.get("/conversations/:id", async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const id = c.req.param("id");
  const { data: conv, error: convErr } = await sb
    .from("thom_conversations")
    .select("id, scope, user_id, surface, site_key, title, created_at")
    .eq("id", id)
    .maybeSingle();
  if (convErr) return c.json({ error: convErr.message }, 500);
  if (!conv) return c.json({ error: "not found" }, 404);
  const { data: msgs, error: msgErr } = await sb
    .from("thom_messages")
    .select("id, role, content, tool_calls, citations, product_cards, model, input_tokens, output_tokens, created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });
  if (msgErr) return c.json({ error: msgErr.message }, 500);
  return c.json({ conversation: conv, messages: msgs ?? [] });
});

const AnalyticsQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

thomAdminRoutes.get("/analytics", async (c) => {
  const q = AnalyticsQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const sb = userSupabase(c.env, c.get("jwt"));
  const [daily, topQueries, topProducts] = await Promise.all([
    sb.rpc("thom_chat_daily", { days: q.days }),
    sb.rpc("thom_top_queries", { days: q.days, max_rows: 200 }),
    sb.rpc("thom_top_products", { days: q.days, max_rows: 50 }),
  ]);
  const err = daily.error ?? topQueries.error ?? topProducts.error;
  if (err) return c.json({ error: err.message }, 500);

  const queries = (topQueries.data ?? []) as { query: string; hits: number; public_hits: number }[];
  return c.json({
    days: q.days,
    daily: daily.data ?? [],
    topQueries: queries.slice(0, 50),
    topWords: wordFrequencies(queries.map((r) => ({ query: r.query, hits: Number(r.hits) }))),
    topProducts: topProducts.data ?? [],
  });
});
