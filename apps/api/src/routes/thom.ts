import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppBindings } from "../auth.js";
import { requireAuth, requireFeature } from "../auth.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceSupabase, userSupabase } from "../supabase.js";
import { anthropicConfigured, type ClaudeMessage } from "../anthropic.js";
import { dedupeCards, dedupeCitations, runThom, runThomStream } from "../thom/agent.js";
import type { Card, Citation, ThomUsage } from "../thom/types.js";

/**
 * Internal Thom chat.
 * - POST /api/thom/chat { message, conversationId? } → non-streaming: runs the
 *   agent and returns { conversationId, answer, cards, citations }.
 * - POST /api/thom/chat/stream { message, conversationId? } → SSE: streams the
 *   final answer token-by-token (events: meta | text | cards | citations |
 *   done | error), then logs the turn identically to /chat.
 * Both gated to internal/admin via requireFeature("thom").
 */

const MAX_HISTORY_TURNS = 12;

export const thomRoutes = new Hono<AppBindings>();

/** Outcome of the shared prelude: either an error Response to return as-is, or
 *  the loaded turn context (conversation opened/loaded, history, clients). */
type Prepared =
  | { ok: false; res: Response }
  | {
      ok: true;
      message: string;
      conversationId: string;
      history: ClaudeMessage[];
      sb: SupabaseClient;
      admin: SupabaseClient;
    };

/** Auth/role/config gates + body parse + conversation load/create, shared by
 *  the streaming and non-streaming endpoints. */
async function prepareTurn(c: Context<AppBindings>): Promise<Prepared> {
  const user = c.get("user");
  // Internal + admin only. Rep territory-scoping is a separate schema project.
  if (user.role !== "internal" && user.role !== "admin") {
    return { ok: false, res: c.json({ error: "forbidden" }, 403) };
  }
  if (!anthropicConfigured(c.env)) {
    return {
      ok: false,
      res: c.json({ error: "Thom is not configured (ANTHROPIC_API_KEY unset)" }, 503),
    };
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    message?: unknown;
    conversationId?: unknown;
  };
  const message = String(body.message ?? "").trim();
  if (!message) return { ok: false, res: c.json({ error: "message is required" }, 400) };
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
    if (error) return { ok: false, res: c.json({ error: `history load failed: ${error.message}` }, 500) };
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
      return {
        ok: false,
        res: c.json({ error: `conversation create failed: ${error?.message ?? "unknown"}` }, 500),
      };
    }
    conversationId = data.id as string;
  }

  return { ok: true, message, conversationId, history, sb, admin };
}

/** Log one turn to thom_messages (best-effort — a logging failure shouldn't
 *  drop the answer). Shared by both endpoints so the persisted rows match. */
async function logTurn(
  admin: SupabaseClient,
  conversationId: string,
  message: string,
  text: string,
  cards: Card[],
  citations: Citation[],
  usage: ThomUsage,
): Promise<void> {
  const { error } = await admin.from("thom_messages").insert([
    { conversation_id: conversationId, role: "user", content: message },
    {
      conversation_id: conversationId,
      role: "assistant",
      content: text,
      citations,
      product_cards: cards,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      model: usage.model,
    },
  ]);
  if (error) console.warn(`[thom] message log failed: ${error.message}`);
}

thomRoutes.post("/chat", requireAuth, requireFeature("thom"), async (c) => {
  const prep = await prepareTurn(c);
  if (!prep.ok) return prep.res;
  const { message, conversationId, history, sb, admin } = prep;

  let result;
  try {
    result = await runThom(c.env, sb, { history, userMessage: message });
  } catch (e) {
    return c.json({ error: `Thom failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
  const cards = dedupeCards(result.cards);
  const citations = dedupeCitations(result.citations);

  await logTurn(admin, conversationId, message, result.text, cards, citations, result.usage);

  return c.json({ conversationId, answer: result.text, cards, citations });
});

thomRoutes.post("/chat/stream", requireAuth, requireFeature("thom"), async (c) => {
  const prep = await prepareTurn(c);
  if (!prep.ok) return prep.res;
  const { message, conversationId, history, sb, admin } = prep;

  return streamSSE(c, async (stream) => {
    // First frame: hand the client the conversation id (needed to create/resume).
    await stream.writeSSE({ event: "meta", data: JSON.stringify({ conversationId }) });

    const cards: Card[] = [];
    const citations: Citation[] = [];
    try {
      for await (const ev of runThomStream(c.env, sb, { history, userMessage: message })) {
        if (ev.type === "text") {
          await stream.writeSSE({ event: "text", data: JSON.stringify({ text: ev.text }) });
        } else if (ev.type === "cards") {
          cards.push(...ev.cards);
          await stream.writeSSE({ event: "cards", data: JSON.stringify({ cards: ev.cards }) });
        } else if (ev.type === "citations") {
          citations.push(...ev.citations);
          await stream.writeSSE({
            event: "citations",
            data: JSON.stringify({ citations: ev.citations }),
          });
        } else if (ev.type === "final") {
          // Log identically to /chat, then emit the terminal done frame.
          await logTurn(admin, conversationId, message, ev.text, cards, citations, ev.usage);
          await stream.writeSSE({ event: "done", data: JSON.stringify({ usage: ev.usage }) });
        }
      }
    } catch (e) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      });
    }
  });
});
