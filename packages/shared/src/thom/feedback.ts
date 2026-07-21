/**
 * Thom response feedback — pure helpers shared by the API worker, the public
 * worker/widget, and the web app (migration 0062, plan docs/thom-feedback-plan.md).
 *
 * Everything here is pure (no I/O) so the dedup-key derivation, the
 * question-snapshot selection, and the UI vote-state rules are unit-tested
 * once and reused by every surface.
 */

export type FeedbackRating = 1 | -1;

/** Hard caps, mirrored by the 0062 CHECK constraints and the route zod. */
export const FEEDBACK_REASON_MAX = 1_000;
export const FEEDBACK_QUESTION_MAX = 8_000;
/** Unmatched PUBLIC rows store client-supplied answer text capped here (F3/F12). */
export const FEEDBACK_PUBLIC_ANSWER_MAX = 16_000;
/** Server/DB-sourced answer snapshots may use the full column cap. */
export const FEEDBACK_ANSWER_MAX = 64_000;
/** Widget-minted client turn id cap (bridge zod re-enforces). */
export const FEEDBACK_TURN_ID_MAX = 64;

// -----------------------------------------------------------------------------
// dedup_key derivation (F1/F2): ONE total unique key, two prefixes. All
// writers upsert with onConflict: "dedup_key" — never a partial index.
// -----------------------------------------------------------------------------

/** Internal rows: one vote per assistant message. */
export function internalFeedbackDedupKey(messageId: string): string {
  return `msg:${messageId}`;
}

/** Public rows: one vote per (session, client-minted turn id). */
export function publicFeedbackDedupKey(sessionKey: string, clientTurnId: string): string {
  return `pub:${sessionKey}:${clientTurnId}`;
}

// -----------------------------------------------------------------------------
// Vote-state rule (both surfaces): which turns show the thumbs row.
// -----------------------------------------------------------------------------

/** True when a transcript turn should render the feedback thumbs: a COMPLETED
 *  (not streaming), non-error assistant turn that has a rating key (internal:
 *  server message id; public: client-minted turn id). */
export function showFeedbackRow(turn: {
  role: string;
  error?: boolean;
  id?: string | null;
  streaming?: boolean;
}): boolean {
  return turn.role === "assistant" && !turn.error && !turn.streaming && Boolean(turn.id);
}

// -----------------------------------------------------------------------------
// Analytics row shaping (F3): unverified badge iff public + no matched message.
// -----------------------------------------------------------------------------

/** A public feedback row that the log bridge could not match to a logged
 *  message stores visitor-supplied probe text — badge it and keep it out of
 *  the positive-rate numerator/denominator. */
export function isUnverifiedFeedback(row: {
  surface: string;
  message_id: string | null;
}): boolean {
  return row.surface === "public" && row.message_id == null;
}

// -----------------------------------------------------------------------------
// Question-snapshot selection (F10).
// -----------------------------------------------------------------------------

/**
 * Pick the question for an assistant row: the nearest prior 'user' row in the
 * same conversation. The comparison is `<=`, DELIBERATELY not `<`: logTurn
 * inserts the user and assistant rows in one statement, so the user row's
 * created_at can EQUAL the assistant row's — a strict `<` would miss it.
 * Rows may arrive in any order; latest qualifying row wins.
 */
export function pickQuestionText(
  userRows: { content: string | null; created_at: string }[],
  assistantCreatedAt: string,
): string | null {
  const cutoff = Date.parse(assistantCreatedAt);
  let best: { t: number; content: string } | null = null;
  for (const row of userRows) {
    const t = Date.parse(row.created_at);
    if (!Number.isFinite(t) || !Number.isFinite(cutoff)) continue;
    if (t <= cutoff && typeof row.content === "string" && row.content) {
      if (!best || t >= best.t) best = { t, content: row.content };
    }
  }
  return best?.content ?? null;
}

// -----------------------------------------------------------------------------
// Public bridge matching (F3): find the logged turn a public rating refers to.
// -----------------------------------------------------------------------------

export interface FeedbackMatchRow {
  id: string;
  role: string;
  content: string | null;
  created_at: string;
  model?: string | null;
}

export interface FeedbackMatch {
  messageId: string;
  /** Snapshots FROM THE MATCHED DB ROWS — the client text was only a probe. */
  answerText: string;
  questionText: string | null;
  model: string | null;
}

/**
 * Within one conversation's messages, match the MOST RECENT assistant row
 * whose content exactly equals the client-sent answer probe; the question then
 * comes from the nearest prior user row (same `<=` rule as pickQuestionText).
 * Returns null when nothing matches (feedback can land before the waitUntil
 * turn log does) — the caller stores client text with message_id null, which
 * IS the unverified flag.
 */
export function matchFeedbackTurn(
  messages: FeedbackMatchRow[],
  answer: string,
): FeedbackMatch | null {
  let matched: FeedbackMatchRow | null = null;
  for (const m of messages) {
    if (m.role !== "assistant" || m.content !== answer) continue;
    if (!matched || Date.parse(m.created_at) > Date.parse(matched.created_at)) matched = m;
  }
  if (!matched) return null;
  const userRows = messages
    .filter((m) => m.role === "user")
    .map((m) => ({ content: m.content, created_at: m.created_at }));
  return {
    messageId: matched.id,
    answerText: matched.content ?? "",
    questionText: pickQuestionText(userRows, matched.created_at),
    model: matched.model ?? null,
  };
}
