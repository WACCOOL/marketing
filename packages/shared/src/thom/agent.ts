import type { SupabaseClient } from "@supabase/supabase-js";
import type { ThomEnv, ThomSurface } from "./env.js";
import {
  claudeMessages,
  claudeMessagesStream,
  claudeModel,
  claudeRouterModel,
  type ClaudeContentBlock,
  type ClaudeMessage,
  type ClaudeResponse,
  type ClaudeServerTool,
  type ClaudeServerToolUseBlock,
  type ClaudeStreamEvent,
  type ClaudeTextBlock,
  type ClaudeTool,
  type ClaudeToolResultBlock,
  type ClaudeToolUseBlock,
  type ClaudeUsage,
} from "./transport.js";
import { loadProtectedTerms } from "./dictionary.js";
import { systemFor } from "./prompts.js";
import {
  makeHaikuJudge,
  normalizeCopy,
  screenCompetitors,
  type CompetitorJudge,
} from "./publicFilter.js";
import {
  dispatch,
  FILTER_TOOLS,
  SPEC_RANK_TOOLS,
  TOOLS,
  withConstraintRouting,
  type ThomToolExtension,
} from "./tools.js";
import { LAYOUT_TOOLS } from "./layoutTool.js";
import { PHOTOMETRICS_TOOLS } from "./photometricsTools.js";
import type { Card, Citation, ThomUsage } from "./types.js";

const MAX_STEPS = 5;
const MAX_TOKENS = 2048;
// Hard ceiling on pause_turn continuations per turn — bounds the server-tool
// loop without consuming the client-tool MAX_STEPS budget.
const MAX_PAUSE_CONTINUATIONS = 3;

// The web_search tool-type variant valid for the ROUTER (Haiku-class) model the
// loop starts on. The newer web_search_20260209 requires Sonnet-5/Opus tier, so
// it must NOT be the default here even though the loop can escalate.
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";

/** Photometrics tools are OFF unless THOM_PHOTOMETRICS is explicitly "1"
 *  (dark-launch, mirroring THOM_WEB_SEARCH). Enforced here — the tools aren't
 *  advertised to the model until the flag flips. */
export function photometricsEnabled(env: ThomEnv): boolean {
  return env.THOM_PHOTOMETRICS === "1";
}

/** Layout tool is OFF unless THOM_LAYOUT is explicitly "1" (dark-launch,
 *  mirroring THOM_PHOTOMETRICS). Enforced here — plan_layout isn't advertised
 *  to the model until the flag flips (INTERNAL surface only; see composeTools). */
export function layoutEnabled(env: ThomEnv): boolean {
  return env.THOM_LAYOUT === "1";
}

/** Spec-rank tool is OFF unless THOM_SPEC_RANK is explicitly "1" (dark-launch,
 *  mirroring THOM_PHOTOMETRICS). Enforced here — rank_products_by_spec isn't
 *  advertised (and the primer's superlative-tool bullet isn't composed) until
 *  the flag flips, on BOTH surfaces. */
export function specRankEnabled(env: ThomEnv): boolean {
  return env.THOM_SPEC_RANK === "1";
}

/** Spec-filter tool is OFF unless THOM_SPEC_FILTER is explicitly "1"
 *  (dark-launch, mirroring THOM_SPEC_RANK). Gates filter_products, the
 *  primer's constraint bullets, the search_products back-pointer, AND
 *  get_product's per-size dimension surface (they all read the 0063 views),
 *  on BOTH surfaces. */
export function specFilterEnabled(env: ThomEnv): boolean {
  return env.THOM_SPEC_FILTER === "1";
}

/** The base PUBLIC tool set: the retrieval tools + plan_layout, always. The
 *  public surface NEVER carries any injected (crm_*) tool — see composeTools. */
const PUBLIC_TOOLS: ClaudeTool[] = [...TOOLS, ...LAYOUT_TOOLS];

/**
 * Compose the client tool set for a turn.
 *
 * INTERNAL (unchanged from before the extraction): base retrieval tools, then
 * the injected extension tools (the read-only HubSpot CRM tools, when the
 * caller supplies them), then photometrics (THOM_PHOTOMETRICS=1) and layout
 * (THOM_LAYOUT=1) — SAME order as before so the cached request prefix is
 * byte-identical.
 *
 * PUBLIC: the public allowlist ONLY (retrieval + plan_layout, + photometrics
 * when THOM_PHOTOMETRICS=1). The `extraTools` argument is IGNORED on public, so
 * no injected (crm_*) tool can ever be advertised there.
 *
 * The cache breakpoint is re-homed to the composed tail by withTailCache.
 */
