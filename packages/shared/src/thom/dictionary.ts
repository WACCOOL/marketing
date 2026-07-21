/**
 * Thom dictionary — protected terms the copy normalizer must never rewrite,
 * editable in the marketing app (thom_dictionary table, migration 0056) on
 * top of the code-level DEFAULT_PROTECTED_TERMS.
 *
 * Loaded by the PUBLIC agent per stream with a small in-isolate cache so a
 * busy bubble doesn't hammer the table. Failures return [] — the defaults in
 * publicFilter always apply, so DB trouble can never break the core brand
 * names or the chat itself.
 */

interface DictionaryClient {
  from(table: string): {
    select(cols: string): PromiseLike<{ data: { term: string }[] | null; error: { message: string } | null }>;
  };
}

const CACHE_TTL_MS = 5 * 60_000;
let cache: { terms: string[]; at: number } | null = null;

/** Test hook. */
export function resetDictionaryCache(): void {
  cache = null;
}

export async function loadProtectedTerms(sb: unknown): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.terms;
  try {
    const { data, error } = await (sb as DictionaryClient)
      .from("thom_dictionary")
      .select("term");
    if (error) return cache?.terms ?? [];
    const terms = (data ?? [])
      .map((r) => (typeof r.term === "string" ? r.term.trim() : ""))
      .filter(Boolean);
    cache = { terms, at: Date.now() };
    return terms;
  } catch {
    return cache?.terms ?? [];
  }
}
