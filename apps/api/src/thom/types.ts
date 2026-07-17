/** Structured, UI-renderable pieces the agent emits alongside its prose. */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";

/** Shared tool-execution context. Lives here (not tools.ts) so both tools.ts
 *  and hubspotTools.ts can import it without a circular dependency. */
export interface ToolContext {
  env: Env;
  sb: SupabaseClient;
}

/** A tool's result: text fed back to Claude, plus any UI cards/citations. */
export interface ToolOutput {
  /** Text fed back to Claude as the tool_result. */
  content: string;
  cards: ProductCard[];
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
  sku: string;
  name: string | null;
  brand: string | null;
  image_url: string | null;
  key_specs: KeySpec[];
  pdp_url: string | null;
  downloads: DocDownload[];
}

/** A source citation back to the spec sheet / manual a claim came from. */
export interface Citation {
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
  model: string;
}
