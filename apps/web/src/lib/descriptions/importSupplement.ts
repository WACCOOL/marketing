import {
  parseMfPdfPages,
  parsePptxSlides,
  type DescSupplementSlot,
  type SupplementPayload,
  type SupplementUnit,
} from "@wac/shared";
import { api } from "../api.js";
import { extractPptxSlides } from "./pptx.js";
import { extractPdfTextPages, renderPdfPagesToJpeg } from "./pdf.js";
import { downscaleToJpeg, mimeForMediaPath, uploadDescImages } from "./imageUpload.js";
import { uploadRawFile } from "./importMaster.js";

/**
 * Client orchestration for the supplemental slots (plan Stage 2):
 *   *_pptx decks (DWELED / WAC Lighting / WAC Architectural) — slide text +
 *                  hero images → units with bullets + images
 *   mf_pdf       — page text → units with bullets (no images)
 *   schonbek_pdf — image-only pages rendered to JPEG → unassigned tray
 * Flow order per plan: extract → upload images (4-way) → upload raw →
 * commit JSON referencing images by hash key.
 */

export type SupplementPhase =
  | { kind: "reading" }
  | { kind: "extracting"; done: number; total: number }
  | { kind: "uploading"; done: number; total: number }
  | { kind: "importing" };

export interface SupplementSummary {
  units: number;
  matched: number;
  unmatched: { ref: string; name: string | null; reason: string }[];
  skipped: string[];
  warnings: string[];
  images: number;
}

export type SupplementOutcome =
  | { ok: true; summary: SupplementSummary }
  | { ok: false; error: string };

export async function importSupplementFile(
  slot: DescSupplementSlot,
  file: File,
  onPhase?: (phase: SupplementPhase) => void,
): Promise<SupplementOutcome> {
  try {
    onPhase?.({ kind: "reading" });
    const payload = slot.endsWith("_pptx")
      ? await preparePptx(slot, file, onPhase)
      : slot === "mf_pdf"
        ? await prepareMfPdf(slot, file)
        : await prepareSchonbekPdf(slot, file, onPhase);
    if (payload.units.length === 0) {
      return { ok: false, error: "no usable product slides/pages were found in this file" };
    }
    onPhase?.({ kind: "importing" });
    const importId = await uploadRawFile(slot, file);
    const summary = await api<SupplementSummary>(
      `/api/descriptions/files/${slot}/commit`,
      {
        method: "POST",
        body: JSON.stringify({ import_id: importId, payload }),
      },
    );
    return { ok: true, summary };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "import failed" };
  }
}

async function preparePptx(
  slot: DescSupplementSlot,
  file: File,
  onPhase?: (phase: SupplementPhase) => void,
): Promise<SupplementPayload> {
  const { slides, media } = await extractPptxSlides(file);
  const { units, skipped } = parsePptxSlides(slides);
  const warnings: string[] = [];

  // Only media referenced by kept units is downscaled + uploaded.
  const wanted = new Set(units.flatMap((u) => u.imageIds));
  const prepared: { id: string; blob: Blob }[] = [];
  let done = 0;
  onPhase?.({ kind: "extracting", done, total: wanted.size });
  for (const id of wanted) {
    const bytes = media.get(id);
    if (!bytes) continue;
    const blob = await downscaleToJpeg(bytes, mimeForMediaPath(id));
    if (blob) prepared.push({ id, blob });
    else warnings.push(`image "${id}" could not be decoded in the browser; skipped`);
    done++;
    onPhase?.({ kind: "extracting", done, total: wanted.size });
  }
  let keys = new Map<string, string>();
  if (prepared.length > 0) {
    onPhase?.({ kind: "uploading", done: 0, total: prepared.length });
    keys = await uploadDescImages(slot, prepared, (d, t) =>
      onPhase?.({ kind: "uploading", done: d, total: t }),
    );
  }

  const payloadUnits: SupplementUnit[] = units.map((u) => ({
    ref: u.ref,
    name: u.name,
    model_numbers: u.models,
    model_bases: u.modelBases,
    bullets: u.bullets,
    image_keys: u.imageIds
      .map((id) => keys.get(id))
      .filter((k): k is string => !!k),
  }));
  return { slot, units: payloadUnits, skipped, warnings };
}

async function prepareMfPdf(
  slot: DescSupplementSlot,
  file: File,
): Promise<SupplementPayload> {
  const pages = await extractPdfTextPages(file);
  const { units, skipped } = parseMfPdfPages(pages);
  return {
    slot,
    units: units.map((u) => ({
      ref: u.ref,
      name: u.name,
      model_numbers: u.models,
      model_bases: u.modelBases,
      bullets: u.bullets,
      image_keys: [],
    })),
    skipped,
    warnings: [],
  };
}

async function prepareSchonbekPdf(
  slot: DescSupplementSlot,
  file: File,
  onPhase?: (phase: SupplementPhase) => void,
): Promise<SupplementPayload> {
  const rendered = await renderPdfPagesToJpeg(file, (d, t) =>
    onPhase?.({ kind: "extracting", done: d, total: t }),
  );
  onPhase?.({ kind: "uploading", done: 0, total: rendered.length });
  const keys = await uploadDescImages(
    slot,
    rendered.map((p) => ({ id: `page-${p.index}`, blob: p.blob })),
    (d, t) => onPhase?.({ kind: "uploading", done: d, total: t }),
  );
  const units: SupplementUnit[] = rendered
    .map((p) => {
      const key = keys.get(`page-${p.index}`);
      return {
        ref: `page ${p.index}`,
        name: null,
        model_numbers: [],
        model_bases: [],
        bullets: [],
        image_keys: key ? [key] : [],
      };
    })
    .filter((u) => u.image_keys.length > 0);
  return { slot, units, skipped: [], warnings: [] };
}
