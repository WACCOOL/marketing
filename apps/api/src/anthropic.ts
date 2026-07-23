// The Anthropic Messages client for the Thom Bot brain now lives in
// @wac/shared/thom (transport.ts) so both the internal API Worker and a future
// public Worker share one client. This thin shim re-exports it so existing
// apps/api imports (routes/thom.ts, thom/hubspotTools.ts) keep working unchanged.
export {
  anthropicConfigured,
  claudeMessages,
  claudeMessagesStream,
  claudeModel,
  claudeRouterModel,
} from "@wac/shared/thom";
export type {
  ClaudeCacheControl,
  ClaudeContentBlock,
  ClaudeImageBlock,
  ClaudeMessage,
  ClaudeRequestOpts,
  ClaudeResponse,
  ClaudeServerTool,
  ClaudeServerToolUseBlock,
  ClaudeStreamEvent,
  ClaudeSystemBlock,
  ClaudeTextBlock,
  ClaudeThinkingBlock,
  ClaudeTool,
  ClaudeToolResultBlock,
  ClaudeToolUseBlock,
  ClaudeUsage,
  ClaudeWebSearchResult,
  ClaudeWebSearchResultLocation,
  ClaudeWebSearchToolResultBlock,
} from "@wac/shared/thom";
