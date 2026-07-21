import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  FEEDBACK_QUESTION_MAX,
  FEEDBACK_ANSWER_MAX,
  FEEDBACK_REASON_MAX,
  internalFeedbackDedupKey,
  pickQuestionText,
  type FeedbackRating,
} from "@wac/shared/thom";
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
 *  turns carry only text; assistant turns carry any cards/citations, plus
 *  their thom_messages id (so they are ratable) and any existing vote. */
export interface StoredTurn {
  role: "user" | "assistant";
  text: string;
  cards?: Card[];
  citations?: Citation[];
  messageId?: string;
  feedback?: FeedbackRating;
}

/** A thom_messages row, as much of it as the mappers below care about. */
interface ThomMessageRow {
  id?: string;
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
 *  rows; keeps row order. Assistant rows carry their id as messageId (so
 *  reloaded history stays ratable) and any existing vote from `feedback`.
 *  Pure so tests need no Supabase mocks. */
export function mapMessagesToTurns(
  rows: ThomMessageRow[],
  feedback?: Map<string, FeedbackRating>,
): StoredTurn[] {
  const turns: StoredTurn[] = [];
  for (const row of rows) {
    if (row.role === "tool") continue;
    if (row.role === "user") {
      turns.push({ role: "user", text: row.content ?? "" });
    } else if (row.role === "assistant") {
      const turn: StoredTurn = {
        role: "assistant",
        text: row.content ?? "",
        cards: row.product_cards ?? [],
        citations: row.citations ?? [],
      };
      if (row.id) {
        turn.messageId = row.id;
        const vote = feedback?.get(row.id);
        if (vote) turn.feedback = vote;
      }
      turns.push(turn);
    }
  }
  return turns;
}

/**
 * Load one conversation's turns with the feedback join, testably: the owner
 * check ALWAYS runs first (F6 — a failed check must issue no feedback query),
 * and the feedback read is BEST-EFFORT (F11 — any error, e.g. migration 0062
 * not yet applied, is swallowed and an empty map used; a conversation reload
 * must never 500 because the migration lags the deploy).
 */
export async function loadConversationTurns(deps: {
  getOwned: () => Promise<boolean>;
  getMessages: () => Promise<ThomMessageRow[]>;
  getFeedback: () => Promise<Map<string, FeedbackRating>>;
}): Promise<{ notFound: true } | { notFound?: false; turns: StoredTurn[] }> {
  if (!(await deps.getOwned())) return { notFound: true };
  const rows = await deps.getMessages();
  let feedback = new Map<string, FeedbackRating>();
  try {
    feedback = await deps.getFeedback();
  } catch {
    // best-effort only (F11)
  }
  return { turns: mapMessagesToTurns(rows, feedback) };
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
 *  the streaming and non-streaming endpoints. Exported for the ownership-gate
 *  tests (F5). */
export async function prepareTurn(c: Context<AppBindings>): Promise<Prepared> {
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
    // Ownership gate: the id is client-supplied and history is loaded with the
    // service client (bypasses RLS), so verify the conversation belongs to the
    // requester first - same 404 posture as GET /conversations/:id.
    const { data: owned, error: ownErr } = await admin
      .from("thom_conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (ownErr) return { ok: false, res: c.json({ error: `conversation load failed: ${ownErr.message}` }, 500) };
    if (!owned) return { ok: false, res: c.json({ error: "not found" }, 404) };
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
 *  drop the answer). Shared by both endpoints so the persisted rows match.
 *  Returns the inserted assistant row's id so the client can key a rating
 *  (feedback plan B.1) — null when logging failed. */
async function logTurn(
  admin: SupabaseClient,
  conversationId: string,
  message: string,
  text: string,
  cards: Card[],
  citations: Citation[],
  usage: ThomUsage,
  toolCalls: { name: string; input: unknown }[] = [],
): Promise<{ assistantMessageId: string | null }> {
  const { data, error } = await admin
    .from("thom_messages")
    .insert([
      { conversation_id: conversationId, role: "user", content: message },
      {
        conversation_id: conversationId,
        role: "assistant",
        content: text,
        tool_calls: toolCalls.length ? toolCalls : null,
        citations,
        product_cards: cards,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        model: usage.model,
      },
    ])
    .select("id, role");
  if (error) {
    console.warn(`[thom] message log failed: ${error.message}`);
    return { assistantMessageId: null };
  }
  const assistant = (data ?? []).find((r) => r.role === "assistant");
  return { assistantMessageId: (assistant?.id as string | undefined) ?? null };
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

  const { assistantMessageId } = await logTurn(
    admin, conversationId, message, result.text, cards, citations, result.usage, result.toolCalls ?? [],
  );

  return c.json({
    conversationId,
    answer: result.text,
    cards,
    citations,
    messageId: assistantMessageId ?? undefined,
  });
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
          // Log identically to /chat, then emit the terminal done frame with
          // the assistant message id so the client can key a rating.
          const { assistantMessageId } = await logTurn(
            admin, conversationId, message, ev.text, cards, citations, ev.usage, ev.toolCalls,
          );
          await stream.writeSSE({
            event: "done",
            data: JSON.stringify({ usage: ev.usage, messageId: assistantMessageId ?? undefined }),
          });
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

/** Load one conversation's turns to reload-and-continue. Owner-scoped → 404.
 *  Access-path rule (F6, pinned): the feedback read below uses the SERVICE
 *  client strictly AFTER the owner check has passed — no end-user RLS select
 *  policy exists on thom_feedback (admin-only select stands, 0062). */
thomRoutes.get("/conversations/:id", requireAuth, requireFeature("thom"), async (c) => {
  const gate = requireInternal(c);
  if (!gate.ok) return gate.res;
  const user = gate.user;
  const id = c.req.param("id");
  const admin = serviceSupabase(c.env);

  let loadError: string | null = null;
  const result = await loadConversationTurns({
    getOwned: async () => {
      const { data: owned, error: ownErr } = await admin
        .from("thom_conversations")
        .select("id")
        .eq("id", id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (ownErr) {
        loadError = `conversation load failed: ${ownErr.message}`;
        return false;
      }
      return Boolean(owned);
    },
    getMessages: async () => {
      const { data: rows, error } = await admin
        .from("thom_messages")
        .select("id, role, content, product_cards, citations, created_at")
        .eq("conversation_id", id)
        .order("created_at", { ascending: true });
      if (error) {
        loadError = `messages load failed: ${error.message}`;
        return [];
      }
      return (rows ?? []) as ThomMessageRow[];
    },
    getFeedback: async () => {
      // Best-effort (F11): loadConversationTurns swallows any throw here.
      const { data, error } = await admin
        .from("thom_feedback")
        .select("message_id, rating")
        .eq("conversation_id", id);
      if (error) throw new Error(error.message);
      const map = new Map<string, FeedbackRating>();
      for (const row of data ?? []) {
        if (typeof row.message_id === "string" && (row.rating === 1 || row.rating === -1)) {
          map.set(row.message_id, row.rating);
        }
      }
      return map;
    },
  });
  if (loadError) return c.json({ error: loadError }, 500);
  if (result.notFound) return c.json({ error: "not found" }, 404);

  return c.json({ conversationId: id, turns: result.turns });
});

// --- Feedback (thumbs up / thumbs down) --------------------------------------

const FeedbackBody = z.object({
  messageId: z.string().uuid(),
  rating: z.union([z.literal(1), z.literal(-1)]),
  reason: z.string().max(FEEDBACK_REASON_MAX).optional(),
});

/** Narrow data-access surface for applyInternalFeedback, so the route logic
 *  (owner-scoping, snapshots, upsert semantics) unit-tests without Supabase. */
export interface InternalFeedbackDb {
  getMessage(id: string): Promise<{
    id: string;
    conversation_id: string;
    role: string;
    content: string | null;
    created_at: string;
    model: string | null;
  } | null>;
  getConversationOwner(conversationId: string): Promise<{ user_id: string | null } | null>;
  /** All 'user'-role rows of the conversation (content + created_at). */
  getUserRows(conversationId: string): Promise<{ content: string | null; created_at: string }[]>;
  upsertFeedback(row: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
}

/**
 * Core of POST /api/thom/feedback: owner-scope, validate, snapshot
 * server-side (never trusting client text), upsert on dedup_key.
 */
export async function applyInternalFeedback(
  db: InternalFeedbackDb,
  callerId: string,
  input: { messageId: string; rating: FeedbackRating; reason?: string },
): Promise<{ status: 200 | 400 | 404 | 500; body: Record<string, unknown> }> {
  const message = await db.getMessage(input.messageId);
  if (!message) return { status: 404, body: { error: "not found" } };

  // Owner-scoping: same 404 posture as GET /conversations/:id.
  const conv = await db.getConversationOwner(message.conversation_id);
  if (!conv || conv.user_id !== callerId) return { status: 404, body: { error: "not found" } };

  if (message.role !== "assistant") {
    return { status: 400, body: { error: "only assistant messages can be rated" } };
  }

  // Snapshot server-side: answer = the message content; question = nearest
  // prior user row. pickQuestionText compares with `<=` DELIBERATELY (F10):
  // logTurn inserts both rows in one statement, so the user row's timestamp
  // can equal the assistant row's — a strict `<` would miss it.
  const userRows = await db.getUserRows(message.conversation_id);
  const question = pickQuestionText(userRows, message.created_at) ?? "";

  const { error } = await db.upsertFeedback({
    dedup_key: internalFeedbackDedupKey(input.messageId),
    surface: "internal",
    message_id: input.messageId,
    conversation_id: message.conversation_id,
    user_id: callerId,
    rating: input.rating,
    // Reason kept only on a thumbs-down; a flip to thumbs-up nulls it (also
    // DB-enforced by the 0062 F14 check).
    reason: input.rating === -1 ? (input.reason?.trim() || null) : null,
    question_text: question.slice(0, FEEDBACK_QUESTION_MAX),
    answer_text: (message.content ?? "").slice(0, FEEDBACK_ANSWER_MAX),
    model: message.model,
  });
  if (error) return { status: 500, body: { error: `feedback save failed: ${error.message}` } };
  return { status: 200, body: { ok: true } };
}

/** Rate one of the caller's own assistant messages (upsert — change of mind
 *  allowed; one vote per answer via dedup_key). */
thomRoutes.post("/feedback", requireAuth, requireFeature("thom"), async (c) => {
  const gate = requireInternal(c);
  if (!gate.ok) return gate.res;
  const user = gate.user;

  const parsed = FeedbackBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload" }, 400);

  const admin = serviceSupabase(c.env);
  const db: InternalFeedbackDb = {
    async getMessage(id) {
      const { data } = await admin
        .from("thom_messages")
        .select("id, conversation_id, role, content, created_at, model")
        .eq("id", id)
        .maybeSingle();
      return (data as Awaited<ReturnType<InternalFeedbackDb["getMessage"]>>) ?? null;
    },
    async getConversationOwner(conversationId) {
      const { data } = await admin
        .from("thom_conversations")
        .select("user_id")
        .eq("id", conversationId)
        .maybeSingle();
      return (data as { user_id: string | null } | null) ?? null;
    },
    async getUserRows(conversationId) {
      const { data } = await admin
        .from("thom_messages")
        .select("content, created_at")
        .eq("conversation_id", conversationId)
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .limit(50);
      return (data ?? []) as { content: string | null; created_at: string }[];
    },
    async upsertFeedback(row) {
      const { error } = await admin
        .from("thom_feedback")
        .upsert(row, { onConflict: "dedup_key" });
      return { error: error ? { message: error.message } : null };
    },
  };

  const result = await applyInternalFeedback(db, user.id, parsed.data);
  return c.json(result.body, result.status);
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
