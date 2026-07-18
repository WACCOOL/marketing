import { parseSSEBuffer, type SSEFrame } from "@wac/shared";
import { api } from "./api.js";
import { supabase } from "./supabase.js";

const STREAM_BASE = import.meta.env.VITE_API_BASE_URL ?? ""; // empty -> same origin

// Re-export the pure SSE frame parser (lives in @wac/shared so it's unit-tested
// outside the browser bundle). Kept on the thom client's surface for callers.
export { parseSSEBuffer, type SSEFrame };

/** Client for the internal Thom chat endpoint (mirrors apps/api/src/thom/types). */

export interface KeySpec {
  label: string;
  value: string;
}
export interface DocDownload {
  label: string;
  url: string;
  doc_type: string;
}
export interface ProductCard {
  kind: "product";
  sku: string;
  name: string | null;
  brand: string | null;
  image_url: string | null;
  key_specs: KeySpec[];
  pdp_url: string | null;
  downloads: DocDownload[];
}
export interface FamilyMember {
  sku: string;
  name: string | null;
  role: string | null;
  image_url: string | null;
  pdp_url: string | null;
}
export interface FamilyCard {
  kind: "family";
  family: string;
  brand: string | null;
  image_url: string | null;
  category: string | null;
  members: FamilyMember[];
  member_count: number;
}
/** One aggregated line of a layout / track bill of materials. */
export interface LayoutBomLine {
  sku: string | null;
  description: string;
  qty: number;
  role: string;
}
/** A layout card — a lighting layout + bill of materials for a space. Mirrors
 *  apps/api/src/thom/types.ts LayoutCard. `plan` coords are normalized 0..1. */
export interface LayoutCard {
  kind: "layout";
  space: { lengthFt: number; widthFt: number; mountingHeightFt: number };
  product: { sku: string | null; name: string | null; family: string | null };
  layoutKind: "track" | "area-grid" | "linear";
  summary: {
    headCount: number;
    runs?: number;
    headsPerRun?: number;
    headSpacingFt?: number;
    totalTrackFt?: number;
    transformerCount?: number;
    circuits?: number;
    avgFc: number;
    uniformity: number;
    totalWatts: number;
  };
  bom: { lines: LayoutBomLine[] };
  plan?: {
    runs: { x1: number; y1: number; x2: number; y2: number }[];
    heads: { x: number; y: number }[];
    heatmap?: { cols: number; rows: number; values: number[][]; min: number; max: number };
  };
  warnings: string[];
}
/** Any kind of card. Cards logged before the family feature have no `kind`;
 *  treat missing/`"product"` as a ProductCard on the client. */
export type Card = ProductCard | FamilyCard | LayoutCard;
export interface Citation {
  /** "web" for open-web sources (web_search); absent/"doc" for spec-sheet /
   *  manual citations. */
  kind?: "doc" | "web";
  document_id: string;
  title: string | null;
  doc_type: string;
  page: number | null;
  url: string | null;
}
export interface ChatResponse {
  conversationId: string;
  answer: string;
  cards: Card[];
  citations: Citation[];
}

export function sendChat(
  message: string,
  conversationId: string | null,
): Promise<ChatResponse> {
  return api<ChatResponse>("/api/thom/chat", {
    method: "POST",
    body: JSON.stringify({ message, conversationId: conversationId ?? undefined }),
  });
}

// --- Chat history ------------------------------------------------------------

/** One past conversation as shown in the history drawer. */
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  messageCount: number;
}

/** One persisted turn as reloaded from the server (mirrors ThomChat's Turn). */
export interface StoredTurn {
  role: "user" | "assistant";
  text: string;
  cards?: Card[];
  citations?: Citation[];
}

/** List the current user's recent Thom conversations (newest first). */
export async function listConversations(): Promise<ConversationSummary[]> {
  const { conversations } = await api<{ conversations: ConversationSummary[] }>(
    "/api/thom/conversations",
  );
  return conversations;
}

/** Load one conversation's turns to reload-and-continue. */
export function getConversation(
  id: string,
): Promise<{ conversationId: string; turns: StoredTurn[] }> {
  return api<{ conversationId: string; turns: StoredTurn[] }>(
    `/api/thom/conversations/${encodeURIComponent(id)}`,
  );
}

/** Delete one of the user's conversations. */
export async function deleteConversation(id: string): Promise<void> {
  await api<{ ok: true }>(`/api/thom/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// --- Streaming (SSE) ---------------------------------------------------------

/** Callbacks for chatStream. onError receives the HTTP status when the failure
 *  is a non-ok response (used by the UI for the 503 "not configured" message).
 *  AbortError is treated as silent (no callback fires). */
export interface StreamCallbacks {
  onMeta: (conversationId: string) => void;
  onDelta: (text: string) => void;
  onCards: (cards: Card[]) => void;
  onCitations: (citations: Citation[]) => void;
  onDone: () => void;
  onError: (err: { status?: number; error: string }) => void;
}

/** Route one parsed frame to the matching callback. Unknown events are ignored
 *  (forward-compatible). Malformed JSON in a data frame is skipped, not fatal. */
function dispatchFrame(frame: SSEFrame, cb: StreamCallbacks): void {
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    return; // malformed frame — skip rather than kill the stream
  }
  const p = payload as {
    conversationId?: string;
    text?: string;
    cards?: Card[];
    citations?: Citation[];
    error?: string;
  };
  switch (frame.event) {
    case "meta":
      if (p.conversationId) cb.onMeta(p.conversationId);
      break;
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
    // unknown events ignored
  }
}

/**
 * Stream a chat turn from POST /api/thom/chat/stream. Uses its own fetch (api()
 * buffers the whole body) with the same Bearer-token auth pattern. Reads the
 * SSE body incrementally and drives the callbacks. AbortError is silent.
 */
export async function chatStream(
  message: string,
  conversationId: string | null,
  cb: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${STREAM_BASE}/api/thom/chat/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message, conversationId: conversationId ?? undefined }),
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
      // non-JSON error body — keep statusText
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
