import { Hono } from "hono";
import { z } from "zod";
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
