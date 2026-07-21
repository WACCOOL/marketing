import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { anthropicConfigured, runThomStream, type ClaudeMessage } from "@wac/shared/thom";
import type { PublicEnv } from "./env.js";
import { anonSupabase } from "./supabase.js";
import { verifyTurnstile } from "./turnstile.js";
import { DEFAULT_SESSION_TTL_MS, mintSession, publicSessionKey, verifySession } from "./session.js";
import { feedbackRoutes } from "./feedback.js";
import {
  checkAndAddTokens,
  checkAndIncrRate,
  rateCapsFromEnv,
  tokenCapsFromEnv,
} from "./limits.js";
import { frameAncestors, originAllowed } from "./origins.js";

/**
 * PUBLIC Thom Bot Worker.
 *
 * The anon-only public surface of the shared Thom brain. It holds NO
 * service-role key and NO HubSpot token (see src/env.ts, "security layer 1"),
 * reads Supabase through the anon/RLS client (src/supabase.ts, "layer 2"), and
 * gates the billed chat stream behind Turnstile → a short-lived IP-bound session
 * → per-minute/day request caps → a per-IP and GLOBAL per-day token cap.
 *
 * Session-only history: there is no thom_conversations / thom_messages write on
 * this surface. Prior turns arrive in the request body (capped to
 * MAX_HISTORY_TURNS) and are never persisted server-side.
 */

const MAX_HISTORY_TURNS = 12;
/** Cap on the incoming user message length (chars) — cheap abuse guard. */
const MAX_MESSAGE_CHARS = 4000;

const app = new Hono<{ Bindings: PublicEnv }>();

app.get("/_health", (c) => c.text("ok"));

/**
 * GET /api/config — public runtime config for the widget.
 * Returns the PUBLIC Turnstile site key so the widget can render the challenge.
 * Origin-gated, but the widget's own same-origin fetch is always allowed: the
 * widget page is served by this Worker, so its config request is either
 * Origin-less (same-origin GET) or carries the Worker's own origin. Cross-origin
 * callers must still be on the embed allowlist.
 */
app.get("/api/config", (c) => {
  const origin = c.req.header("Origin") ?? null;
  const selfOrigin = new URL(c.req.url).origin;
  const ok = !origin || origin === selfOrigin || originAllowed(c.env, origin);
  if (!ok) return c.json({ error: "origin not allowed" }, 403);
  return c.json({
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY ?? "",
    // Dark-launch flag for the thumbs UI. UX ONLY — the /api/feedback route
    // itself 404s server-side while THOM_FEEDBACK is unset (F8). Requires the
    // log bridge too: without it there is nowhere to store a vote.
    feedbackEnabled:
      c.env.THOM_FEEDBACK === "1" && Boolean(c.env.THOM_LOG_URL && c.env.THOM_LOG_TOKEN),
  });
});

// Feedback (thumbs) — module has the full guard chain; dark (404) until
// THOM_FEEDBACK="1".
app.route("/api/feedback", feedbackRoutes);

/** CF-Connecting-IP, or "" when absent (local dev). */
function callerIp(c: Context<{ Bindings: PublicEnv }>): string {
  return c.req.header("CF-Connecting-IP") ?? "";
}

/**
 * POST /api/turnstile — exchange a solved Turnstile token for a session token.
 * Body: { token, siteKey }. Requires an allowed Origin. 403 disallowed origin,
 * 401 failed challenge.
 */
app.post("/api/turnstile", async (c) => {
  const origin = c.req.header("Origin");
  if (!originAllowed(c.env, origin ?? null)) return c.json({ error: "origin not allowed" }, 403);

  const body = (await c.req.json().catch(() => ({}))) as { token?: unknown; siteKey?: unknown };
  const token = typeof body.token === "string" ? body.token : "";
  const siteKey = typeof body.siteKey === "string" ? body.siteKey : "";
  if (!token || !siteKey) return c.json({ error: "token and siteKey are required" }, 400);

  const ip = callerIp(c);
  const ok = await verifyTurnstile(token, ip || null, c.env.TURNSTILE_SECRET);
  if (!ok) return c.json({ error: "turnstile verification failed" }, 401);

  const now = Date.now();
  const session = await mintSession(c.env, { siteKey, ip, now });
  // exp lets the widget persist the token and re-challenge only when it lapses.
  return c.json({ session, exp: now + DEFAULT_SESSION_TTL_MS });
});

/**
 * POST /api/chat/stream (SSE) — run one public Thom turn.
 * Requires: allowed Origin, a valid IP-bound session token, and under all caps.
 * Body: { message, session?, history? }. The session token may also arrive as
 * `Authorization: Bearer <token>` or `X-Thom-Session: <token>`.
 * SSE events mirror the internal route: meta | text | cards | citations | done | error.
 */
