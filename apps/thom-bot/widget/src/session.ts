/**
 * Session-only, browser-side transcript persistence.
 *
 * There is NO server-side history on the public surface. The running turn list
 * is kept in localStorage keyed by site_key + a per-tab session id, replayed on
 * reopen, and cleared by "New chat". Storage access is injected (defaults to
 * localStorage) and fully guarded, so this module is pure enough to unit-test in
 * a plain Node environment.
 */

import type { Turn } from "./types.js";

/** Max turns we replay / persist (mirrors the Worker's MAX_HISTORY_TURNS). */
export const MAX_HISTORY_TURNS = 12;

/** Minimal Storage shape (localStorage subset) so we can inject a mock. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** localStorage key for a given site + session id. */
export function historyKey(siteKey: string, sessionId: string): string {
  return `thom.public.history.${siteKey || "-"}.${sessionId}`;
}

/**
 * Return the session id for this tab, minting + persisting one on first use. A
 * session id scopes the transcript so two embeds on the same site don't collide.
 */
export function getSessionId(siteKey: string, storage: StorageLike | null = defaultStorage()): string {
  const key = `thom.public.session.${siteKey || "-"}`;
  try {
    const existing = storage?.getItem(key);
    if (existing) return existing;
  } catch {
    /* ignore */
  }
  const id = randomId();
  try {
    storage?.setItem(key, id);
  } catch {
    /* ignore */
  }
  return id;
}

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Load the persisted transcript (bounded), or [] when absent / unparseable. */
export function loadHistory(
  siteKey: string,
  sessionId: string,
  storage: StorageLike | null = defaultStorage(),
): Turn[] {
  try {
    const raw = storage?.getItem(historyKey(siteKey, sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return boundTurns(parsed as Turn[]);
  } catch {
    return [];
  }
}

/** Persist the transcript (bounded). Empty transcript removes the key. */
export function saveHistory(
  siteKey: string,
  sessionId: string,
  turns: Turn[],
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    const key = historyKey(siteKey, sessionId);
    if (!turns.length) {
      storage?.removeItem(key);
      return;
    }
    storage?.setItem(key, JSON.stringify(boundTurns(turns)));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}

/** Clear the persisted transcript for this site + session. */
export function clearHistory(
  siteKey: string,
  sessionId: string,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.removeItem(historyKey(siteKey, sessionId));
  } catch {
    /* ignore */
  }
}

/** Keep only the most recent MAX_HISTORY_TURNS*2 messages (a turn = user+assistant). */
export function boundTurns(turns: Turn[]): Turn[] {
  return turns.slice(-MAX_HISTORY_TURNS * 2);
}

/**
 * Shape the transcript into the bounded {role, content} array the Worker's
 * /api/chat/stream expects as `history` — text only, no cards/citations,
 * dropping the trailing empty in-progress assistant turn.
 */
export function toRequestHistory(turns: Turn[]): { role: "user" | "assistant"; content: string }[] {
  return boundTurns(turns)
    .filter((t) => typeof t.text === "string" && t.text.trim().length > 0 && !t.error)
    .map((t) => ({ role: t.role, content: t.text }));
}
