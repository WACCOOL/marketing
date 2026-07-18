import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { anthropicConfigured, runThomStream, type ClaudeMessage } from "@wac/shared/thom";
import type { PublicEnv } from "./env.js";
import { anonSupabase } from "./supabase.js";
import { verifyTurnstile } from "./turnstile.js";
import { mintSession, verifySession } from "./session.js";
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

  const session = await mintSession(c.env, { siteKey, ip });
  return c.json({ session });
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
          await stream.writeSSE({ event: "text", data: JSON.stringify({ text: ev.text }) });
        } else if (ev.type === "cards") {
          await stream.writeSSE({ event: "cards", data: JSON.stringify({ cards: ev.cards }) });
        } else if (ev.type === "citations") {
          await stream.writeSSE({ event: "citations", data: JSON.stringify({ citations: ev.citations }) });
        } else if (ev.type === "final") {
          // Record token usage AFTER the turn (soft cap; the next pre-check enforces).
          const used = ev.usage.input_tokens + ev.usage.output_tokens;
          await checkAndAddTokens(c.env.THOM_KV, { ip, dayTokens: used, caps: tokenCaps }).catch(() => {});
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