export function composeTools(
  surface: ThomSurface,
  env: ThomEnv,
  extraTools: ClaudeTool[] = [],
): ClaudeTool[] {
  if (surface === "public") {
    const list: ClaudeTool[] = [...PUBLIC_TOOLS];
    if (photometricsEnabled(env)) list.push(...PHOTOMETRICS_TOOLS);
    if (specRankEnabled(env)) list.push(...SPEC_RANK_TOOLS);
    if (specFilterEnabled(env)) list.push(...FILTER_TOOLS);
    // The search_products constraint back-pointer composes ONLY when the
    // filter tool is actually offered (plan O3 / the R3 rule).
    return withTailCache(specFilterEnabled(env) ? withConstraintRouting(list) : list);
  }
  const list: ClaudeTool[] = [...TOOLS];
  list.push(...extraTools);
  if (photometricsEnabled(env)) list.push(...PHOTOMETRICS_TOOLS);
  if (layoutEnabled(env)) list.push(...LAYOUT_TOOLS);
  if (specRankEnabled(env)) list.push(...SPEC_RANK_TOOLS);
  if (specFilterEnabled(env)) list.push(...FILTER_TOOLS);
  return withTailCache(specFilterEnabled(env) ? withConstraintRouting(list) : list);
}

/**
 * Put a single cache breakpoint on the LAST tool of the composed array without
 * mutating the shared TOOLS / injected-tool constants: strip cache_control from
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
  cards: Card[];
  citations: Citation[];
  usage: ThomUsage;
  /** Client tool calls the request made (name + input) — turn logging. */
  toolCalls: { name: string; input: unknown }[];
}

/** Options for one Thom turn. `surface` selects the system prompt, tool set,
 *  server tools, and search_docs scope (defaults to 'internal' so existing
 *  internal callers are unchanged). `extension` injects the internal-only tool
 *  set (e.g. HubSpot CRM); it is IGNORED on the public surface. */
export interface RunThomOptions {
  history: ClaudeMessage[];
  userMessage: string;
  surface?: ThomSurface;
  extension?: ThomToolExtension;
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
  /** The last N user turns of history joined with the current message —
   *  CONSTRAINT_INTENT is evaluated over this window (plan O6: "no wider than
   *  15 inches" in turn 1 followed by "what about in black?" in turn 3 is
   *  still a constraint conversation). Defaults to userMessage when absent. */
  recentUserText?: string;
}

// Genuine comparison / superlative intent. Deliberately TIGHT: a bare
// "... or ...?" matches almost any question ("downlights or track heads?") and
// would over-escalate, so it's intentionally excluded.
const COMPARISON_INTENT =
  /\b(vs\.?|versus|compared? to|comparison|difference between|which (is|one is) (better|best)|better than)\b/i;

// Superlative intent ("what's the brightest / highest lumen light") escalates
// IMMEDIATELY (toolCallCount >= 0): waiting for a tool call would still let the
// router model field the failing turn — the documented tape-as-runner-up
// failure. Superlatives are rare, so the extra strong-model turns are cheap.
export const SUPERLATIVE_INTENT =
  /\b(highest|brightest|most (powerful|efficient)|max(imum)?\s+(lumens?|output)|lowest (wattage|power)|best (output|efficacy))\b/i;

