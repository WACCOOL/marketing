import { api } from "./api.js";

/** Client for the internal Thom chat endpoint (mirrors apps/api/src/thom/types). */

export interface KeySpec {
  label: string;
  value: string;
}
export interface DocDownload {
  label: string;
  url: string;
  doc_type: string;
}
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
export interface FamilyMember {
  sku: string;
  name: string | null;
  role: string | null;
  image_url: string | null;
  pdp_url: string | null;
}
export interface FamilyCard {
  kind: "family";
  family: string;
  brand: string | null;
  image_url: string | null;
  category: string | null;
  members: FamilyMember[];
  member_count: number;
}
/** Either kind of card. Cards logged before the family feature have no `kind`;
 *  treat missing/`"product"` as a ProductCard on the client. */
export type Card = ProductCard | FamilyCard;
export interface Citation {
  document_id: string;
  title: string | null;
  doc_type: string;
  page: number | null;
  url: string | null;
}
export interface ChatResponse {
  conversationId: string;
  answer: string;
  cards: Card[];
  citations: Citation[];
}

export function sendChat(
  message: string,
  conversationId: string | null,
): Promise<ChatResponse> {
  return api<ChatResponse>("/api/thom/chat", {
    method: "POST",
    body: JSON.stringify({ message, conversationId: conversationId ?? undefined }),
  });
}
