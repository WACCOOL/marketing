import type { PdfPageInput } from "@wac/shared";

/**
 * Browser-side pdf lanes (plan Stage 2), both on a lazily imported
 * pdfjs-dist (dynamic import keeps it out of the main bundle):
 *  - text extraction per page (MF naming pdf) → EOL-split lines for the
 *    shared parseMfPdfPages;
 *  - page rendering to JPEG (Schonbek pdf — image-only pages destined for
 *    the unassigned tray).
 */

// The worker asset resolves to a URL string at compile time (build emits the
// asset; dev serves it) — the pdf.js library itself stays a dynamic import so
// the ~480KB chunk loads only when a pdf lane actually runs.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?worker&url";

type Pdfjs = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<Pdfjs> | null = null;

async function loadPdfjs(): Promise<Pdfjs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

export async function extractPdfTextPages(file: File): Promise<PdfPageInput[]> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const doc = await task.promise;
  try {
    const pages: PdfPageInput[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const lines: string[] = [];
      let line = "";
      for (const item of tc.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      if (line) lines.push(line);
      pages.push({ index: i, lines });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

export interface RenderedPage {
  index: number;
  blob: Blob;
}

/** Render every page to a JPEG capped at `maxDim` px on the long edge. */
export async function renderPdfPagesToJpeg(
  file: File,
  onProgress?: (done: number, total: number) => void,
  maxDim = 1600,
): Promise<RenderedPage[]> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const doc = await task.promise;
  try {
    const out: RenderedPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = maxDim / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      // "print" intent renders without requestAnimationFrame scheduling —
      // a backgrounded/hidden tab would otherwise stall the render forever.
      await page.render({ canvas, viewport, intent: "print" }).promise;
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.85),
      );
      canvas.width = 0; // release backing store eagerly
      canvas.height = 0;
      if (blob) out.push({ index: i, blob });
      onProgress?.(i, doc.numPages);
    }
    return out;
  } finally {
    await task.destroy();
  }
}