// --- CONSTRAINT_INTENT (attribute-filter plan §D — rebuilt per A2/O3/O6) ----
//
// Escalates at toolCallCount >= 0: multi-predicate composition is precisely
// the shape a router-tier model fumbles, and the failing turn is the first
// turn (the R6 lesson). Design rules, adjudicated in the plan:
//  * units match only DIGIT-ADJACENT — "under-cabinet lighting", "over the
//    island", "up to code", "over 100 products" cannot fire;
//  * widened comparators incl. narrower/shallower/no-bigger-than/within/
//    at most/at least and TRAILING forms ("15 in or less", "15 inches max");
//  * \bADA\b fires alone (an ADA mention IS a 4-inch depth constraint), as
//    does a bare IP rating ("IP65");
//  * fits-in forms ("fit in a 30cm cabinet") need a digit-adjacent unit
//    within reach;
//  * overlap with SUPERLATIVE_INTENT is ALLOWED — "the brightest one under
//    15 inches" legitimately matches both.
// The false-positive and miss corpora in agent.test.ts ARE the spec: tuning
// the regex = changing the corpora = a PR.
const CONSTRAINT_NUM = String.raw`\d[\d,.]*`;
const CONSTRAINT_UNIT_WORD = String.raw`(?:in(?:ch(?:es)?)?|mm|cm|ft|feet|foot|lm|lumens?|watts?|w|k|kelvin|cri)`;
const CONSTRAINT_NUM_UNIT = String.raw`${CONSTRAINT_NUM}\s?(?:["'′″’”]|${CONSTRAINT_UNIT_WORD}\b)`;
const CONSTRAINT_COMPARATOR = String.raw`(?:no\s+)?(?:more|less|fewer|bigger|smaller|narrower|wider|shorter|taller|longer|deeper|shallower|larger)\s+than|at\s+(?:most|least)|under|over|below|above|within|between|max(?:imum)?|min(?:imum)?|up\s+to`;
export const CONSTRAINT_INTENT = new RegExp(
  [
    // comparator + digit-adjacent unit (optional soft filler word).
    String.raw`(?:${CONSTRAINT_COMPARATOR})\s+(?:about\s+|around\s+|approximately\s+|roughly\s+)?${CONSTRAINT_NUM_UNIT}`,
    // trailing forms: "15 in or less", "15 inches max".
    String.raw`${CONSTRAINT_NUM_UNIT}\s*(?:or\s+(?:less|under|smaller|shorter|narrower|fewer|more|over|larger)|max(?:imum)?|min(?:imum)?)\b`,
    // a bare ADA mention IS a constraint (§307's 4-inch protrusion rule).
    String.raw`\bADA\b`,
    // a bare IP rating is a constraint ("IP65 rated", "ip 65").
    String.raw`\bIP\s?\d{2}\b`,
    // fits-in forms with a digit-adjacent unit in reach.
    String.raw`\bfits?\s+(?:in(?:to)?|within|under|over)\b[^.!?]{0,40}?${CONSTRAINT_NUM_UNIT}`,
  ].join("|"),
  "i",
);

/** How many trailing USER turns of history join the current message for the
 *  CONSTRAINT_INTENT window (plan O6). */
export const CONSTRAINT_HISTORY_TURNS = 4;

/** The text CONSTRAINT_INTENT scans: the last (CONSTRAINT_HISTORY_TURNS - 1)
 *  plain-text user turns of history plus the current message. Tool-result
 *  user turns (content arrays) are skipped — they are transcripts, not asks.
 *  Pure + exported for tests. */
export function recentUserText(
  history: ClaudeMessage[],
  userMessage: string,
  turns: number = CONSTRAINT_HISTORY_TURNS,
): string {
  const prior = history
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => m.content as string);
  return [...prior.slice(-(Math.max(turns, 1) - 1)), userMessage].join("\n");
}

/**
 * Whether this turn is "hard" enough to warrant the stronger model. Pure and
 * monotonic in the accumulated evidence: multi-doc synthesis (2+ passages),
 * multi-product work (2+ cards), a long tool chain (3+ calls), an explicit
 * comparison once we have at least one tool result to compare against, or a
 * superlative from the very first turn (see SUPERLATIVE_INTENT).
 */
export function shouldEscalate(s: EscalationState): boolean {
  if (s.docPassageCount >= 2) return true;
  if (s.productCount >= 2) return true;
  if (s.toolCallCount >= 3) return true;
  if (COMPARISON_INTENT.test(s.userMessage) && s.toolCallCount >= 1) return true;
  if (SUPERLATIVE_INTENT.test(s.userMessage)) return true;
  // Constraint conversations escalate immediately (toolCallCount >= 0), over
  // the recent-user-turns window (plan O6) so a follow-up like "what about in
  // black?" three turns after "no wider than 15 inches" stays escalated.
  if (CONSTRAINT_INTENT.test(s.recentUserText ?? s.userMessage)) return true;
  return false;
}

/** Model tiering is ON unless THOM_TIERING is explicitly "0" (safe rollback). */
export function tieringEnabled(env: ThomEnv): boolean {
  return env.THOM_TIERING !== "0";
}

// --- web_search gate (INTERNAL-ONLY, dark-launched) -------------------------

/** Web search is OFF unless THOM_WEB_SEARCH is explicitly "1" (per-search
 *  billing → dark-launch). Enforced here, not just in the prompt. */
export function webSearchEnabled(env: ThomEnv): boolean {
  return env.THOM_WEB_SEARCH === "1";
}

/** Per-turn cap on web_search calls (Anthropic max_uses): THOM_WEB_SEARCH_MAX_USES
 *  parsed as an int, default 3, clamped to 1–5. */
