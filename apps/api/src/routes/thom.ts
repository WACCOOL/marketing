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

/** One turn as the client renders it (mirrors ThomChat's Turn shape). User
 *  turns carry only text; assistant turns carry any cards/citations. */
export interface StoredTurn {
  role: "user" | "assistant";
  text: string;
  cards?: Card[];
  citations?: Citation[];
}

/** A thom_messages row, as much of it as the mappers below care about. */
interface ThomMessageRow {
  role: string;
  content: string | null;
  product_cards?: Card[] | null;
  citations?: Citation[] | null;
}

/** Derive a conversation title from its first user message: collapse
 *  whitespace, trim, cap at 80 chars. Pure (no I/O) so it's trivially tested. */
export function deriveTitle(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Map thom_messages rows (created_at asc) to client Turn shapes. Skips tool
 *  rows; keeps row order. Pure so tests need no Supabase mocks. */
export function mapMessagesToTurns(rows: ThomMessageRow[]): StoredTurn[] {
  const turns: StoredTurn[] = [];
  for (const row of rows) {
    if (row.role === "tool") continue;
    if (row.role === "user") {
      turns.push({ role: "user", text: row.content ?? "" });
    } else if (row.role === "assistant") {
      turns.push({
        role: "assistant",
        text: row.content ?? "",
        cards: row.product_cards ?? [],
        citations: row.citations ?? [],
      });
    }
  }
  return turns;
}

/** Internal + admin only. Returns the user, or an error Response to return
 *  as-is. Rep territory-scoping is a separate schema project. */
type InternalGate =
  | { ok: true; user: AppBindings["Variables"]["user"] }
  | { ok: false; res: Response };
function requireInternal(c: Context<AppBindings>): InternalGate {
  const user = c.get("user");
  if (user.role !== "internal" && user.role !== "admin") {
    return { ok: false, res: c.json({ error: "forbidden" }, 403) };
  }
  return { ok: true, user };
}

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
  const gate = requireInternal(c);
  if (!gate.ok) return { ok: false, res: gate.res };
  const user = gate.user;
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
      .insert({
        scope: "internal",
        surface: "internal",
        user_id: user.id,
        title: deriveTitle(message) || null,
      })
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

// --- Chat history ------------------------------------------------------------
// Internal users can list, reload, and delete their own past conversations.
// All three are internal/admin-only (reps are 403'd) behind requireFeature.

/** List the user's most recent conversations (0-message ones excluded). */
thomRoutes.get("/conversations", requireAuth, requireFeature("thom"), async (c) => {
  const gate = requireInternal(c);
  if (!gate.ok) return gate.res;
  const user = gate.user;
  const admin = serviceSupabase(c.env);

  const { data: convs, error } = await admin
    .from("thom_conversations")
    .select("id, title, created_at")
    .eq("user_id", user.id)
    .eq("scope", "internal")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return c.json({ error: `conversations load failed: ${error.message}` }, 500);

  const rows = convs ?? [];
  const ids = rows.map((r) => r.id as string);

  // Batched message read → per-conversation count + first user message.
  const agg = new Map<string, { count: number; firstUser: string | null }>();
  if (ids.length) {
    const { data: msgs, error: msgErr } = await admin
      .from("thom_messages")
      .select("conversation_id, role, content, created_at")
      .in("conversation_id", ids)
      .order("created_at", { ascending: true });
    if (msgErr) return c.json({ error: `messages load failed: ${msgErr.message}` }, 500);
    for (const m of msgs ?? []) {
      const cid = m.conversation_id as string;
      let a = agg.get(cid);
      if (!a) {
        a = { count: 0, firstUser: null };
        agg.set(cid, a);
      }
      if (m.role === "user" || m.role === "assistant") a.count++;
      if (m.role === "user" && a.firstUser === null && typeof m.content === "string" && m.content) {
        a.firstUser = m.content;
      }
    }
  }

  const conversations = rows
    .map((conv) => {
      const a = agg.get(conv.id as string) ?? { count: 0, firstUser: null };
      const title =
        (conv.title as string | null) ??
        (a.firstUser ? deriveTitle(a.firstUser) : null) ??
        "New chat";
      return {
        id: conv.id as string,
        title,
        createdAt: conv.created_at as string,
        messageCount: a.count,
      };
    })
    .filter((conv) => conv.messageCount > 0);

  return c.json({ conversations });
});

/** Load one conversation's turns to reload-and-continue. Owner-scoped → 404. */
thomRoutes.get("/conversations/:id", requireAuth, requireFeature("thom"), async (c) => {
  const gate = requireInternal(c);
  if (!gate.ok) return gate.res;
  const user = gate.user;
  const id = c.req.param("id");
  const admin = serviceSupabase(c.env);

  const { data: owned, error: ownErr } = await admin
    .from("thom_conversations")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (ownErr) return c.json({ error: `conversation load failed: ${ownErr.message}` }, 500);
  if (!owned) return c.json({ error: "not found" }, 404);

  const { data: rows, error } = await admin
    .from("thom_messages")
    .select("role, content, product_cards, citations, created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });
  if (error) return c.json({ error: `messages load failed: ${error.message}` }, 500);

  return c.json({ conversationId: id, turns: mapMessagesToTurns((rows ?? []) as ThomMessageRow[]) });
});

/** Delete one of the user's conversations (messages cascade via FK). */
thomRoutes.delete("/conversations/:id", requireAuth, requireFeature("thom"), async (c) => {
  const gate = requireInternal(c);
  if (!gate.ok) return gate.res;
  const user = gate.user;
  const id = c.req.param("id");
  const admin = serviceSupabase(c.env);

  const { data, error } = await admin
    .from("thom_conversations")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id");
  if (error) return c.json({ error: `delete failed: ${error.message}` }, 500);
  if (!data || data.length === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
