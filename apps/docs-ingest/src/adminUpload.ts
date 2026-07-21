import { ADMIN_UPLOAD_MAX_CHUNKS, pagedChunk } from "@wac/shared";
import { SPARSE_THRESHOLD, textDensity } from "./extract.js";

/**
 * Admin-uploaded education PDFs (Thom lighting-expert plan, Prong C.2).
 *
 * These rows (source_system='admin_upload') carry no fetchable `url` — the PDF
 * lives in R2 at `r2_key` (kb/admin_uploads/{uuid}.pdf), written by the
 * /api/thom-uploads route. Extraction differs from the generic PDF path:
 *  - PER-PAGE text-layer extraction so chunks carry real page numbers (A3/R2);
 *  - chunk cap raised to ADMIN_UPLOAD_MAX_CHUNKS with the truncation surfaced
 *    as a WARNING in kb_documents.last_error, status stays 'active' (R1);
 *  - the Claude-vision fallback is PAGE-CAPPED: a scanned doc over the cap
 *    fails with a clear last_error instead of burning the API budget and the
 *    60-minute job cap (A15/R12c). Licensed standards are born-digital, so
 *    this is an edge case.
 *
 * The `force_vision` upload toggle rides in the R2 object's user metadata
 * (kb_documents has no column for it): customMetadata { "force-vision": "1" }.
 *
 * Everything here is dependency-injected (R2 read, page extraction, vision) so
 * the branch is unit-testable without R2 or a real PDF.
 */

export const ADMIN_UPLOAD_SOURCE = "admin_upload";

/** Vision fallback page cap for admin uploads (plan A15/R12c). */
export const ADMIN_VISION_PAGE_CAP = 100;

/** last_error text when the chunk cap truncated the document. The "WARNING"
 *  prefix is the UI's truncation flag — status stays 'active' (plan R1). */
export const TRUNCATION_WARNING =
  `WARNING: document exceeded the indexing cap of ${ADMIN_UPLOAD_MAX_CHUNKS} chunks; ` +
  "later pages are not indexed";

export const SCANNED_TOO_LARGE_ERROR =
  `scanned documents this large aren't supported (no usable text layer and over ` +
  `${ADMIN_VISION_PAGE_CAP} pages)`;

/** R2 metadata key carrying the force-vision toggle. */
export const FORCE_VISION_META_KEY = "force-vision";

export interface AdminUploadDeps {
  /** R2 object read (bytes + user metadata); null when R2_* env is absent. */
  getObject: ((key: string) => Promise<{ bytes: Uint8Array; meta: Record<string, string> } | null>) | null;
  /** Per-page text-layer extraction (extractPdfPageTexts). May throw. */
  extractPages: (bytes: Uint8Array) => Promise<{ pages: string[]; pageCount: number }>;
  /** Claude PDF-vision pass; null when ANTHROPIC_API_KEY is unset. */
  vision: ((bytes: Uint8Array) => Promise<string>) | null;
}

export type AdminUploadExtract =
  | {
      ok: true;
      chunks: { index: number; content: string; page: number | null }[];
      truncated: boolean;
      pageCount: number;
      method: "text-layer" | "claude-vision";
    }
  | { ok: false; error: string };

function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

export async function extractAdminUpload(
  r2Key: string | null,
  deps: AdminUploadDeps,
): Promise<AdminUploadExtract> {
  if (!deps.getObject) {
    return { ok: false, error: "R2 store not configured (R2_* env missing in this run)" };
  }
  if (!r2Key) return { ok: false, error: "admin_upload row has no r2_key" };
  const obj = await deps.getObject(r2Key);
  if (!obj) return { ok: false, error: `uploaded PDF missing from R2 (${r2Key})` };
  if (!isPdfBytes(obj.bytes)) return { ok: false, error: "stored object is not a PDF" };

  const forceVision = obj.meta[FORCE_VISION_META_KEY] === "1";

  // Page count is needed either way (vision cap); the text layer is the normal
  // path unless the admin forced vision at upload.
  let pageCount = 0;
  if (!forceVision) {
    try {
      const { pages, pageCount: n } = await deps.extractPages(obj.bytes);
      pageCount = n;
      const total = pages.reduce((sum, p) => sum + textDensity(p), 0);
      if (total >= SPARSE_THRESHOLD) {
        const res = pagedChunk(pages);
        if (!res.chunks.length) return { ok: false, error: "no chunks" };
        return {
          ok: true,
          chunks: res.chunks,
          truncated: res.truncated,
          pageCount: n,
          method: "text-layer",
        };
      }
      // Sparse text layer → scanned doc → vision fallback below.
    } catch {
      // Corrupt/encrypted text layer — fall through to the vision pass with an
      // unknown page count (same posture as the generic extractPdf).
    }
  } else {
    try {
      pageCount = (await deps.extractPages(obj.bytes)).pageCount;
    } catch {
      pageCount = 0;
    }
  }

  // Vision path (scanned or forced): page-capped for admin uploads.
  if (pageCount > ADMIN_VISION_PAGE_CAP) return { ok: false, error: SCANNED_TOO_LARGE_ERROR };
  if (!deps.vision) {
    return {
      ok: false,
      error: "no usable text layer and the vision fallback is not configured (ANTHROPIC_API_KEY unset)",
    };
  }
  const text = (await deps.vision(obj.bytes)).trim();
  if (!textDensity(text)) return { ok: false, error: "no extractable text" };
  // A single vision transcript carries no reliable page boundaries — chunks are
  // stored with page: null rather than a made-up number.
  const res = pagedChunk([text]);
  return {
    ok: true,
    chunks: res.chunks.map((c) => ({ index: c.index, content: c.content, page: null })),
    truncated: res.truncated,
    pageCount,
    method: "claude-vision",
  };
}