app.post("/api/chat/stream", async (c) => {
  const origin = c.req.header("Origin");
  const csp = `frame-ancestors ${frameAncestors(c.env)}`;
  if (!originAllowed(c.env, origin ?? null)) {
    return c.json({ error: "origin not allowed" }, 403, { "Content-Security-Policy": csp });
  }
  if (!anthropicConfigured(c.env)) {
    return c.json({ error: "Thom is not configured" }, 503, { "Content-Security-Policy": csp });
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    message?: unknown;
    session?: unknown;
    history?: unknown;
  };

  // Session token: body.session, or Authorization: Bearer, or X-Thom-Session.
  const bearer = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const sessionToken =
    (typeof body.session === "string" && body.session) ||
    c.req.header("X-Thom-Session") ||
    bearer ||
    "";

  const ip = callerIp(c);
  const validSession = await verifySession(c.env, sessionToken, { ip });
  if (!validSession) {
    return c.json({ error: "invalid or expired session" }, 401, { "Content-Security-Policy": csp });
  }

  const message = String((body.message as string | undefined) ?? "")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
  if (!message) {
    return c.json({ error: "message is required" }, 400, { "Content-Security-Policy": csp });
  }

  // Pre-check REQUEST caps (increments) then the TOKEN caps (read-only, add=0).
  const rate = await checkAndIncrRate(c.env.THOM_KV, {
    ip,
    siteKey: siteKeyFromToken(sessionToken),
    caps: rateCapsFromEnv(c.env),
  });
  if (!rate.ok) {
    return c.json(
      { error: "You've hit the usage limit for now. Please try again in a bit." },
      429,
      { "Content-Security-Policy": csp, "Retry-After": rate.reason === "rate_minute" ? "60" : "3600" },
    );
  }
  const tokenCaps = tokenCapsFromEnv(c.env);
  const tokenPre = await checkAndAddTokens(c.env.THOM_KV, { ip, dayTokens: 0, caps: tokenCaps });
  if (!tokenPre.ok) {
    return c.json(
      { error: "Thom is resting for the day — the usage limit has been reached. Please try again tomorrow." },
      429,
      { "Content-Security-Policy": csp, "Retry-After": "3600" },
    );
  }

  const history = boundHistory(body.history);
  const sb = anonSupabase(c.env);

  // Turn logging (admin chat viewer + analytics): accumulate the turn and POST
  // it to the API worker's shared-secret bridge AFTER the stream finishes.
  // This worker deliberately holds no service key; the bridge does the write.
  // Skipped silently unless THOM_LOG_URL + THOM_LOG_TOKEN are configured, and
  // never allowed to affect the visitor's stream.
  const turnLog = {
    answer: "",
    cards: [] as unknown[],
    citations: [] as unknown[],
    toolCalls: [] as { name: string; input: unknown }[],
    usage: null as { model?: string; input_tokens?: number; output_tokens?: number } | null,
  };
  const sendTurnLog = async (): Promise<void> => {
    const url = c.env.THOM_LOG_URL;
    const token = c.env.THOM_LOG_TOKEN;
    if (!url || !token) return;
    try {
      // Shared derivation with /api/feedback so votes and turns group under
      // the same anonymous session key.
      const sessionKey = await publicSessionKey(sessionToken);
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-thom-log-token": token },
        body: JSON.stringify({
          session_key: sessionKey,
          site_key: siteKeyFromToken(sessionToken) ?? c.req.header("origin") ?? null,
          question: message,
          answer: turnLog.answer.slice(0, 64_000),
          tool_calls: turnLog.toolCalls.slice(0, 40),
          citations: turnLog.citations.length ? turnLog.citations : undefined,
          product_cards: turnLog.cards.length ? turnLog.cards : undefined,
          model: turnLog.usage?.model,
          input_tokens: turnLog.usage?.input_tokens,
          output_tokens: turnLog.usage?.output_tokens,
        }),
      });
    } catch {
      // best-effort only
    }
  };

  c.header("Content-Security-Policy", csp);
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "meta", data: JSON.stringify({ surface: "public" }) });
    try {
      for await (const ev of runThomStream(c.env, sb, {
        surface: "public",
        history,
        userMessage: message,
      })) {
        if (ev.type === "text") {
          turnLog.answer += ev.text;
          await stream.writeSSE({ event: "text", data: JSON.stringify({ text: ev.text }) });
        } else if (ev.type === "cards") {
          turnLog.cards.push(...ev.cards);
          await stream.writeSSE({ event: "cards", data: JSON.stringify({ cards: ev.cards }) });
        } else if (ev.type === "citations") {
          turnLog.citations.push(...ev.citations);
          await stream.writeSSE({ event: "citations", data: JSON.stringify({ citations: ev.citations }) });
        } else if (ev.type === "final") {
          // Record token usage AFTER the turn (soft cap; the next pre-check enforces).
          const used = ev.usage.input_tokens + ev.usage.output_tokens;
          await checkAndAddTokens(c.env.THOM_KV, { ip, dayTokens: used, caps: tokenCaps }).catch(() => {});
          turnLog.toolCalls = ev.toolCalls;
          turnLog.usage = {
            model: ev.usage.model,
            input_tokens: ev.usage.input_tokens,
            output_tokens: ev.usage.output_tokens,
          };
          c.executionCtx.waitUntil(sendTurnLog());
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

/** Bound + normalize client-supplied history to alternating text turns. */
function boundHistory(raw: unknown): ClaudeMessage[] {
  if (!Array.isArray(raw)) return [];
  const turns: ClaudeMessage[] = [];
  for (const t of raw) {
    const role = (t as { role?: unknown })?.role;
    const content = (t as { content?: unknown })?.content;
    if ((role === "user" || role === "assistant") && typeof content === "string" && content) {
      turns.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
    }
  }
  // Keep the most recent MAX_HISTORY_TURNS*2 messages (a turn = user+assistant).
  return turns.slice(-MAX_HISTORY_TURNS * 2);
}

/** Best-effort siteKey extraction from a session token's payload for keying the
 *  rate limiter. Falls back to "-" (still IP-scoped) if it can't be parsed. */
function siteKeyFromToken(token: string): string {
  try {
    const payload = token.split(".")[0] ?? "";
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const json = JSON.parse(atob(b64 + pad)) as { siteKey?: string };
    return json.siteKey || "-";
  } catch {
    return "-";
  }
}

export default { fetch: app.fetch } satisfies ExportedHandler<PublicEnv>;
