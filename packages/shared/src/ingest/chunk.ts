/**
 * Split extracted document text into overlapping chunks for embedding.
 * Char-based (~4 chars/token) so we stay dependency-free; prefers to break on
 * paragraph, then sentence, boundaries near the target so a chunk stays
 * self-contained (important for spec tables where a row shouldn't be split).
 */

export interface Chunk {
  index: number;
  content: string;
}

export interface ChunkOpts {
  /** ~600 tokens. */
  targetChars?: number;
  /** ~15% overlap. */
  overlapChars?: number;
  /** Safety cap so a pathological doc can't produce thousands of chunks. */
  maxChunks?: number;
}

export function chunkText(raw: string, opts: ChunkOpts = {}): Chunk[] {
  const target = opts.targetChars ?? 2400;
  const overlap = opts.overlapChars ?? 360;
  const maxChunks = opts.maxChunks ?? 400;

  const clean = raw
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!clean) return [];

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;
  while (start < clean.length && chunks.length < maxChunks) {
    let end = Math.min(start + target, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const half = target * 0.5;
      const para = window.lastIndexOf("\n\n");
      const sent = window.lastIndexOf(". ");
      if (para > half) end = start + para;
      else if (sent > half) end = start + sent + 1;
    }
    const content = clean.slice(start, end).trim();
    if (content) chunks.push({ index: index++, content });
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/** Cheap token estimate (~4 chars/token) for the kb_chunks.token_count column. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