export function webSearchMaxUses(env: ThomEnv): number {
  const n = Number.parseInt(env.THOM_WEB_SEARCH_MAX_USES ?? "", 10);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

/** The server tools to offer this turn: [] when disabled, else a single capped
 *  web_search entry. Basic (Haiku-tier) variant — see WEB_SEARCH_TOOL_TYPE.
 *  INTERNAL gate: gated on THOM_WEB_SEARCH. See serverToolsFor for the public
 *  path (always on, smaller cap). */
export function buildWebSearchTools(env: ThomEnv): ClaudeServerTool[] {
  if (!webSearchEnabled(env)) return [];
  return [{ type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: webSearchMaxUses(env) }];
}

/** Per-turn web_search cap for the PUBLIC surface (Davis's decision: ON but
 *  small). THOM_PUBLIC_WEB_SEARCH_MAX_USES parsed as an int, default 2, clamped
 *  to 1–3. */
export function publicWebSearchMaxUses(env: ThomEnv): number {
  const n = Number.parseInt(env.THOM_PUBLIC_WEB_SEARCH_MAX_USES ?? "", 10);
  if (!Number.isFinite(n)) return 2;
  return Math.min(3, Math.max(1, n));
}

/**
 * Server tools for a surface. PUBLIC: web_search is ENABLED BY DEFAULT (not
 * gated on THOM_WEB_SEARCH), with a small cap (default 2, ≤3) — Davis's
 * decision. INTERNAL: unchanged — still gated on THOM_WEB_SEARCH (off by
 * default) via buildWebSearchTools. Same Haiku-tier web_search_20250305 type.
 */
export function serverToolsFor(surface: ThomSurface, env: ThomEnv): ClaudeServerTool[] {
  if (surface === "public") {
    return [{ type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: publicWebSearchMaxUses(env) }];
  }
  return buildWebSearchTools(env);
}

/** Does a reconstructed assistant turn's content include a web_search result
 *  block? Used PUBLIC-side to decide whether to run the competitor screen on
 *  that turn's text. */
export function turnUsedWebSearch(content: ClaudeContentBlock[]): boolean {
  return content.some((b) => b.type === "web_search_tool_result");
}

/**
 * Did this request's gathered citations include an admin-uploaded education
 * document? DOE/DLC/ENERGY STAR education material names manufacturers, and
 * public-scope education chunks would otherwise bypass the competitor screen
 * (which historically ran only on web_search turns) — plan R10. Citations
 * already carry doc_type, so this is cheap and precise.
 */
export function turnUsedEducationDocs(citations: Citation[]): boolean {
  return citations.some((c) => c.doc_type === "education");
}

/**
 * Collect the open-web sources from an assistant turn as `kind:"web"` Citations.
 * Prefers `web_search_result_location` entries on text blocks (the sources the
 * model actually CITED); falls back to enumerating the raw web_search_tool_result
 * array only when nothing was cited. The error shape (a single object with
 * error_code) is guarded — it's skipped, never enumerated. document_id=url so
 * dedupeCitations dedupes web results correctly.
 */
export function collectWebCitations(content: ClaudeContentBlock[]): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  const add = (url: string | undefined, title: string | null | undefined) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ kind: "web", document_id: url, title: title ?? null, doc_type: "web", page: null, url });
  };

  for (const b of content) {
    if (b.type === "text" && b.citations) {
      for (const c of b.citations) {
        if (c.type === "web_search_result_location") add(c.url, c.title);
      }
    }
  }
  if (out.length === 0) {
    for (const b of content) {
      // Success content is an ARRAY of results; the error shape is a single
      // OBJECT ({error_code}) — Array.isArray skips it (returns nothing).
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const r of b.content) add(r.url, r.title);
      }
    }
  }
  return out;
}

/** What the loop should do with a response: resume a paused server-tool turn,
 *  dispatch client tools, or treat it as the final answer. Pure for testing. */
export function loopAction(res: Pick<ClaudeResponse, "stop_reason" | "content">): "final" | "dispatch" | "pause" {
  if (res.stop_reason === "pause_turn") return "pause";
  const hasToolUse = res.content.some((b) => b.type === "tool_use");
  return res.stop_reason === "tool_use" && hasToolUse ? "dispatch" : "final";
}

/**
 * Run one internal Thom turn: a bounded tool-use loop over the retrieval tools.
 * Non-streaming (v1) — returns the final answer plus the product cards and
 * source citations gathered from tool calls. `history` is prior user/assistant
 * turns for context.
 */
