import { chunkTextDetailed, cleanChunkText, type ChunkOpts } from "./chunk.js";

/**
 * Page-aware chunking for admin-uploaded education PDFs (Thom lighting-expert
 * plan, Prong C.2 / objections A3+R2+R1).
 *
 * The generic ingest path inserts every chunk with `page: null` — useless for a
 * 200-page standard where "source: <doc> p.148" is both the usable citation and
 * the licensing auditability. This helper takes the PER-PAGE text array (unpdf
 * with mergePages: false), joins the pages, chunks the joined text, and assigns
 * each chunk the page its first character came from.
 *
 * Implementation note: the plan sketch said "join with markers"; offsets are
 * the same idea without inline sentinel strings (a chunk boundary can never
 * split an offset, and no marker text can leak into an embedded chunk). Each
 * page is pre-normalized with the exact cleaning chunkTextDetailed applies, so
 * the joined string is already clean and chunk start offsets align 1:1.
 */

/**
 * Chunk cap for admin uploads (plan R1): chunkText's default 400 silently
 * truncates at roughly 270 pages, which would drop exactly the appendices
 * (JA8, LPD tables) the uploads exist for — while showing "active".
 */
export const ADMIN_UPLOAD_MAX_CHUNKS = 2000;

export interface PagedChunk {
  index: number;
  content: string;
  /** 1-based page number the chunk starts on. */
  page: number;
}

export interface PagedChunkResult {
  chunks: PagedChunk[];
  /** True when the maxChunks cap stopped chunking with pages remaining. */
  truncated: boolean;
  /** Total pages supplied (including empty ones). */
  pageCount: number;
}

export function pagedChunk(pages: string[], opts: ChunkOpts = {}): PagedChunkResult {
  // Pre-clean each page identically to the chunker's own normalization; empty
  // pages are dropped (but keep their 1-based numbering for the survivors).
  const segments: { page: number; text: string }[] = [];
  for (let i = 0; i < pages.length; i++) {
    const text = cleanChunkText(pages[i] ?? "");
    if (text) segments.push({ page: i + 1, text });
  }
  if (!segments.length) return { chunks: [], truncated: false, pageCount: pages.length };

  // Join with a blank line, recording each page's start offset in the joined
  // text. Segments are trimmed, so every boundary contributes exactly "\n\n"
  // and the joined string is already fully normalized (offsets stay exact).
  const starts: { page: number; offset: number }[] = [];
  let joined = "";
  for (const s of segments) {
    if (joined) joined += "\n\n";
    starts.push({ page: s.page, offset: joined.length });
    joined += s.text;
  }

  const detail = chunkTextDetailed(joined, {
    ...opts,
    maxChunks: opts.maxChunks ?? ADMIN_UPLOAD_MAX_CHUNKS,
  });
  const chunks = detail.chunks.map((c) => ({
    index: c.index,
    content: c.content,
    page: pageAt(starts, c.start),
  }));
  return { chunks, truncated: detail.truncated, pageCount: pages.length };
}

/** The page whose start offset is the last one at or before `offset`. */
function pageAt(starts: { page: number; offset: number }[], offset: number): number {
  let page = starts[0]!.page;
  for (const s of starts) {
    if (s.offset <= offset) page = s.page;
    else break;
  }
  return page;
}
