// =============================================================================
// INTERNAL Thom agent wrapper.
//
// The surface-agnostic Thom brain (loop, retrieval tools, Claude transport)
// lives in @wac/shared/thom. This wrapper is the INTERNAL entry point the API
// route uses: it drives the shared brain with surface:'internal' and injects
// the read-only HubSpot CRM tool set (crm_*) — which stays in apps/api because
// it reads live internal CRM data and must never reach any public surface.
//
// dedupeCards/dedupeCitations are re-exported straight from the shared brain.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { ClaudeMessage } from "../anthropic.js";
import {
  runThom as sharedRunThom,
  runThomStream as sharedRunThomStream,
  type ThomResult,
  type ThomStreamEvent,
  type ThomToolExtension,
} from "@wac/shared/thom";
import { HUBSPOT_TOOLS, hubspotDispatch } from "./hubspotTools.js";

export { dedupeCards, dedupeCitations } from "@wac/shared/thom";
export type { ThomResult, ThomStreamEvent } from "@wac/shared/thom";

/** The internal CRM tools are only offered when a read token is configured. */
function crmEnabled(env: Env): boolean {
  return !!env.HUBSPOT_READ_TOKEN;
}

/**
 * The internal-only HubSpot CRM tool extension (schemas + dispatch), or
 * undefined when no read token is set — mirroring the old crmEnabled gate. The
 * shared brain advertises `tools` (after the base retrieval tools, exactly as
 * before) and routes crm_* names to `dispatch`; it has zero knowledge of
 * HubSpot itself.
 */
function hubspotExtension(env: Env): ThomToolExtension | undefined {
  if (!crmEnabled(env)) return undefined;
  return {
    tools: HUBSPOT_TOOLS,
    owns: (name) => name.startsWith("crm_"),
    dispatch: (ctx, name, input) => hubspotDispatch(ctx, name, input),
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
    extension: hubspotExtension(env),
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
    extension: hubspotExtension(env),
  });
}
