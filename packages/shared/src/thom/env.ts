// =============================================================================
// The surface-agnostic Thom brain (agent loop, retrieval tools, Claude transport)
// lives here in @wac/shared/thom so BOTH the internal API Worker and a future
// public Worker can drive it. It reads only the narrow ThomEnv below — never
// apps/api's fat `Env`. apps/api's `Env` structurally satisfies ThomEnv, so the
// internal caller passes `c.env` straight through.
// =============================================================================

/**
 * The minimal Worker environment the Thom brain reads. Deliberately narrow:
 * the shared brain must not depend on apps/api's `Env`. apps/api's `Env`
 * (and any future public Worker env) structurally satisfies this.
 */
export interface ThomEnv {
  /**
   * Workers AI binding (bge-m3 embeddings). Typed `unknown` here because
   * @wac/shared carries only Node types (no @cloudflare/workers-types); embed.ts
   * narrows it structurally at the call site. apps/api's `AI: Ai` binding
   * satisfies `unknown` trivially, so no cast is needed at the call site.
   */
  AI: unknown;
  ANTHROPIC_API_KEY?: string;
  // Model overrides (defaults live in transport.ts): router/default model
  // handles routing + simple lookups, the escalation model handles synthesis.
  ANTHROPIC_ROUTER_MODEL?: string;
  ANTHROPIC_MODEL?: string;
  // Model-tiering kill-switch ("0" = router-only).
  THOM_TIERING?: string;
  // Native web_search gate ("1" = enabled) + per-turn cap. INTERNAL surface only.
  THOM_WEB_SEARCH?: string;
  THOM_WEB_SEARCH_MAX_USES?: string;
  // PUBLIC surface: web_search is ON by default (not gated). Optional per-turn
  // cap override (default 2, clamped 1..3).
  THOM_PUBLIC_WEB_SEARCH_MAX_USES?: string;
  // Photometrics / layout tool gates ("1" = offered to the model).
  THOM_PHOTOMETRICS?: string;
  THOM_LAYOUT?: string;
  // Authority-weighted retrieval ("1" = search_docs passes a non-zero
  // authority_weight to kb_search for company/ambiguous-shaped queries;
  // product/SKU-shaped queries ALWAYS pass 0). Off by default — with it off,
  // kb_search's weight defaults to 0 and ordering is identical to pre-0054.
  THOM_AUTHORITY?: string;
}

/** Which surface the brain is answering on. `internal` = the authenticated
 *  team tool (CRM tools, web search, internal support-ticket knowledge);
 *  `public` = the embeddable public bot (retrieval + layout only, never CRM). */
export type ThomSurface = "internal" | "public";
