import { api } from "./api.js";

/** Thom admin — chat viewer + analytics (admin only; the API enforces). */

export interface AdminConversation {
  id: string;
  scope: "internal" | "public";
  user_id: string | null;
  user_email: string | null;
  surface: string;
  site_key: string | null;
  title: string | null;
  questions: number;
  created_at: string;
  updated_at: string;
}

export interface AdminMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls: { name: string; input: Record<string, unknown> }[] | null;
  citations: { title: string | null; url: string | null; doc_type: string }[] | null;
  product_cards: { sku: string; name: string | null }[] | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

export async function listConversations(params: {
  days: number;
  surface: "all" | "internal" | "public";
  limit?: number;
  offset?: number;
}): Promise<{ total: number; items: AdminConversation[] }> {
  const q = new URLSearchParams({
    days: String(params.days),
    surface: params.surface,
    limit: String(params.limit ?? 50),
    offset: String(params.offset ?? 0),
  });
  return api(`/api/thom-admin/conversations?${q}`);
}

export async function getConversation(
  id: string,
): Promise<{ conversation: AdminConversation; messages: AdminMessage[] }> {
  return api(`/api/thom-admin/conversations/${id}`);
}

export interface DailyRow {
  day: string;
  internal_conversations: number;
  public_conversations: number;
  internal_questions: number;
  public_questions: number;
  internal_users: number;
}

export interface AnalyticsBundle {
  days: number;
  daily: DailyRow[];
  topQueries: { query: string; hits: number; public_hits: number }[];
  topWords: { word: string; hits: number }[];
  topProducts: { sku: string; name: string | null; hits: number }[];
}

export async function getAnalytics(days: number): Promise<AnalyticsBundle> {
  return api(`/api/thom-admin/analytics?days=${days}`);
}