export async function runThom(
  env: ThomEnv,
  sb: SupabaseClient,
  opts: RunThomOptions,
): Promise<ThomResult> {
  const surface: ThomSurface = opts.surface ?? "internal";
  const extension = opts.extension;
  // The primer's superlative-tool bullet composes only when the rank tool is
  // actually offered (THOM_SPEC_RANK), and the constraint bullets only when
  // the filter tool is (THOM_SPEC_FILTER) — commanding an unadvertised tool
  // would re-create the original superlative failure.
  const system = systemFor(surface, specRankEnabled(env), specFilterEnabled(env));
  // CONSTRAINT_INTENT scans the last N user turns + the current message
  // (plan O6): constraints stated earlier stay binding.
  const constraintWindow = recentUserText(opts.history, opts.userMessage);
  // Compose the tool set for this surface. Internal appends the injected
  // extension tools (CRM) in the SAME position as before; public gets the
  // allowlist only. The cache breakpoint is re-homed to the composed tail.
  const tools = composeTools(surface, env, extension?.tools ?? []);
  // web_search: PUBLIC = on-by-default + capped; INTERNAL = gated on
  // THOM_WEB_SEARCH (unchanged). Rendered AFTER the client tools so the
  // withTailCache breakpoint is unaffected.
  const serverTools = serverToolsFor(surface, env);
  // PUBLIC output guardrails: normalizeCopy every final text; screen web_search
  // turns for competitor content. The judge is built once (undefined when
  // ANTHROPIC unavailable → denylist-only). Internal: no filter at all.
  const isPublic = surface === "public";
  const judge: CompetitorJudge | undefined = isPublic ? makeHaikuJudge(env) : undefined;
  // Dictionary terms the copy normalizer must protect (marketing-app editable;
  // cached in-isolate; [] on any failure — defaults still apply).
  const dictTerms = isPublic ? await loadProtectedTerms(sb) : [];
  const messages: ClaudeMessage[] = [
    ...opts.history,
    { role: "user", content: opts.userMessage },
  ];
  const cards: Card[] = [];
  const citations: Citation[] = [];
  const allToolCalls: { name: string; input: unknown }[] = [];
  let toolCallCount = 0;
  const usage: ThomUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    model: claudeRouterModel(env),
    escalated: false,
  };

  // A pure pause_turn continuation does NOT consume the client-tool MAX_STEPS
  // budget; it's bounded separately by MAX_PAUSE_CONTINUATIONS so the loop
  // always terminates.
  let step = 0;
  let pauseCount = 0;
  while (step < MAX_STEPS) {
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
        recentUserText: constraintWindow,
      });
    const model = escalate ? claudeModel(env) : claudeRouterModel(env);
    usage.model = model; // last write wins → reflects the answering turn
    if (escalate) usage.escalated = true;

    const res = await claudeMessages(env, {
      system,
      messages,
      tools,
      serverTools,
      model,
      maxTokens: MAX_TOKENS,
    });
    usage.input_tokens += res.usage.input_tokens;
    usage.output_tokens += res.usage.output_tokens;
    usage.cache_read_input_tokens += res.usage.cache_read_input_tokens;

    // Echo the assistant turn back for the next iteration.
    messages.push({ role: "assistant", content: res.content });

    // Gather any open-web sources the server cited/returned this turn (deduped
    // at the end by document_id=url).
    citations.push(...collectWebCitations(res.content));

    const action = loopAction(res);

    // pause_turn: the server tool loop paused mid-turn. Resume by re-sending the
    // messages with the assistant content already appended — do NOT add a
    // "Continue" user turn. Bounded, and doesn't spend a client-tool step.
    if (action === "pause") {
      if (++pauseCount > MAX_PAUSE_CONTINUATIONS) break;
      continue;
    }

    if (action === "final") {
      console.log(
        `[thom] answered model=${usage.model} escalated=${usage.escalated} ` +
          `toolCalls=${toolCallCount} docPassages=${citations.length} products=${cards.length}`,
      );
      // PUBLIC: normalize copy, and (if this turn used web_search OR cited an
      // education document — plan R10) run the competitor screen, replacing the
      // answer with the guardrail template when flagged. INTERNAL: raw final
      // text, unchanged.
      const text = isPublic
        ? turnUsedWebSearch(res.content) || turnUsedEducationDocs(citations)
          ? await screenCompetitors(normalizeCopy(finalText(res.content), dictTerms), { judge })
          : normalizeCopy(finalText(res.content), dictTerms)
        : finalText(res.content);
      return { text, cards, citations, usage, toolCalls: allToolCalls };
    }

    // action === "dispatch": client tools only (server web_search never reaches
    // dispatch — it has no client tool_use block).
    const toolUses = res.content.filter(
      (b): b is ClaudeToolUseBlock => b.type === "tool_use",
    );
    for (const tu of toolUses) allToolCalls.push({ name: tu.name, input: tu.input });
    toolCallCount += toolUses.length;
    const results: ClaudeToolResultBlock[] = [];
    for (const tu of toolUses) {
      try {
        const out = await dispatch({ env, sb }, tu.name, tu.input, { surface, extension });
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
    step++;
  }

  console.log(
    `[thom] answered model=${usage.model} escalated=${usage.escalated} ` +
      `toolCalls=${toolCallCount} docPassages=${citations.length} products=${cards.length} (max-steps)`,
  );
  // Authored copy carries an em dash; normalize it on the public surface so it
  // obeys the copy rules. INTERNAL keeps the byte-identical original.
  const maxStepsText = "I couldn't finish that in a reasonable number of steps — try narrowing the question.";
  return {
    text: isPublic ? normalizeCopy(maxStepsText, dictTerms) : maxStepsText,
    cards,
    citations,
    usage,
    toolCalls: allToolCalls,
  };
}

