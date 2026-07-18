// The Thom card/citation/tool types now live in @wac/shared/thom (types.ts).
// This shim re-exports them so existing apps/api imports (routes/thom.ts,
// thom/hubspotTools.ts) keep working unchanged.
export type {
  Card,
  Citation,
  DocDownload,
  FamilyCard,
  FamilyMember,
  KeySpec,
  LayoutBomLine,
  LayoutCard,
  PhotometricsCard,
  ProductCard,
  ThomUsage,
  ToolContext,
  ToolOutput,
} from "@wac/shared/thom";
