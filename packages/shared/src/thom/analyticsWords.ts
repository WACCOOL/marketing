/**
 * Word-frequency rollup for the Thom analytics page: turns the top search
 * QUERIES (from thom_top_queries) into the top WORDS people use, with a small
 * lighting-domain-aware stopword list. Pure so the ranking is unit-tested.
 */

const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "at", "be", "can", "do", "does", "for",
  "from", "have", "how", "i", "in", "is", "it", "me", "my", "need", "of",
  "on", "or", "our", "than", "that", "the", "there", "to", "want", "we",
  "what", "which", "with", "you", "your",
  // Near-universal in this domain — they'd drown the interesting words.
  "wac", "group", "light", "lights", "lighting",
]);

export interface WordCount {
  word: string;
  hits: number;
}

/** Aggregate query strings (with per-query hit counts) into ranked words. */
export function wordFrequencies(
  queries: { query: string; hits: number }[],
  maxWords = 30,
): WordCount[] {
  const counts = new Map<string, number>();
  for (const { query, hits } of queries) {
    const seen = new Set<string>(); // count each word once per query string
    for (const raw of query.toLowerCase().split(/[^a-z0-9-]+/)) {
      const word = raw.replace(/^-+|-+$/g, "");
      if (word.length < 3 || STOPWORDS.has(word) || seen.has(word)) continue;
      seen.add(word);
      counts.set(word, (counts.get(word) ?? 0) + hits);
    }
  }
  return [...counts.entries()]
    .map(([word, hits]) => ({ word, hits }))
    .sort((a, b) => b.hits - a.hits || (a.word < b.word ? -1 : 1))
    .slice(0, maxWords);
}
