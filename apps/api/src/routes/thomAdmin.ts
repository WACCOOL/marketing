import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { bucketSourceUsage, wordFrequencies, type SourceUsageRow } from "@wac/shared/thom";
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

  // Feedback chips for the thread view. BEST-EFFORT (F11): if migration 0062
  // has not been applied yet, the thread view must keep working — swallow any
  // error and return no feedback.
  let feedback: { message_id: string | null; rating: number; reason: string | null }[] = [];
  try {
    const { data: fb, error: fbErr } = await sb
      .from("thom_feedback")
      .select("message_id, rating, reason")
      .eq("conversation_id", id);
    if (!fbErr) feedback = (fb ?? []) as typeof feedback;
  } catch {
    // best-effort only
  }
  return c.json({ conversation: conv, messages: msgs ?? [], feedback });
});

// -----------------------------------------------------------------------------
// Feedback list (thumbs + reasons — migration 0062). Reads under the admin's
// own JWT (RLS: admin-only select). PLAIN-TEXT rule (F15): question/answer
// snapshots and reasons are visitor/probe text — the UI renders them as plain
// text only, never through a markdown renderer.
// -----------------------------------------------------------------------------

const FeedbackListQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  surface: z.enum(["all", "internal", "public"]).default("all"),
  rating: z.enum(["all", "up", "down"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

thomAdminRoutes.get("/feedback", async (c) => {
  const q = FeedbackListQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const sb = userSupabase(c.env, c.get("jwt"));
  const since = new Date(Date.now() - q.days * 864e5).toISOString();

  let query = sb
    .from("thom_feedback")
    .select(
      "id, surface, rating, reason, question_text, answer_text, site_key, conversation_id, message_id, user_id, created_at",
      { count: "exact" },
    )
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .range(q.offset, q.offset + q.limit - 1);
  if (q.surface !== "all") query = query.eq("surface", q.surface);
  if (q.rating !== "all") query = query.eq("rating", q.rating === "up" ? 1 : -1);
  const { data, error, count } = await query;
  if (error) return c.json({ error: error.message }, 500);
  const rows = data ?? [];

  const admin = serviceSupabase(c.env);

  // Rater emails (internal rows).
  const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))] as string[];
  const emails = new Map<string, string>();
  if (userIds.length) {
    const { data: users } = await admin.from("users").select("id, email").in("id", userIds);
    for (const u of users ?? []) emails.set(u.id as string, u.email as string);
  }

  // Source context for MATCHED rows (F13): tool_calls + citation doc_types
  // from thom_messages, one batched in() query, best-effort like F11.
  const messageIds = [...new Set(rows.map((r) => r.message_id).filter(Boolean))] as string[];
  const context = new Map<string, { tool_calls: { name: string }[]; doc_types: string[] }>();
  if (messageIds.length) {
    try {
      const { data: msgs } = await admin
        .from("thom_messages")
        .select("id, tool_calls, citations")
        .in("id", messageIds);
      for (const m of msgs ?? []) {
        const toolCalls = (Array.isArray(m.tool_calls) ? m.tool_calls : []) as { name: string }[];
        const cits = (Array.isArray(m.citations) ? m.citations : []) as { doc_type?: string }[];
        const docTypes = [...new Set(cits.map((ci) => ci.doc_type).filter(Boolean))] as string[];
        context.set(m.id as string, { tool_calls: toolCalls, doc_types: docTypes });
      }
    } catch {
      // best-effort only
    }
  }

  return c.json({
    total: count ?? rows.length,
    items: rows.map((r) => ({
      ...r,
      user_email: r.user_id ? emails.get(r.user_id as string) ?? null : null,
      tool_calls: r.message_id ? context.get(r.message_id as string)?.tool_calls ?? [] : [],
      doc_types: r.message_id ? context.get(r.message_id as string)?.doc_types ?? [] : [],
    })),
  });
});

const AnalyticsQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  surface: z.enum(["all", "internal", "public"]).default("all"),
});

thomAdminRoutes.get("/analytics", async (c) => {
  const q = AnalyticsQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const sb = userSupabase(c.env, c.get("jwt"));
  const scope = q.surface === "all" ? null : q.surface;
  const [daily, topQueries, topProducts, sources, feedbackDaily] = await Promise.all([
    sb.rpc("thom_chat_daily", { days: q.days }),
    sb.rpc("thom_top_queries", { days: q.days, max_rows: 200, scope_filter: scope }),
    sb.rpc("thom_top_products", { days: q.days, max_rows: 50, scope_filter: scope }),
    sb.rpc("thom_source_usage", { days: q.days, scope_filter: scope }),
    sb.rpc("thom_feedback_daily", { days: q.days, scope_filter: scope }),
  ]);
  const err = daily.error ?? topQueries.error ?? topProducts.error ?? sources.error;
  if (err) return c.json({ error: err.message }, 500);

  // Feedback is BEST-EFFORT (F11 posture): if migration 0062 lags the deploy,
  // the analytics page must still load — render zeros, don't 500.
  const fbRows = (feedbackDaily.error ? [] : feedbackDaily.data ?? []) as {
    day: string;
    up: number;
    down: number;
    unverified: number;
  }[];
  const feedbackTotals = fbRows.reduce(
    (a, r) => ({
      up: a.up + Number(r.up ?? 0),
      down: a.down + Number(r.down ?? 0),
      unverified: a.unverified + Number(r.unverified ?? 0),
    }),
    { up: 0, down: 0, unverified: 0 },
  );

  const queries = (topQueries.data ?? []) as { query: string; hits: number; public_hits: number }[];
  return c.json({
    days: q.days,
    surface: q.surface,
    daily: daily.data ?? [],
    topQueries: queries.slice(0, 50),
    topWords: wordFrequencies(queries.map((r) => ({ query: r.query, hits: Number(r.hits) }))),
    topProducts: topProducts.data ?? [],
    sources: bucketSourceUsage((sources.data ?? []) as SourceUsageRow[]),
    feedbackDaily: fbRows,
    feedbackTotals,
  });
});
