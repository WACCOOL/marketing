import { Hono } from "hono";
import type { Context } from "hono";
import {
  FEEDBACK_PUBLIC_ANSWER_MAX,
  FEEDBACK_QUESTION_MAX,
  FEEDBACK_REASON_MAX,
  FEEDBACK_TURN_ID_MAX,
} from "@wac/shared/thom";
import type { PublicEnv } from "./env.js";
import { publicSessionKey, verifySession } from "./session.js";
import { checkAndIncrRate, feedbackCapsFromEnv } from "./limits.js";
import { originAllowed } from "./origins.js";

/**
 * POST /api/feedback — rate one public Thom answer (thumbs up / down +
 * optional reason). Mounted by index.ts; kept in its own module so the guard
 * chain is unit-testable via feedbackRoutes.request().
 *
 * This worker holds NO service key, and thom_feedback has no anon insert
 * policy — the write rides the SAME shared-secret log bridge as turn logging
 * (POST ${THOM_LOG_URL}/feedback on the API worker). Unlike turn logging the
 * forward is awaited, so the widget gets a real ok/failure to render.
 *
 * Guards, in order:
 *   1. THOM_FEEDBACK server-side dark-launch gate (F8) → 404 when dark.
 *      Hiding the thumbs via /api/config is UX; this 404 is the control.
 *   2. Origin allowlist → 403.
 *   3. Turnstile-scoped, IP-bound session (verifySession) → 401 — feedback is
 *      exactly as bot-gated as chat.
 *   4. KV rate cap under a feedback-specific namespace with its own SMALLER
 *      caps (default 10/min, 40/day per IP; THOM_FEEDBACK_PER_MIN/_PER_DAY)
 *      → 429. Chat counters untouched.
 *   5. Input caps (hygiene only — the bridge zod re-enforces everything, F12).
 *   6. THOM_LOG_URL/TOKEN unset → 503 "feedback not available".
 */

export const feedbackRoutes = new Hono<{ Bindings: PublicEnv }>();

function callerIp(c: Context<{ Bindings: PublicEnv }>): string {
  return c.req.header("CF-Connecting-IP") ?? "";
}

feedbackRoutes.post("/", async (c) => {
  // 1. Dark-launch gate FIRST (F8): server-side, not just client-side hiding.
  if (c.env.THOM_FEEDBACK !== "1") return c.json({ error: "not found" }, 404);

  // 2. Origin allowlist.
  const origin = c.req.header("Origin");
  if (!originAllowed(c.env, origin ?? null)) return c.json({ error: "origin not allowed" }, 403);

  const body = (await c.req.json().catch(() => ({}))) as {
    session?: unknown;
    turnId?: unknown;
    rating?: unknown;
    reason?: unknown;
    question?: unknown;
    answer?: unknown;
  };

  // Session token: body.session, or Authorization: Bearer, or X-Thom-Session —
  // the same channels as /api/chat/stream.
  const bearer = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const sessionToken =
    (typeof body.session === "string" && body.session) ||
    c.req.header("X-Thom-Session") ||
    bearer ||
    "";

  // 3. Session gate.
  const ip = callerIp(c);
  if (!(await verifySession(c.env, sessionToken, { ip }))) {
    return c.json({ error: "invalid or expired session" }, 401);
  }

  // 4. Feedback-specific rate cap (own KV namespace + smaller caps).
  const rate = await checkAndIncrRate(c.env.THOM_KV, {
    ip,
    siteKey: siteKeyFromToken(sessionToken),
    caps: feedbackCapsFromEnv(c.env),
    kind: "fb",
  });
  if (!rate.ok) {
    return c.json(
      { error: "You've hit the feedback limit for now. Please try again in a bit." },
      429,
      { "Retry-After": rate.reason === "rate_minute" ? "60" : "3600" },
    );
  }

  // 5. Validate + cap inputs (hygiene only — the bridge re-enforces, F12).
  const rating = body.rating === 1 || body.rating === -1 ? body.rating : null;
  const turnId = typeof body.turnId === "string" ? body.turnId.trim() : "";
  const question = typeof body.question === "string" ? body.question.slice(0, FEEDBACK_QUESTION_MAX) : "";
  const answer = typeof body.answer === "string" ? body.answer.slice(0, FEEDBACK_PUBLIC_ANSWER_MAX) : "";
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.slice(0, FEEDBACK_REASON_MAX)
      : undefined;
  if (!rating || !turnId || turnId.length > FEEDBACK_TURN_ID_MAX || !question || !answer) {
    return c.json({ error: "invalid payload" }, 400);
  }

  // 6. Bridge configured? Without it there is nowhere to store a vote.
  const url = c.env.THOM_LOG_URL;
  const token = c.env.THOM_LOG_TOKEN;
  if (!url || !token) return c.json({ error: "feedback not available" }, 503);

  // Same session-key derivation as turn logging (shared helper) so the vote
  // lands under the same anonymous key as the logged conversation.
  const sessionKey = await publicSessionKey(sessionToken);

  // Forward to the bridge subroute. Awaited (NOT fire-and-forget) so the
  // widget can confirm the vote actually landed.
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-thom-log-token": token },
      body: JSON.stringify({
        session_key: sessionKey,
        site_key: siteKeyFromToken(sessionToken) ?? c.req.header("origin") ?? null,
        client_turn_id: turnId,
        rating,
        reason,
        question,
        answer,
      }),
    });
    if (!res.ok) return c.json({ error: "feedback failed" }, 502);
  } catch {
    return c.json({ error: "feedback failed" }, 502);
  }
  return c.json({ ok: true });
});

/** Best-effort siteKey extraction from a session token's payload (same logic
 *  as index.ts's rate-limiter keying). Falls back to "-" if unparseable. */
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