function finalText(content: ClaudeContentBlock[]): string {
  return content
    .filter((b): b is ClaudeTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** De-duplicate cards and citations (by document_id+page) for the client.
 *  Cards are keyed by kind so a product, a family, and a photometrics card never
 *  collide: products by `product:${sku}`, families by `family:${family}`,
 *  photometrics by `photometrics:${sku}`. */
export function dedupeCards(cards: Card[]): Card[] {
  const seen = new Set<string>();
  return cards.filter((c) => {
    const k =
      c.kind === "family"
        ? `family:${c.family}`
        : c.kind === "photometrics"
          ? `photometrics:${c.sku}`
          : c.kind === "layout"
            ? `layout:${c.product.sku ?? c.product.family ?? "?"}:${c.space.lengthFt}x${c.space.widthFt}:${c.layoutKind}`
            : `product:${c.sku}`;
    return !seen.has(k) && seen.add(k);
  });
}
export function dedupeCitations(cites: Citation[]): Citation[] {
  const seen = new Set<string>();
  return cites.filter((c) => {
    const k = `${c.document_id}|${c.page ?? ""}`;
    return !seen.has(k) && seen.add(k);
  });
}

// ---------------------------------------------------------------------------
// Streaming (SSE) — token-by-token final answer.
// ---------------------------------------------------------------------------

/** Events yielded by runThomStream to the route (which frames them as SSE).
 *  `text` streams the final answer token-by-token; `cards`/`citations` land
 *  right before `final`, which carries the whole answer + usage for logging. */
export type ThomStreamEvent =
  | { type: "text"; text: string }
  | { type: "cards"; cards: Card[] }
  | { type: "citations"; citations: Citation[] }
  | {
      type: "final";
      text: string;
      usage: ThomUsage;
      /** Client tool calls this REQUEST made (name + input), for turn logging
       *  and the search-analytics rollup. */
      toolCalls: { name: string; input: unknown }[];
    };

/**
 * Rebuild one assistant turn from its streamed events. PURE and testable: the
 * production loop forwards `text` events live for token streaming AND feeds the
 * same events here to reconstruct the assistant `content` array — so history,
 * pause resume, and subsequent turns match the non-streaming path exactly.
 *
 * Blocks arrive strictly in order (block N fully, then block N+1), so a running
 * text buffer is flushed into a text block whenever a non-text block opens or a
 * text block stops. tool_use / server_tool_use inputs are the accumulated
 * input_json_delta parsed at block_stop (JSON.parse, default `{}`).
 * web_search_tool_result blocks arrive whole and are pushed verbatim.
 */
export function reconstructTurn(events: ClaudeStreamEvent[]): {
  content: ClaudeContentBlock[];
  text: string;
  stopReason: string;
  usage: ClaudeUsage | null;
} {
  const content: ClaudeContentBlock[] = [];
  // Partially-built tool blocks, keyed by their stream index.
  const tools = new Map<
    number,
    { kind: "tool_use" | "server_tool_use"; id: string; name: string; json: string }
  >();
  let pendingText = "";
  let text = "";
  let stopReason = "end_turn";
  let usage: ClaudeUsage | null = null;

  const flushText = () => {
    if (pendingText) {
      content.push({ type: "text", text: pendingText });
      pendingText = "";
    }
  };

  for (const ev of events) {
    switch (ev.type) {
      case "text":
        pendingText += ev.text;
        text += ev.text;
        break;
      case "tool_use_start":
        flushText();
        tools.set(ev.index, { kind: "tool_use", id: ev.id, name: ev.name, json: "" });
        break;
      case "server_tool_use_start":
        flushText();
        tools.set(ev.index, { kind: "server_tool_use", id: ev.id, name: ev.name, json: "" });
        break;
      case "tool_input_delta": {
        const t = tools.get(ev.index);
        if (t) t.json += ev.partial_json;
        break;
      }
      case "web_search_result":
        flushText();
        content.push(ev.content);
        break;
      case "block_stop": {
        const t = tools.get(ev.index);
        if (t) {
          content.push(
            t.kind === "server_tool_use"
              ? ({ type: "server_tool_use", id: t.id, name: t.name, input: safeJson(t.json) } as ClaudeServerToolUseBlock)
              : ({ type: "tool_use", id: t.id, name: t.name, input: safeJson(t.json) } as ClaudeToolUseBlock),
          );
          tools.delete(ev.index);
        } else {
          flushText(); // a text block ended
        }
        break;
      }
      case "done":
        stopReason = ev.stopReason;
        usage = ev.usage;
        break;
    }
  }
  flushText(); // any trailing text with no explicit block_stop before "done"
  return { content, text, stopReason, usage };
}

/** Parse accumulated input_json_delta; default to `{}` on empty/malformed. */
function safeJson(json: string): Record<string, unknown> {
  try {
    return json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Streaming twin of runThom: same bounded tool-use loop, same per-turn model
 * tiering, same serverTools, same MAX_STEPS / MAX_PAUSE_CONTINUATIONS, same
 * client-tool dispatch, same web-citation collection — but streams the final
 * answer token-by-token. Forwards `text` events live AND reconstructs each
 * assistant turn so history matches the non-streaming path exactly.
 *
 * PUBLIC guardrail (surface==='public' ONLY — internal is byte-for-byte the same
 * path as before): raw tokens are NOT streamed live. Each turn's text is
 * buffered, normalizeCopy'd, and — when that turn used web_search — run through
 * the competitor screen (which may REPLACE the whole answer with the guardrail
 * template) BEFORE it is emitted as a single `text` event. This is the
 * documented buffer-then-emit approach: we can't normalize/screen text that has
 * already been streamed token-by-token, so the public surface trades live
 * token streaming for a per-turn buffered emit. Internal keeps live streaming.
 */
export async function* runThomStream(
  env: ThomEnv,
  sb: SupabaseClient,
  opts: RunThomOptions,
): AsyncGenerator<ThomStreamEvent> {
  const surface: ThomSurface = opts.surface ?? "internal";
  const extension = opts.extension;
  // Same flag threading as runThom (primer bullets track the offered tools).
  const system = systemFor(surface, specRankEnabled(env), specFilterEnabled(env));
  // Same O6 constraint window as runThom.
  const constraintWindow = recentUserText(opts.history, opts.userMessage);
  const tools = composeTools(surface, env, extension?.tools ?? []);
  // web_search: PUBLIC = on-by-default + capped; INTERNAL = gated (unchanged).
  const serverTools = serverToolsFor(surface, env);
  // PUBLIC output guardrails (see the doc comment above). Internal: no filter.
  const isPublic = surface === "public";
  const judge: CompetitorJudge | undefined = isPublic ? makeHaikuJudge(env) : undefined;
  // Dictionary terms (marketing-app editable) the normalizer must protect.
  const dictTerms = isPublic ? await loadProtectedTerms(sb) : [];
  const allToolCalls: { name: string; input: unknown }[] = [];
  const messages: ClaudeMessage[] = [
    ...opts.history,
    { role: "user", content: opts.userMessage },
  ];
  const cards: Card[] = [];
  const citations: Citation[] = [];
  // Sanitize one turn's reconstructed text for the public surface: normalize
  // copy always; screen for competitors when the turn used web_search OR when
  // the request's citations so far include an education document (plan R10 —
  // DOE/DLC/ENERGY STAR education material names manufacturers).
  const sanitizePublic = (turn: { content: ClaudeContentBlock[]; text: string }): Promise<string> => {
    const normalized = normalizeCopy(turn.text, dictTerms);
    return turnUsedWebSearch(turn.content) || turnUsedEducationDocs(citations)
      ? screenCompetitors(normalized, { judge })
      : Promise.resolve(normalized);
  };
  let toolCallCount = 0;
  const usage: ThomUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    model: claudeRouterModel(env),
    escalated: false,
  };

  let step = 0;
  let pauseCount = 0;
  while (step < MAX_STEPS) {
    const escalate =
      tieringEnabled(env) &&
      shouldEscalate({
        toolCallCount,
        docPassageCount: citations.length,
        productCount: cards.length,
        userMessage: opts.userMessage,
        recentUserText: constraintWindow,
      });
    const model = escalate ? claudeModel(env) : claudeRouterModel(env);
    usage.model = model; // last write wins → reflects the answering turn
    if (escalate) usage.escalated = true;

    // Stream this turn: INTERNAL forwards text live for token streaming; PUBLIC
    // buffers (no live yield) so the whole turn can be normalized/screened
    // before emit. Either way we collect the raw events so reconstructTurn can
    // rebuild the assistant content array.
    const events: ClaudeStreamEvent[] = [];
    for await (const ev of claudeMessagesStream(env, {
      system,
      messages,
      tools,
      serverTools,
      model,
      maxTokens: MAX_TOKENS,
    })) {
      events.push(ev);
      if (ev.type === "text" && !isPublic) yield { type: "text", text: ev.text };
    }

    const turn = reconstructTurn(events);
    if (turn.usage) {
      usage.input_tokens += turn.usage.input_tokens;
      usage.output_tokens += turn.usage.output_tokens;
      usage.cache_read_input_tokens += turn.usage.cache_read_input_tokens;
    }

    // Echo the assistant turn back so history + pause resume + subsequent turns
    // match the non-streaming path.
    messages.push({ role: "assistant", content: turn.content });
    citations.push(...collectWebCitations(turn.content));

    // PUBLIC: sanitize this turn's text once (normalize + competitor screen).
    // Emitted as a single buffered `text` event below (interim turns) or carried
    // into the `final` event. INTERNAL leaves publicText undefined.
    const publicText = isPublic ? await sanitizePublic(turn) : undefined;

    const action = loopAction({ stop_reason: turn.stopReason, content: turn.content });

    if (action === "pause") {
      // A paused server-tool turn rarely carries text, but emit it if present.
      if (isPublic && publicText) yield { type: "text", text: publicText };
      if (++pauseCount > MAX_PAUSE_CONTINUATIONS) break;
      continue;
    }

    if (action === "final") {
      console.log(
        `[thom] streamed model=${usage.model} escalated=${usage.escalated} ` +
          `toolCalls=${toolCallCount} docPassages=${citations.length} products=${cards.length}`,
      );
      const deduped = dedupeCards(cards);
      const dedupedCites = dedupeCitations(citations);
      if (deduped.length) yield { type: "cards", cards: deduped };
      if (dedupedCites.length) yield { type: "citations", citations: dedupedCites };
      // PUBLIC: emit the buffered, sanitized answer as one `text` event (raw
      // tokens were never streamed) plus the matching `final`. INTERNAL: text
      // already streamed live; `final` carries the raw final text for logging.
      if (isPublic) {
        const text = publicText ?? "";
        if (text) yield { type: "text", text };
        yield { type: "final", text, usage, toolCalls: allToolCalls };
      } else {
        yield { type: "final", text: finalText(turn.content), usage, toolCalls: allToolCalls };
      }
      return;
    }

    // action === "dispatch": PUBLIC emits any interim (pre-tool) narration text
    // for this turn, buffered + sanitized, before the client tools run.
    if (isPublic && publicText) yield { type: "text", text: publicText };

    // action === "dispatch": client tools only (server web_search never reaches
    // dispatch — it has no client tool_use block).
    const toolUses = turn.content.filter(
      (b): b is ClaudeToolUseBlock => b.type === "tool_use",
    );
    for (const tu of toolUses) allToolCalls.push({ name: tu.name, input: tu.input });
    toolCallCount += toolUses.length;
    const results: ClaudeToolResultBlock[] = [];
    for (const tu of toolUses) {
      try {
        const out = await dispatch({ env, sb }, tu.name, tu.input, { surface, extension });
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
    step++;
  }

  console.log(
    `[thom] streamed model=${usage.model} escalated=${usage.escalated} ` +
      `toolCalls=${toolCallCount} docPassages=${citations.length} products=${cards.length} (max-steps)`,
  );
  const deduped = dedupeCards(cards);
  const dedupedCites = dedupeCitations(citations);
  if (deduped.length) yield { type: "cards", cards: deduped };
  if (dedupedCites.length) yield { type: "citations", citations: dedupedCites };
  // Authored copy carries an em dash; normalize it on the public surface.
  const maxStepsText = "I couldn't finish that in a reasonable number of steps — try narrowing the question.";
  yield {
    type: "final",
    text: isPublic ? normalizeCopy(maxStepsText, dictTerms) : maxStepsText,
    usage,
    toolCalls: allToolCalls,
  };
}
