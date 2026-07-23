import type { ThomEnv } from "./env.js";

/**
 * Minimal Anthropic Messages API client for the Thom Bot brain.
 * Modeled on gemini.ts: env-gated fetch wrapper, no SDK dependency (matches
 * the repo's hand-rolled vendor clients — gemini.ts, zendesk.ts, hubspot hs()).
 * Distinct vendor from the image pipeline, which stays on Gemini.
 *
 * Cost design (the reason this file looks the way it does):
 * - Model tiering: the ROUTER model (Haiku-class) handles routing and simple
 *   lookups; the main MODEL (Sonnet-class) is escalated to for multi-doc
 *   synthesis. Chosen per-call by the agent loop, defaulted here.
 * - Prompt caching: callers mark the static prefix (tools + system + brand
 *   context) with cache_control breakpoints. Caching is a PREFIX match on the
 *   rendered request (tools -> system -> messages), so the volatile parts
 *   (user question, tool results) must stay after the last breakpoint. A
 *   breakpoint on the LAST system block caches tools + system together.
 *   NOTE: prefixes below the model's minimum (4096 tokens on Haiku 4.5) are
 *   silently not cached — verify via usage.cache_read_input_tokens, don't
 *   assume.
 * - No sampling params: current models reject non-default temperature/top_p
 *   (400), so this client deliberately has no way to send them.
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Aliases, not dated snapshots — they track the current model revisions.
const ROUTER_MODEL_DEFAULT = "claude-haiku-4-5";
const MODEL_DEFAULT = "claude-sonnet-5";
const ANTHROPIC_TIMEOUT_MS = 60_000;

export function anthropicConfigured(env: ThomEnv): boolean {
  return !!env.ANTHROPIC_API_KEY;
}

export function claudeRouterModel(env: ThomEnv): string {
  return env.ANTHROPIC_ROUTER_MODEL || ROUTER_MODEL_DEFAULT;
}

export function claudeModel(env: ThomEnv): string {
  return env.ANTHROPIC_MODEL || MODEL_DEFAULT;
}

// ---------------------------------------------------------------------------
// Wire types (the subset Thom uses). Kept hand-written and minimal, like the
// other vendor clients in this app.
// ---------------------------------------------------------------------------

export interface ClaudeCacheControl {
  type: "ephemeral";
}

export interface ClaudeSystemBlock {
  type: "text";
  text: string;
  cache_control?: ClaudeCacheControl;
}

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Set on the LAST tool to add a cache breakpoint after the tool list. */
  cache_control?: ClaudeCacheControl;
}

/**
 * A server-side (Anthropic-hosted) tool such as web_search. Anthropic executes
 * these — they never reach dispatch(). Rendered AFTER the client `tools` so the
 * withTailCache breakpoint (on the last CLIENT tool) stays intact.
 */
export interface ClaudeServerTool {
  type: string;
  name: string;
  max_uses?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

export interface ClaudeTextBlock {
  type: "text";
  text: string;
  /** Web-search citations attached by the server to a cited text block. */
  citations?: ClaudeWebSearchResultLocation[];
}

export interface ClaudeThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ClaudeTextBlock[];
  is_error?: boolean;
}

// --- Server-tool (web_search) blocks ----------------------------------------
// Anthropic executes web_search server-side: the model emits a server_tool_use
// block (NOT a client tool_use, so it never reaches dispatch()), and the server
// appends a web_search_tool_result. Web-tool errors return HTTP 200 with the
// error shape below — never a thrown exception.

export interface ClaudeServerToolUseBlock {
  type: "server_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeWebSearchResult {
  type: "web_search_result";
  url: string;
  title: string;
  page_age?: string | null;
  encrypted_content?: string;
}

export interface ClaudeWebSearchResultLocation {
  type: "web_search_result_location";
  url: string;
  title: string;
  cited_text?: string;
  encrypted_index?: string;
}

