// =============================================================================
// PUBLIC-surface output guardrails for the Thom brain.
//
// Two responsibilities, both PUBLIC-ONLY (never touch the internal surface):
//
//  (a) Copy normalizer — normalizeCopy() runs on EVERY public assistant final
//      text: strips em dashes and upgrades a standalone bare "WAC" token to
//      "WAC Group" without corrupting the real brand names (WAC Lighting,
//      WAC Landscape, etc.).
//
//  (b) Competitor filter — screenCompetitors() runs ONLY on turns that used
//      web_search. A small, high-precision competitor-BRAND denylist (plus an
//      optional Haiku LLM judge) decides whether the reply named or confirmed a
//      non-WAC-Group product; if so the whole answer is REPLACED with the
//      guardrail template. A prompt asking the model not to name competitors is
//      not a guarantee — this is the enforcement.
//
// The pure pieces (normalizeCopy, screenCompetitorsSync, parseFlagged) have no
// network dependency and are unit-tested directly. The LLM judge is an async
// wrapper that degrades to denylist-only when ANTHROPIC is unavailable.
// =============================================================================

import type { ThomEnv } from "./env.js";
import { claudeMessages, claudeRouterModel } from "./transport.js";

/**
 * The verbatim guardrail reply. Used both as the competitor-filter replacement
 * AND baked (identically) into the public system prompt, so the model's own
 * answer and the enforced fallback read the same. Copy-rule compliant: no em
 * dash, "WAC Group" (never bare "WAC").
 */
export const GUARDRAIL_TEMPLATE =
  "A [WAC Group product] could meet your requirements. If you share the exact specifications you're looking for, I can help refine the search.";

// --- (a) copy normalizer ----------------------------------------------------

// Any em dash (U+2014) with optional surrounding whitespace becomes ", ".
const EM_DASH = /\s*—\s*/g;

// A STANDALONE bare "WAC" token — i.e. NOT already the start of a real brand
// name (WAC Group / WAC Lighting / WAC Landscape / WAC Modern Forms / ...). The
// negative lookahead lists the words that legitimately follow "WAC" in a brand
// name, so those are left untouched and everything else ("WAC", "WAC's",
// "WAC 3011", "WAC smart fans") is upgraded to "WAC Group".
// Negative lookaheads: real brand/product names keep their exact form —
// "WAC Architectural" is a PRIMARY BRAND, never "WAC Group Architectural";
// hyphenated product names (WAC-Mesh) are names too, not bare tokens.
export const BARE_WAC = /\bWAC\b(?!\s+(?:Group|Lighting|Landscape|Architectural|Home|Modern|Forms))(?!-)/g;

/**
 * Apply the public copy rules to a block of text. Pure + idempotent:
 * - em dashes are replaced with ", ";
 * - a standalone bare "WAC" is upgraded to "WAC Group" (real brand names such
 *   as "WAC Lighting" are preserved via the negative lookahead).
 */
export function normalizeCopy(text: string): string {
  if (!text) return text;
  return text.replace(EM_DASH, ", ").replace(BARE_WAC, "WAC Group");
}

// --- (b) competitor filter --------------------------------------------------

/**
 * Curated, HIGH-PRECISION denylist of well-known lighting COMPETITOR brands.
 * WAC Group brands (WAC Lighting, Modern Forms, Schonbek, AiSpire, WAC
 * Landscape) are deliberately EXCLUDED. Kept intentionally small + centralized;
 * extend it here as new competitor names surface. Matched case-insensitively on
 * word boundaries. Because this only runs on web_search turns and errs toward
 * suppression (the safe direction for a competitor guardrail), a rare false
 * positive just yields the guardrail template.
 */
const COMPETITOR_DENYLIST =
  /\b(?:lutron|signify|philips|cree|cooper|halo|juno|kichler|hinkley|lithonia|acuity|eaton|rab|progress lighting|visual comfort|tech lighting)\b/i;

/**
 * Denylist-only competitor screen — PURE, no network. Returns whether the text
 * tripped the denylist and the text to emit (the guardrail template when
 * flagged, otherwise the input unchanged).
 */
export function screenCompetitorsSync(text: string): { flagged: boolean; text: string } {
  if (COMPETITOR_DENYLIST.test(text)) return { flagged: true, text: GUARDRAIL_TEMPLATE };
  return { flagged: false, text };
}

/** An optional LLM judge: returns true when the reply names/confirms a
 *  non-WAC-Group product. */
export type CompetitorJudge = (text: string) => Promise<boolean>;

/**
 * Screen a (web_search-turn) reply for competitor content: denylist first (free,
 * synchronous), then the optional LLM judge only if the denylist passed. Returns
 * the guardrail template when either flags, otherwise the input unchanged. The
 * judge is wrapped in try/catch so any failure falls back to denylist-only.
 */
export async function screenCompetitors(
  text: string,
  opts: { judge?: CompetitorJudge } = {},
): Promise<string> {
  const sync = screenCompetitorsSync(text);
  if (sync.flagged) return sync.text;
  if (opts.judge) {
    try {
      if (await opts.judge(text)) return GUARDRAIL_TEMPLATE;
    } catch {
      // Judge unavailable/failed → denylist-only (already passed) → keep text.
    }
  }
  return text;
}

const JUDGE_SYSTEM =
  "You are a strict compliance filter for a WAC Group lighting assistant. " +
  "WAC Group brands are: WAC Lighting, Modern Forms, Schonbek, AiSpire, WAC Landscape. " +
  "Does the assistant reply name, or confirm or quote the specs of, any product or brand " +
  "that is NOT a WAC Group brand? " +
  'Reply with ONLY a JSON object: {"flagged": true} if it does, {"flagged": false} if it does not.';

/** Parse a judge reply into a boolean. Tolerant: finds the first JSON object in
 *  the text and reads its `flagged` field; anything unparseable is `false`
 *  (fail-open to denylist-only). Exported for unit testing. */
export function parseFlagged(s: string): boolean {
  const m = s.match(/\{[^}]*\}/);
  if (!m) return false;
  try {
    return (JSON.parse(m[0]) as { flagged?: unknown }).flagged === true;
  } catch {
    return false;
  }
}

/**
 * Build the Haiku-tier LLM judge from the environment, or undefined when
 * ANTHROPIC is not configured (→ screenCompetitors runs denylist-only). Only
 * ever called on web_search turns, so its cost is bounded.
 */
export function makeHaikuJudge(env: ThomEnv): CompetitorJudge | undefined {
  if (!env.ANTHROPIC_API_KEY) return undefined;
  return async (text: string): Promise<boolean> => {
    const res = await claudeMessages(env, {
      system: [{ type: "text", text: JUDGE_SYSTEM }],
      messages: [{ role: "user", content: `Assistant reply to screen:\n\n${text}` }],
      model: claudeRouterModel(env),
      maxTokens: 16,
    });
    const out = res.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    return parseFlagged(out);
  };
}
