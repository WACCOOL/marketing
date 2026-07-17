import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import {
  claudeMessages,
  claudeModel,
  claudeRouterModel,
  type ClaudeContentBlock,
  type ClaudeMessage,
  type ClaudeTextBlock,
  type ClaudeTool,
  type ClaudeToolResultBlock,
  type ClaudeToolUseBlock,
} from "../anthropic.js";
import { internalSystem } from "./prompts.js";
import { dispatch, TOOLS } from "./tools.js";
import { HUBSPOT_TOOLS } from "./hubspotTools.js";
import type { Citation, ProductCard, ThomUsage } from "./types.js";

const MAX_STEPS = 5;
const MAX_TOKENS = 2048;

/** The internal CRM tools are only offered when a read token is configured. */
function crmEnabled(env: Env): boolean {
  return !!env.HUBSPOT_READ_TOKEN;
}

/**
 * Put a single cache breakpoint on the LAST tool of the composed array without
 * mutating the shared TOOLS/HUBSPOT_TOOLS constants: strip cache_control from
 * every tool (a stray mid-array breakpoint stops the prefix from caching), then
 * clone the tail and mark it. Pure — returns a fresh array of fresh objects.
 */
export function withTailCache(tools: ClaudeTool[]): ClaudeTool[] {
  const out = tools.map(({ cache_control: _drop, ...t }) => ({ ...t }) as ClaudeTool);
  const last = out[out.length - 1];
  if (last) last.cache_control = { type: "ephemeral" };
  return out;
}

export interface ThomResult {
  text: string;
  cards: ProductCard[];
  citations: Citation[];
  usage: ThomUsage;
}

/** Signals fed to the escalation predicate, all monotonically non-decreasing
 *  across the loop (evidence only accumulates), so once we cross a threshold we
 *  stay escalated — no flapping between models mid-conversation. */
export interface EscalationState {
  /** Total tool calls dispatched so far this turn. */
  toolCallCount: number;
  /** Distinct source passages (citations) gathered so far. */
  docPassageCount: number;
  /** Product cards gathered so far. */
  productCount: number;
  /** The user's message for this turn (intent detection). */
  userMessage: string;
}

// Genuine comparison / superlative intent. Deliberately TIGHT: a bare
// "... or ...?" matches almost any question ("downlights or track heads?") and
// would over-escalate, so it's intentionally excluded.
const COMPARISON_INTENT =
  /\b(vs\.?|versus|compared? to|comparison|difference between|which (is|one is) (better|best)|better than)\b/i;

/**
 * Whether this turn is "hard" enough to warrant the stronger model. Pure and
 * monotonic in the accumulated evidence: multi-doc synthesis (2+ passages),
 * multi-product work (2+ cards), a long tool chain (3+ calls), or an explicit
 * comparison once we have at least one tool result to compare against.
 */
export function shouldEscalate(s: EscalationState): boolean {
  if (s.docPassageCount >= 2) return true;
  if (s.productCount >= 2) return true;
  if (s.toolCallCount >= 3) return true;
  if (COMPARISON_INTENT.test(s.userMessage) && s.toolCallCount >= 1) return true;
  return false;
}

/** Model tiering is ON unless THOM_TIERING is explicitly "0" (safe rollback). */
export function tieringEnabled(env: Env): boolean {
  return env.THOM_TIERING !== "0";
}

/**
 * Run one internal Thom turn: a bounded tool-use loop over the retrieval tools.
 * Non-streaming (v1) — returns the final answer plus the product cards and
 * source citations gathered from tool calls. `history` is prior user/assistant
 * turns for context.
 */
export async function runThom(
  env: Env,
  sb: SupabaseClient,
  opts: { history: ClaudeMessage[]; userMessage: string },
): Promise<ThomResult> {
  const system = internalSystem();
  // internal surface only — CRM tools ride the internal agent, gated on the
  // read token, with the cache breakpoint re-homed to the composed tail.
  const tools = withTailCache(crmEnabled(env) ? [...TOOLS, ...HUBSPOT_TOOLS] : TOOLS);
  const messages: ClaudeMessage[] = [
    ...opts.history,
    { role: "user", content: opts.userMessage },
  ];
  const cards: ProductCard[] = [];
  const citations: Citation[] = [];
  let toolCallCount = 0;
  const usage: ThomUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    model: claudeRouterModel(env),
    escalated: false,
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    // Decide the model for THIS turn from the evidence accumulated so far.
    // Monotonic: once a threshold trips we stay on the stronger model. The
    // escalated turn is a prompt-cache miss (cache is per-model) — the intended
    // cost of a better answer.
    const escalate =
      tieringEnabled(env) &&
      shouldEscalate({
        toolCallCount,
        docPassageCount: citations.length,
        productCount: cards.length,
        userMessage: opts.userMessage,
      });
    const model = escalate ? claudeModel(env) : claudeRouterModel(env);
    usage.model = model; // last write wins → reflects the answering turn
    if (escalate) usage.escalated = true;

    const res = await claudeMessages(env, {
      system,
      messages,
      tools,
      model,
      maxTokens: MAX_TOKENS,
    });
    usage.input_tokens += res.usage.input_tokens;
    usage.output_tokens += res.usage.output_tokens;
    usage.cache_read_input_tokens += res.usage.cache_read_input_tokens;

    // Echo the assistant turn back for the next iteration.
    messages.push({ role: "assistant", content: res.content });

    const toolUses = res.content.filter(
      (b): b is ClaudeToolUseBlock => b.type === "tool_use",
    );
    if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
      console.log(
        `[thom] answered model=${usage.model} escalated=${usage.escalated} ` +
          `toolCalls=${toolCallCount} docPassages=${citations.length} products=${cards.length}`,
      );
      return { text: finalText(res.content), cards, citations, usage };
    }

    toolCallCount += toolUses.length;
    const results: ClaudeToolResultBlock[] = [];
    for (const tu of toolUses) {
      try {
        const out = await dispatch({ env, sb }, tu.name, tu.input);
        cards.push(...out.cards);
        citations.push(...out.citations);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out.content });
      } catch (e) {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Tool error: ${e instanceof Error ? e.message : String(e)}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }

  console.log(
    `[thom] answered model=${usage.model} escalated=${usage.escalated} ` +
      `toolCalls=${toolCallCount} docPassages=${citations.length} products=${cards.length} (max-steps)`,
  );
  return {
    text: "I couldn't finish that in a reasonable number of steps — try narrowing the question.",
    cards,
    citations,
    usage,
  };
}

function finalText(content: ClaudeContentBlock[]): string {
  return content
    .filter((b): b is ClaudeTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** De-duplicate cards (by sku) and citations (by document_id+page) for the client. */
export function dedupeCards(cards: ProductCard[]): ProductCard[] {
  const seen = new Set<string>();
  return cards.filter((c) => !seen.has(c.sku) && seen.add(c.sku));
}
export function dedupeCitations(cites: Citation[]): Citation[] {
  const seen = new Set<string>();
  return cites.filter((c) => {
    const k = `${c.document_id}|${c.page ?? ""}`;
    return !seen.has(k) && seen.add(k);
  });
}
