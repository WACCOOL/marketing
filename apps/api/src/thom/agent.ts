// =============================================================================
// INTERNAL Thom agent wrapper.
//
// The surface-agnostic Thom brain (loop, retrieval tools, Claude transport)
// lives in @wac/shared/thom. This wrapper is the INTERNAL entry point the API
// route uses: it drives the shared brain with surface:'internal' and injects
// the internal-only crm_* tool set — the read-only HubSpot CRM tools plus the
// category-sales rollups (THOM_CATEGORY_SALES) — which stays in apps/api
// because it reads live internal business data and must never reach any
// public surface.
//
// dedupeCards/dedupeCitations are re-exported straight from the shared brain.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { ClaudeMessage } from "../anthropic.js";
import {
  categorySalesEnabled,
  runThom as sharedRunThom,
  runThomStream as sharedRunThomStream,
  type ThomResult,
  type ThomStreamEvent,
  type ThomToolExtension,
} from "@wac/shared/thom";
import type { ClaudeTool } from "../anthropic.js";
import { HUBSPOT_TOOLS, hubspotDispatch } from "./hubspotTools.js";
import { SALES_TOOL_NAME, SALES_TOOLS, salesDispatch, withSalesRoutingSeam } from "./salesTools.js";

export { dedupeCards, dedupeCitations } from "@wac/shared/thom";
export type { ThomResult, ThomStreamEvent } from "@wac/shared/thom";

/** The internal CRM tools are only offered when a read token is configured. */
function crmEnabled(env: Env): boolean {
  return !!env.HUBSPOT_READ_TOKEN;
}

/**
 * The ONE internal-only crm_* tool extension (schemas + dispatch): the
 * read-only HubSpot CRM tools (when HUBSPOT_READ_TOKEN is configured) plus the
 * category-sales rollup tool (when THOM_CATEGORY_SALES=1 — category-sales plan
 * §B). Undefined when neither is available. The crm_ prefix is what buys the
 * guarantees: prompts advertise it only in internalSystem() (flag-gated, CS6),
 * and the shared brain's public allowlist hard-rejects the whole prefix —
 * nothing about these tools exists on apps/thom-bot at all.
 *
 * Exported for tests (composition + dispatch routing).
 */
export function internalToolExtension(env: Env): ThomToolExtension | undefined {
  const crm = crmEnabled(env);
  const sales = categorySalesEnabled(env);
  if (!crm && !sales) return undefined;
  const tools: ClaudeTool[] = [];
  // The crm_top_companies routing-seam sentence composes ONLY when the sales
  // tool is actually offered (a static seam would command an unadvertised
  // tool — the CS6 failure shape).
  if (crm) tools.push(...(sales ? withSalesRoutingSeam(HUBSPOT_TOOLS) : HUBSPOT_TOOLS));
  if (sales) tools.push(...SALES_TOOLS);
  return {
    tools,
    owns: (name) => name.startsWith("crm_"),
    dispatch: (ctx, name, input) =>
      name === SALES_TOOL_NAME ? salesDispatch(ctx, name, input) : hubspotDispatch(ctx, name, input),
  };
}

/** Run one INTERNAL Thom turn (non-streaming). Behaves exactly as before the
 *  brain was extracted: internal system prompt, base tools + CRM (when
 *  configured) + photometrics/layout (when flagged), and web_search (when
 *  flagged). */
export function runThom(
  env: Env,
  sb: SupabaseClient,
  opts: { history: ClaudeMessage[]; userMessage: string },
): Promise<ThomResult> {
  return sharedRunThom(env, sb, {
    ...opts,
    surface: "internal",
    extension: internalToolExtension(env),
  });
}

/** Streaming twin of runThom (INTERNAL surface). */
export function runThomStream(
  env: Env,
  sb: SupabaseClient,
  opts: { history: ClaudeMessage[]; userMessage: string },
): AsyncGenerator<ThomStreamEvent> {
  return sharedRunThomStream(env, sb, {
    ...opts,
    surface: "internal",
    extension: internalToolExtension(env),
  });
}
