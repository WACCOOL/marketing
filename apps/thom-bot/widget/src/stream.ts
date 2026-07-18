/**
 * SSE consumption for the PUBLIC chat endpoint. Reuses the pure, unit-tested
 * `parseSSEBuffer` from @wac/shared and mirrors the internal client's frame
 * dispatch (apps/web/src/lib/thom.ts) — minus the Supabase auth. Here the
 * request carries the short-lived Turnstile-minted session token instead.
 *
 * Events: meta | text | cards | citations | done | error (same as the internal
 * route). `onError` forwards the HTTP status so the caller can re-challenge on
 * 401 (expired session) and message the 429 caps / 503 not-configured cases.
 */
import { parseSSEBuffer, type SSEFrame } from "@wac/shared";
import type { Card, Citation } from "./types.js";

export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onCards: (cards: Card[]) => void;
  onCitations: (citations: Citation[]) => void;
  onDone: () => void;
  onError: (err: { status?: number; error: string }) => void;
}

export interface ChatRequest {
  message: string;
  session: string;
  history: { role: "user" | "assistant"; content: string }[];
}

function dispatchFrame(frame: SSEFrame, cb: StreamCallbacks): void {
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    return; // malformed frame — skip, don't kill the stream
  }
  const p = payload as { text?: string; cards?: Card[]; citations?: Citation[]; error?: string };
  switch (frame.event) {
    case "text":
      if (typeof p.text === "string") cb.onDelta(p.text);
      break;
    case "cards":
      if (p.cards) cb.onCards(p.cards);
      break;
    case "citations":
      if (p.citations) cb.onCitations(p.citations);
      break;
    case "done":
      cb.onDone();
      break;
    case "error":
      cb.onError({ error: p.error ?? "stream error" });
      break;
    // "meta" and unknown events are ignored (forward-compatible).
  }
}

/**
 * POST /api/chat/stream (same-origin) and drive the callbacks off the SSE body.
 * AbortError is silent. Non-ok responses surface {status, error}.
 */
export async function chatStream(
  req: ChatRequest,
  cb: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Thom-Session": req.session,
      },
      body: JSON.stringify({ message: req.message, session: req.session, history: req.history }),
      signal,
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    cb.onError({ error: e instanceof Error ? e.message : String(e) });
    return;
  }

  if (!res.ok || !res.body) {
    let error = res.statusText || "request failed";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body?.error != null) error = String(body.error);
    } catch {
      /* non-JSON error body — keep statusText */
    }
    cb.onError({ status: res.status, error });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = parseSSEBuffer(buffer);
      buffer = rest;
      for (const frame of frames) dispatchFrame(frame, cb);
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return;
    cb.onError({ error: e instanceof Error ? e.message : String(e) });
  }
}
