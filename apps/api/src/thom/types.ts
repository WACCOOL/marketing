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

/** Either kind of UI card the agent can emit. */
export type Card = ProductCard | FamilyCard;

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
