import {
  MASTER_SLOT_SHEETS,
  mapAnchorsToGroups,
  parseMasterWorkbook,
  type DescMasterSlot,
  type DescSlot,
  type ImportPayload,
  type ParseMasterResult,
} from "@wac/shared";
import { api, apiForm } from "../api.js";
import { extractWorkbookCells } from "./extractCells.js";
import { extractXlsxImages } from "./xlsxImages.js";
import { downscaleToJpeg, mimeForMediaPath, uploadDescImages } from "./imageUpload.js";

/**
 * Client orchestration for a master-slot import:
 *   read xlsx locally → shared grouping → extract drawing images → downscale
 *   → upload (4-way, content-hash dedup) → archive raw → dry-run diff →
 *   (confirm if removals) → commit.
 * Nothing is written server-side until the payload has passed the shared
 * parser locally AND the raw file's magic bytes/size server-side; the commit
 * re-verifies every referenced image key against R2 before inserting.
 */

export type MasterPhase =
  | { kind: "reading" }
  | { kind: "images"; done: number; total: number }
  | { kind: "uploading"; done: number; total: number };

export type MasterParseOutcome =
  | { ok: true; payload: ImportPayload }
  | { ok: false; error: string };

export async function parseMasterFile(
  slot: DescMasterSlot,
  file: File,
  onPhase?: (phase: MasterPhase) => void,
): Promise<MasterParseOutcome> {
  const wanted = MASTER_SLOT_SHEETS[slot].map((d) => d.sheetName);
  let result: ParseMasterResult;
  let images: ImportPayload["images"] = [];
  const warnings: string[] = [];
  try {
    onPhase?.({ kind: "reading" });
    const { sheets, missing } = await extractWorkbookCells(file, wanted);
    if (missing.length === wanted.length) {
      return {
        ok: false,
        error: `no expected sheet found (looked for ${wanted.map((s) => `"${s}"`).join(", ")}); is this the right workbook for this slot?`,
      };
    }
    result = parseMasterWorkbook(slot, sheets);
    if (result.ok) {
      images = await prepareMasterImages(slot, file, result.spans, warnings, onPhase);
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "could not read the workbook",
    };
  }
  if (!result.ok) {
    const where = result.sheet ? ` (sheet "${result.sheet}")` : "";
    return { ok: false, error: `${result.error}${where}` };
  }
  return {
    ok: true,
    payload: {
      slot,
      products: result.products,
      images,
      warnings: [...result.warnings, ...warnings],
      sheets: result.sheets,
    },
  };
}

/** Extract, map, downscale and upload the workbook's embedded renders. */
async function prepareMasterImages(
  slot: DescMasterSlot,
  file: File,
  spans: Extract<ParseMasterResult, { ok: true }>["spans"],
  warnings: string[],
  onPhase?: (phase: MasterPhase) => void,
): Promise<ImportPayload["images"]> {
  const extract = await extractXlsxImages(file);
  warnings.push(...extract.warnings);
  const assignments = mapAnchorsToGroups(extract.anchors, spans);

  const wanted = new Set<string>();
  for (const a of assignments) {
    if (a.content_key) wanted.add(a.anchor.imageId);
    else {
      warnings.push(
        `image at "${a.anchor.sheet}" row ${a.anchor.row + 1} is outside every product group; skipped`,
      );
    }
  }
  if (wanted.size === 0) return [];

  // Downscale each distinct media file once.
  const prepared: { id: string; blob: Blob }[] = [];
  let done = 0;
  onPhase?.({ kind: "images", done, total: wanted.size });
  for (const id of wanted) {
    const bytes = extract.media.get(id);
    if (!bytes) continue;
    const blob = await downscaleToJpeg(bytes, mimeForMediaPath(id));
    if (blob) prepared.push({ id, blob });
    else warnings.push(`image "${id}" could not be decoded in the browser; skipped`);
    done++;
    onPhase?.({ kind: "images", done, total: wanted.size });
  }
  if (prepared.length === 0) return [];

  onPhase?.({ kind: "uploading", done: 0, total: prepared.length });
  const keys = await uploadDescImages(slot, prepared, (d, t) =>
    onPhase?.({ kind: "uploading", done: d, total: t }),
  );

  // Anchor order (sheet appearance) drives sort order; (content_key, r2_key)
  // pairs dedupe so one media reused on two rows of the same group links once.
  const seen = new Set<string>();
  const images: ImportPayload["images"] = [];
  let order = 0;
  for (const a of assignments) {
    if (!a.content_key) continue;
    const r2Key = keys.get(a.anchor.imageId);
    if (!r2Key) continue;
    const pairKey = `${a.content_key} ${r2Key}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    images.push({ content_key: a.content_key, r2_key: r2Key, sort_order: order++ });
  }
  return images;
}

export async function uploadRawFile(slot: DescSlot, file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await apiForm<{ import_id: string }>(
    `/api/descriptions/files/${slot}/raw`,
    form,
  );
  return res.import_id;
}

export interface CommitSummary {
  dryRun: boolean;
  products: number;
  images: number;
  new: string[];
  updated: number;
  removed: string[];
  relinked: number;
  orphaned: string[];
  /** Content rows with a description preserved across the re-import. */
  kept: number;
  warnings: string[];
}

export async function commitImport(
  slot: DescMasterSlot,
  importId: string,
  payload: ImportPayload,
  dryRun: boolean,
): Promise<CommitSummary> {
  return api<CommitSummary>(`/api/descriptions/files/${slot}/commit`, {
    method: "POST",
    body: JSON.stringify({ import_id: importId, dryRun, payload }),
  });
}
