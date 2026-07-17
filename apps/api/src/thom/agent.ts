import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import {
  claudeMessages,
  claudeRouterModel,
  type ClaudeContentBlock,
  type ClaudeMessage,
  type ClaudeTextBlock,
  type ClaudeToolResultBlock,
  type ClaudeToolUseBlock,
} from "../anthropic.js";
import { internalSystem } from "./prompts.js";
import { dispatch, TOOLS } from "./tools.js";
import type { Citation, ProductCard, ThomUsage } from "./types.js";

const MAX_STEPS = 5;
const MAX_TOKENS = 2048;

export interface ThomResult {
  text: string;
  cards: ProductCard[];
  citations: Citation[];
  usage: ThomUsage;
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
  const model = claudeRouterModel(env);
  const system = internalSystem();
  const messages: ClaudeMessage[] = [
    ...opts.history,
    { role: "user", content: opts.userMessage },
  ];
  const cards: ProductCard[] = [];
  const citations: Citation[] = [];
  const usage: ThomUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, model };

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await claudeMessages(env, {
      system,
      messages,
      tools: TOOLS,
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
      return { text: finalText(res.content), cards, citations, usage };
    }

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
