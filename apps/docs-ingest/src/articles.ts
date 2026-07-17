import { createHash } from "node:crypto";

/**
 * Pure helpers for the ZenDesk Help Center article capture: brand mapping,
 * scope derivation, content hashing, and the kb_documents row payload. All
 * network-free so the capture logic is unit-testable without hitting ZenDesk.
 *
 * See apps/docs-ingest/src/zendesk.ts for the reader and index.ts (Step C) for
 * the capture orchestration.
 */

export const ZENDESK_SOURCE_SYSTEM = "zendesk";
export const ZENDESK_ARTICLE_DOC_TYPE = "zendesk_article";

/** The canonical brand strings Thom matches on (kb_documents.brand). */
export const KNOWN_BRANDS = ["WAC Lighting", "Modern Forms", "Schonbek", "AiSpire"] as const;

/** The subset of a ZenDesk Help Center article the capture needs. */
export interface ZendeskArticle {
  id: number;
  title: string;
  body: string | null;
  html_url: string;
  draft: boolean;
  section_id: number | null;
  /** Present on some HC schemas; the section's parent when the API returns it. */
  category_id?: number | null;
  label_names?: string[];
  /** null => visible to everyone (public); set => restricted (internal). */
  user_segment_id: number | null;
  updated_at: string;
  locale?: string;
}

/**
 * Parse the ZENDESK_HC_BRAND_MAP JSON var: a flat object mapping a section_id
 * OR category_id (as a string key) to a brand string, e.g.
 * `{ "360001": "WAC Lighting", "360002": "Schonbek" }`. Invalid JSON logs and
 * yields an empty map (capture then leaves brand null) — mirrors parseSyncGroups
 * in apps/api/src/zendesk.ts.
 */
export function parseBrandMap(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("[docs-ingest] ZENDESK_HC_BRAND_MAP is not valid JSON:", e);
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("[docs-ingest] ZENDESK_HC_BRAND_MAP must be a JSON object");
    return out;
  }
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val === "string" && val.trim()) out.set(String(key), val.trim());
  }
  return out;
}

/**
 * Resolve an article's brand: prefer an explicit section_id / category_id
 * mapping, then fall back to a label that matches a known brand name
 * (case-insensitive). No match => null (leave brand unset).
 */
export function mapArticleBrand(
  article: Pick<ZendeskArticle, "section_id" | "category_id" | "label_names">,
  brandMap: Map<string, string>,
): string | null {
  for (const id of [article.section_id, article.category_id]) {
    if (id === null || id === undefined) continue;
    const hit = brandMap.get(String(id));
    if (hit) return hit;
  }
  const labels = article.label_names ?? [];
  for (const label of labels) {
    if (typeof label !== "string") continue;
    const match = KNOWN_BRANDS.find((b) => b.toLowerCase() === label.trim().toLowerCase());
    if (match) return match;
  }
  return null;
}

/** Surface scope: an article with no user segment is public; a restricted one is internal. */
export function articleScope(
  article: Pick<ZendeskArticle, "user_segment_id">,
): "public" | "internal" {
  return article.user_segment_id === null || article.user_segment_id === undefined
    ? "public"
    : "internal";
}

/**
 * Change-detection hash: sha256 of the body plus updated_at. A body edit OR a
 * republish (which bumps updated_at) yields a new hash, so the capture re-pends
 * the row; an untouched article keeps its hash and its current status.
 */
export function articleContentHash(
  article: Pick<ZendeskArticle, "body" | "updated_at">,
): string {
  return createHash("sha256")
    .update(`${article.body ?? ""}\n${article.updated_at ?? ""}`)
    .digest("hex");
}

/**
 * kb_documents upsert payload for a published article. `status` is intentionally
 * OMITTED so a NEW or CHANGED row defaults to 'pending_extract' and an unchanged
 * row keeps its current status (mirrors the saleslayer + marketing capture).
 */
export function buildArticleDocPayload(
  article: ZendeskArticle,
  brand: string | null,
  hash: string,
): Record<string, unknown> {
  return {
    source_system: ZENDESK_SOURCE_SYSTEM,
    external_id: String(article.id),
    doc_type: ZENDESK_ARTICLE_DOC_TYPE,
    scope: articleScope(article),
    brand,
    title: article.title,
    url: article.html_url,
    content_hash: hash,
  };
}
