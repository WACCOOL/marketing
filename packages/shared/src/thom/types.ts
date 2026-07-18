/** Structured, UI-renderable pieces the agent emits alongside its prose. */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ThomEnv } from "./env.js";

/** Shared tool-execution context. Lives here (not tools.ts) so tools.ts and the
 *  internal caller's injected tools can share it without a circular dependency.
 *  `env` is the narrow ThomEnv; the internal caller passes its fat `Env`, which
 *  structurally satisfies it. */
export interface ToolContext {
  env: ThomEnv;
  sb: SupabaseClient;
}

/** A tool's result: text fed back to Claude, plus any UI cards/citations. */
export interface ToolOutput {
  /** Text fed back to Claude as the tool_result. */
  content: string;
  cards: Card[];
  citations: Citation[];
}

export interface KeySpec {
  label: string;
  value: string;
}

export interface DocDownload {
  label: string;
  url: string;
  doc_type: string;
}

/** A product card — image + key specs + PDP link + document downloads. */
export interface ProductCard {
  kind: "product";
  sku: string;
  name: string | null;
  brand: string | null;
  image_url: string | null;
  key_specs: KeySpec[];
  pdp_url: string | null;
  downloads: DocDownload[];
}

/** One component of a family/system, as it appears on a FamilyCard. */
export interface FamilyMember {
  sku: string;
  name: string | null;
  /** The member's role in the system (its category, e.g. "Channel"). */
  role: string | null;
  image_url: string | null;
  pdp_url: string | null;
}

/** A family/system card — a whole product SYSTEM as ONE card, listing its
 *  member components (channel + heads + transformer + connectors, etc.). */
export interface FamilyCard {
  kind: "family";
  family: string;
  brand: string | null;
  image_url: string | null;
  category: string | null;
  members: FamilyMember[];
  /** Total members found for the family (may exceed `members.length`, which is
   *  capped for display). */
  member_count: number;
}

/** A photometrics card — precomputed IES metrics for one SKU's representative
 *  distribution (beam/field angles, spacing, zonal, BUG/UGR, efficacy, cone of
 *  light). `metrics` is the raw ies_metrics.metrics bundle (jsonb) for the UI to
 *  render; `source_filename` is the inner IES filename it came from. */
export interface PhotometricsCard {
  kind: "photometrics";
  sku: string;
  source_filename: string | null;
  metrics: unknown;
}

/** One aggregated line of a track / layout bill of materials. `sku` is
 *  null when the seed doesn't carry a SKU for that role (the model can
 *  resolve it via get_related_products). */
export interface LayoutBomLine {
  sku: string | null;
  description: string;
  qty: number;
  role: string;
}

/** A layout card — a lighting layout + bill of materials for a space.
 *  Covers the track-with-heads case (runs / heads-per-run / transformers)
 *  and the single-product area-grid / linear cases. `plan` carries a
 *  React-drawable top-down plan in NORMALIZED 0..1 room coords (the tool
 *  downsamples any heatmap to ≤16×16). */
export interface LayoutCard {
  kind: "layout";
  space: { lengthFt: number; widthFt: number; mountingHeightFt: number };
  product: { sku: string | null; name: string | null; family: string | null };
  layoutKind: "track" | "area-grid" | "linear";
  summary: {
    headCount: number;
    runs?: number;
    headsPerRun?: number;
    headSpacingFt?: number;
    totalTrackFt?: number;
    transformerCount?: number;
    circuits?: number;
    avgFc: number;
    uniformity: number;
    totalWatts: number;
  };
  bom: { lines: LayoutBomLine[] };
  /** Top-down plan in normalized 0..1 room coordinates. */
  plan?: {
    runs: { x1: number; y1: number; x2: number; y2: number }[];
    heads: { x: number; y: number }[];
    heatmap?: { cols: number; rows: number; values: number[][]; min: number; max: number };
  };
  warnings: string[];
}

/** Any kind of UI card the agent can emit. */
export type Card = ProductCard | FamilyCard | PhotometricsCard | LayoutCard;

/** A source citation back to the spec sheet / manual a claim came from, or an
 *  open-web source when Thom used web_search. `kind` is optional — absent means
 *  a doc citation (the original, cataloged behavior). */
export interface Citation {
  kind?: "doc" | "web";
  document_id: string;
  title: string | null;
  doc_type: string;
  page: number | null;
  url: string | null;
}

export interface ThomUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  /** The model that produced the ANSWERING turn (last write wins in the loop).
   *  Reflects the escalation model when a hard question was tiered up. */
  model: string;
  /** True when the loop escalated to the stronger model on any turn. */
  escalated: boolean;
}
