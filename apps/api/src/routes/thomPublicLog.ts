import { Hono } from "hono";
import { z } from "zod";
import {
  FEEDBACK_PUBLIC_ANSWER_MAX,
  FEEDBACK_QUESTION_MAX,
  FEEDBACK_REASON_MAX,
  FEEDBACK_TURN_ID_MAX,
  matchFeedbackTurn,
  publicFeedbackDedupKey,
  type FeedbackMatchRow,
} from "@wac/shared/thom";
import type { AppBindings } from "../auth.js";
import { serviceSupabase } from "../supabase.js";

/**
 * Public-turn logging bridge. The PUBLIC Thom worker deliberately holds no
 * Supabase service key (layer-1 of the scope guarantee), so it cannot write
 * thom_conversations itself. Instead it fires completed turns here,
 * authenticated by the THOM_LOG_TOKEN shared secret; this Worker (which owns
 * the service role) persists them. Powers the admin chat viewer + analytics.
 *
 * The session key is a SHA-256 hash of the visitor's short-lived session
 * token, computed by the public worker — the raw token never leaves it.
 * Turns within 24h of the conversation's last activity group together.
 */

export const thomPublicLogRoutes = new Hono<AppBindings>();

const TurnInput = z.object({
  session_key: z.string().min(16).max(128),
  site_key: z.string().max(200).nullable().optional(),
  question: z.string().min(1).max(8_000),
  answer: z.string().max(64_000),
  tool_calls: z.array(z.object({ name: z.string(), input: z.unknown() })).max(40).optional(),
  citations: z.unknown().optional(),
  product_cards: z.unknown().optional(),
  model: z.string().max(100).optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
});

thomPublicLogRoutes.post("/", async (c) => {
  const secret = c.env.THOM_LOG_TOKEN;
  if (!secret) return c.json({ error: "logging not configured" }, 503);
  if (c.req.header("x-thom-log-token") !== secret) {
    return c.json({ error: "forbidden" }, 403);
  }
  const parsed = TurnInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload" }, 400);
  const t = parsed.data;
  const sb = serviceSupabase(c.env);

  // Reuse the session's conversation when it was active in the last 24h.
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: existing } = await sb
    .from("thom_conversations")
    .select("id")
    .eq("public_session_key", t.session_key)
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let conversationId = existing?.id as string | undefined;
  if (!conversationId) {
    const { data: created, error } = await sb
      .from("thom_conversations")
      .insert({
        scope: "public",
        surface: "widget",
        site_key: t.site_key ?? null,
        public_session_key: t.session_key,
        title: t.question.slice(0, 80),
      })
      .select("id")
      .single();
    if (error) return c.json({ error: error.message }, 500);
    conversationId = created.id as string;
  } else {
    // Touch so the 24h window slides with activity.
    await sb.from("thom_conversations").update({ site_key: t.site_key ?? null }).eq("id", conversationId);
  }

  const { error: msgErr } = await sb.from("thom_messages").insert([
    { conversation_id: conversationId, role: "user", content: t.question },
    {
      conversation_id: conversationId,
      role: "assistant",
      content: t.answer,
      tool_calls: t.tool_calls ?? null,
      citations: t.citations ?? null,
      product_cards: t.product_cards ?? null,
      model: t.model ?? null,
      input_tokens: t.input_tokens ?? null,
      output_tokens: t.output_tokens ?? null,
    },
  ]);
  if (msgErr) return c.json({ error: msgErr.message }, 500);
  return c.json({ ok: true });
});

// -----------------------------------------------------------------------------
// Public feedback (migration 0062). The public worker's /api/feedback forwards
// here; this route owns the service-role write. Zod bounds are EXPLICIT and
// re-enforce everything the worker pre-capped (F12 — the shared secret must
// not rely on worker hygiene).
// -----------------------------------------------------------------------------

export const FeedbackInput = z.object({
  session_key: z.string().min(16).max(128),
  site_key: z.string().max(200).nullable().optional(),
  client_turn_id: z.string().min(1).max(FEEDBACK_TURN_ID_MAX),
  rating: z.union([z.literal(1), z.literal(-1)]),
  reason: z.string().max(FEEDBACK_REASON_MAX).optional(),
  question: z.string().min(1).max(FEEDBACK_QUESTION_MAX),
  answer: z.string().min(1).max(FEEDBACK_PUBLIC_ANSWER_MAX),
  model: z.string().max(100).optional(),
});

thomPublicLogRoutes.post("/feedback", async (c) => {
  const secret = c.env.THOM_LOG_TOKEN;
  if (!secret) return c.json({ error: "logging not configured" }, 503);
  if (c.req.header("x-thom-log-token") !== secret) {
    return c.json({ error: "forbidden" }, 403);
  }
  const parsed = FeedbackInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload" }, 400);
  const f = parsed.data;
  const sb = serviceSupabase(c.env);

  // Best-effort linkage: the session's conversation, exactly as the turn
  // route finds it (public_session_key + 24h window).
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: existing } = await sb
    .from("thom_conversations")
    .select("id")
    .eq("public_session_key", f.session_key)
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const conversationId = (existing?.id as string | undefined) ?? null;

  // Snapshot source depends on the match (F3): on a hit, question/answer are
  // copied FROM THE MATCHED DB ROWS — the client-sent text served only as the
  // probe. On a miss (feedback can land before the waitUntil turn log does),
  // store the client text with message_id null — that null IS the unverified
  // flag (0062).
  let match = null;
  if (conversationId) {
    const { data: msgs } = await sb
      .from("thom_messages")
      .select("id, role, content, created_at, model")
      .eq("conversation_id", conversationId)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: false })
      .limit(60);
    match = matchFeedbackTurn((msgs ?? []) as FeedbackMatchRow[], f.answer);
  }

  const { error } = await sb.from("thom_feedback").upsert(
    {
      dedup_key: publicFeedbackDedupKey(f.session_key, f.client_turn_id),
      surface: "public",
      conversation_id: conversationId,
      message_id: match?.messageId ?? null,
      public_session_key: f.session_key,
      client_turn_id: f.client_turn_id,
      site_key: f.site_key ?? null,
      rating: f.rating,
      // Thumbs-down only; a flip to thumbs-up nulls it (F14).
      reason: f.rating === -1 ? (f.reason?.trim() || null) : null,
      question_text: (match ? match.questionText ?? f.question : f.question).slice(0, FEEDBACK_QUESTION_MAX),
      answer_text: match ? match.answerText : f.answer,
      model: match?.model ?? f.model ?? null,
    },
    { onConflict: "dedup_key" },
  );
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true, matched: Boolean(match) });
});
