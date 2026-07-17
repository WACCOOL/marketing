import { Hono } from "hono";
import type { AppBindings } from "../auth.js";
import { requireAuth, requireFeature } from "../auth.js";
import { serviceSupabase, userSupabase } from "../supabase.js";
import { anthropicConfigured, type ClaudeMessage } from "../anthropic.js";
import { dedupeCards, dedupeCitations, runThom } from "../thom/agent.js";

/**
 * Internal Thom chat. POST /api/thom/chat { message, conversationId? } → runs
 * the agent (retrieval tools over products + spec sheets/manuals) and returns
 * { conversationId, answer, cards, citations }. Non-streaming v1 (SSE + the
 * chat UI are a follow-up). Gated to internal/admin via requireFeature("thom").
 */

const MAX_HISTORY_TURNS = 12;

export const thomRoutes = new Hono<AppBindings>();

thomRoutes.post("/chat", requireAuth, requireFeature("thom"), async (c) => {
  const user = c.get("user");
  // Internal + admin only. Rep territory-scoping is a separate schema project.
  if (user.role !== "internal" && user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }
  if (!anthropicConfigured(c.env)) {
    return c.json({ error: "Thom is not configured (ANTHROPIC_API_KEY unset)" }, 503);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    message?: unknown;
    conversationId?: unknown;
  };
  const message = String(body.message ?? "").trim();
  if (!message) return c.json({ error: "message is required" }, 400);
  let conversationId = typeof body.conversationId === "string" ? body.conversationId : null;

  const sb = userSupabase(c.env, c.get("jwt")); // retrieval as the user (RLS)
  const admin = serviceSupabase(c.env); // conversation + message writes

  // Load history (most recent turns, oldest-first) or open a new conversation.
  const history: ClaudeMessage[] = [];
  if (conversationId) {
    const { data, error } = await admin
      .from("thom_messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(MAX_HISTORY_TURNS * 2);
    if (error) return c.json({ error: `history load failed: ${error.message}` }, 500);
    for (const m of (data ?? []).reverse()) {
      if ((m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content) {
        history.push({ role: m.role, content: m.content });
      }
    }
  } else {
    const { data, error } = await admin
      .from("thom_conversations")
      .insert({ scope: "internal", surface: "internal", user_id: user.id })
      .select("id")
      .single();
    if (error || !data) {
      return c.json({ error: `conversation create failed: ${error?.message ?? "unknown"}` }, 500);
    }
    conversationId = data.id as string;
  }

  let result;
  try {
    result = await runThom(c.env, sb, { history, userMessage: message });
  } catch (e) {
    return c.json({ error: `Thom failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
  const cards = dedupeCards(result.cards);
  const citations = dedupeCitations(result.citations);

  // Log the turn (best-effort — a logging failure shouldn't drop the answer).
  const { error: logErr } = await admin.from("thom_messages").insert([
    { conversation_id: conversationId, role: "user", content: message },
    {
      conversation_id: conversationId,
      role: "assistant",
      content: result.text,
      citations,
      product_cards: cards,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      model: result.usage.model,
    },
  ]);
  if (logErr) console.warn(`[thom] message log failed: ${logErr.message}`);

  return c.json({ conversationId, answer: result.text, cards, citations });
});
