// =============================================================================
// @wac/shared/thom — the surface-agnostic Thom Bot brain.
//
// Exposed via the "./thom" subpath export so importing it does NOT pull the
// agent/transport code into the top-level @wac/shared barrel (which apps/web
// bundles). The INTERNAL API Worker drives it with surface:'internal' + an
// injected HubSpot CRM tool extension; a future PUBLIC Worker drives it with
// surface:'public' (retrieval + layout only, never CRM).
// =============================================================================

export * from "./env.js";
export * from "./transport.js";
export * from "./types.js";
export * from "./embed.js";
export * from "./prompts.js";
export * from "./publicFilter.js";
export * from "./tools.js";
export * from "./authority.js";
export * from "./dictionary.js";
export * from "./analyticsWords.js";
export * from "./analyticsSources.js";
export * from "./feedback.js";
export * from "./photometricsTools.js";
export * from "./dimming.js";
export * from "./dimmingTools.js";
export * from "./layoutTool.js";
export * from "./agent.js";