export interface ClaudeWebSearchToolResultBlock {
  type: "web_search_tool_result";
  tool_use_id: string;
  /** Success → an ARRAY of results; failure → a single error OBJECT. */
  content:
    | ClaudeWebSearchResult[]
    | { type: "web_search_tool_result_error"; error_code: string };
}

/**
 * A base64 image content block (vision input — e.g. the Descriptions tray
 * page-name reader). Request-side only: the model never emits image blocks,
 * so response handling is unaffected.
 */
export interface ClaudeImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
    data: string;
  };
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeThinkingBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock
  | ClaudeServerToolUseBlock
  | ClaudeWebSearchToolResultBlock
  | ClaudeImageBlock;

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  // Cache accounting — the proof the prompt-caching lever is actually working.
  // If cache_read_input_tokens stays 0 across turns, a silent invalidator is
  // at work (unstable prefix bytes) and input cost is silently full-price.
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ClaudeResponse {
  id: string;
  model: string;
  content: ClaudeContentBlock[];
  /** "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn" | ... */
  stop_reason: string;
  usage: ClaudeUsage;
}

export interface ClaudeRequestOpts {
  /** Ordered system blocks; put cache_control on the last stable block. */
  system: ClaudeSystemBlock[];
  messages: ClaudeMessage[];
  tools?: ClaudeTool[];
  /** Server-side (Anthropic-hosted) tools, e.g. web_search. Rendered AFTER the
   *  client `tools` so the withTailCache breakpoint on the last client tool is
   *  unaffected. */
  serverTools?: ClaudeServerTool[];
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Request core
// ---------------------------------------------------------------------------

function buildBody(env: ThomEnv, opts: ClaudeRequestOpts, stream: boolean): string {
  // Client tools FIRST, server tools (web_search) AFTER — keeps the
  // withTailCache breakpoint (on the last CLIENT tool) at a stable position.
  const tools = [...(opts.tools ?? []), ...(opts.serverTools ?? [])];
  return JSON.stringify({
    model: opts.model || claudeRouterModel(env),
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    messages: opts.messages,
    ...(tools.length ? { tools } : {}),
    ...(stream ? { stream: true } : {}),
  });
}

async function anthropicFetch(
  env: ThomEnv,
  body: string,
  timeoutMs: number,
): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("Thom chat is not configured (ANTHROPIC_API_KEY is unset)");
  }
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return res;
    // Retry transient rate-limit / server errors (429, 5xx incl. 529
    // overloaded). Safe for streaming too: a non-ok response never started
    // delivering SSE, so no partial output is duplicated.
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const ra = Number(res.headers.get("retry-after"));
      const wait =
        Number.isFinite(ra) && ra > 0
          ? ra * 1000
          : Math.min(8_000, 400 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic responded ${res.status}: ${errText.slice(0, 300)}`);
  }
}

/**
 * Non-streaming call — the agent loop's tool-use turns. The final user-facing
 * turn should use claudeMessagesStream instead so tokens reach the client as
 * they're generated.
 */
export async function claudeMessages(
  env: ThomEnv,
  opts: ClaudeRequestOpts,
): Promise<ClaudeResponse> {
  const res = await anthropicFetch(
    env,
    buildBody(env, opts, false),
    opts.timeoutMs ?? ANTHROPIC_TIMEOUT_MS,
  );
  return (await res.json()) as ClaudeResponse;
}

// ---------------------------------------------------------------------------
// Streaming (SSE)
// ---------------------------------------------------------------------------

/** The subset of Anthropic SSE events the chat surface consumes. */
export type ClaudeStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "tool_input_delta"; index: number; partial_json: string }
  // Server-side (Anthropic-hosted) tool call, e.g. web_search. Accumulate its
  // input_json_delta like a normal tool; it never reaches client dispatch.
  | { type: "server_tool_use_start"; index: number; id: string; name: string }
  // A web_search_tool_result block, captured whole from content_block_start so
  // the reconstructor can rebuild it into assistant history verbatim.
  | { type: "web_search_result"; index: number; content: ClaudeWebSearchToolResultBlock }
  | { type: "block_stop"; index: number }
  | { type: "done"; stopReason: string; usage: ClaudeUsage | null };

/**
 * Streaming call. Yields text deltas as they arrive (for SSE pass-through to
 * the chat UI) and a terminal "done" event carrying stop_reason + usage for
 * conversation logging. Client tool-use blocks are surfaced so the agent loop
 * can stream AND detect tool calls in one pass; server-tool blocks
 * (server_tool_use + web_search_tool_result) are surfaced too so the loop can
 * rebuild history and compose web_search with streaming. The pause_turn
 * stop_reason forwards through the terminal "done" event (from message_delta),
 * so runThomStream can resume a paused server-tool turn exactly like runThom.
 */
export async function* claudeMessagesStream(
  env: ThomEnv,
  opts: ClaudeRequestOpts,
): AsyncGenerator<ClaudeStreamEvent> {
  const res = await anthropicFetch(
    env,
    buildBody(env, opts, true),
    opts.timeoutMs ?? ANTHROPIC_TIMEOUT_MS,
  );
  if (!res.body) throw new Error("Anthropic returned no response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let stopReason = "end_turn";
  // usage arrives split across message_start (input side) and message_delta
  // (output side) — merge as events land.
  let usage: ClaudeUsage | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; keep the trailing partial.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLine = frame
          .split("\n")
          .find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        let event: {
          type?: string;
          index?: number;
          message?: { usage?: Partial<ClaudeUsage> };
          content_block?: {
            type?: string;
            id?: string;
            name?: string;
            tool_use_id?: string;
            content?: ClaudeWebSearchToolResultBlock["content"];
          };
          delta?: {
            type?: string;
            text?: string;
            partial_json?: string;
            stop_reason?: string;
          };
          usage?: Partial<ClaudeUsage>;
        };
        try {
          event = JSON.parse(dataLine.slice(5));
        } catch {
          continue; // malformed frame — skip rather than kill the stream
        }

        switch (event.type) {
          case "message_start": {
            const u = event.message?.usage;
            if (u) usage = { ...emptyUsage(), ...(usage ?? {}), ...u };
            break;
          }
          case "content_block_start": {
            const cb = event.content_block;
            if (cb?.type === "tool_use" && cb.id && cb.name) {
              yield {
                type: "tool_use_start",
                index: event.index ?? 0,
                id: cb.id,
                name: cb.name,
              };
            } else if (cb?.type === "server_tool_use" && cb.id && cb.name) {
              // Server-executed tool (web_search). Its input_json_delta is
              // handled by the shared content_block_delta case below.
              yield {
                type: "server_tool_use_start",
                index: event.index ?? 0,
                id: cb.id,
                name: cb.name,
              };
            } else if (cb?.type === "web_search_tool_result") {
              // Server-tool RESULT: the content (result array, or the single
              // error object) arrives whole in content_block_start — capture it
              // and rebuild the block so history matches the non-streaming path.
              yield {
                type: "web_search_result",
                index: event.index ?? 0,
                content: {
                  type: "web_search_tool_result",
                  tool_use_id: cb.tool_use_id ?? "",
                  content: cb.content ?? [],
                },
              };
            }
            break;
          }
          case "content_block_delta": {
            if (event.delta?.type === "text_delta" && event.delta.text) {
              yield { type: "text", text: event.delta.text };
            } else if (
              event.delta?.type === "input_json_delta" &&
              event.delta.partial_json !== undefined
            ) {
              yield {
                type: "tool_input_delta",
                index: event.index ?? 0,
                partial_json: event.delta.partial_json,
              };
            }
            break;
          }
          case "content_block_stop":
            yield { type: "block_stop", index: event.index ?? 0 };
            break;
          case "message_delta": {
            if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
            if (event.usage)
              usage = { ...emptyUsage(), ...(usage ?? {}), ...event.usage };
            break;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  yield { type: "done", stopReason, usage };
}

function emptyUsage(): ClaudeUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}
