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

/** A chunk plus its start offset in the CLEANED text — what pagedChunk uses to
 *  assign page numbers from page-boundary offsets. */
export interface ChunkWithOffset extends Chunk {
  /** Offset of the chunk's first (non-whitespace) character in the cleaned text. */
  start: number;
}

export interface ChunkDetail {
  chunks: ChunkWithOffset[];
  /** True when the maxChunks cap stopped chunking with text remaining — the
   *  caller should surface this (plan R1: silent truncation drops appendices). */
  truncated: boolean;
}

/** The normalization chunkText applies before splitting. Exported so callers
 *  that pre-assemble text (pagedChunk joins pages) can normalize each piece
 *  identically, keeping ChunkWithOffset.start aligned with their joined text. */
export function cleanChunkText(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** chunkText, but also reporting each chunk's start offset and whether the
 *  maxChunks cap truncated the document. Same algorithm — chunkText delegates
 *  here, so the two can never drift. */
export function chunkTextDetailed(raw: string, opts: ChunkOpts = {}): ChunkDetail {
  const target = opts.targetChars ?? 2400;
  const overlap = opts.overlapChars ?? 360;
  const maxChunks = opts.maxChunks ?? 400;

  const clean = cleanChunkText(raw);
  if (!clean) return { chunks: [], truncated: false };

  const chunks: ChunkWithOffset[] = [];
  let start = 0;
  let index = 0;
  let truncated = false;
  while (start < clean.length) {
    if (chunks.length >= maxChunks) {
      truncated = true;
      break;
    }
    let end = Math.min(start + target, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const half = target * 0.5;
      const para = window.lastIndexOf("\n\n");
      const sent = window.lastIndexOf(". ");
      if (para > half) end = start + para;
      else if (sent > half) end = start + sent + 1;
    }
    const slice = clean.slice(start, end);
    const content = slice.trim();
    if (content) {
      // Offset of the first real character (the leading-whitespace trim shifts it).
      const lead = slice.length - slice.trimStart().length;
      chunks.push({ index: index++, content, start: start + lead });
    }
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return { chunks, truncated };
}

export function chunkText(raw: string, opts: ChunkOpts = {}): Chunk[] {
  return chunkTextDetailed(raw, opts).chunks.map(({ index, content }) => ({ index, content }));
}

/** Cheap token estimate (~4 chars/token) for the kb_chunks.token_count column. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
