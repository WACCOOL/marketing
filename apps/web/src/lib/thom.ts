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
  sku: string;
  name: string | null;
  brand: string | null;
  image_url: string | null;
  key_specs: KeySpec[];
  pdp_url: string | null;
  downloads: DocDownload[];
}
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
  cards: ProductCard[];
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
