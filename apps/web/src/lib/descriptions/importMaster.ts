import {
  MASTER_SLOT_SHEETS,
  parseMasterWorkbook,
  type DescMasterSlot,
  type ImportPayload,
  type ParseMasterResult,
} from "@wac/shared";
import { api, apiForm } from "../api.js";
import { extractWorkbookCells } from "./extractCells.js";

/**
 * Client orchestration for a master-slot import:
 *   read xlsx locally → shared grouping → archive raw → dry-run diff →
 *   (confirm if removals) → commit.
 * Nothing is written server-side until the payload has passed the shared
 * parser locally AND the raw file's magic bytes/size server-side.
 */

export type MasterParseOutcome =
  | { ok: true; payload: ImportPayload }
  | { ok: false; error: string };

export async function parseMasterFile(
  slot: DescMasterSlot,
  file: File,
): Promise<MasterParseOutcome> {
  const wanted = MASTER_SLOT_SHEETS[slot].map((d) => d.sheetName);
  let result: ParseMasterResult;
  try {
    const { sheets, missing } = await extractWorkbookCells(file, wanted);
    if (missing.length === wanted.length) {
      return {
        ok: false,
        error: `no expected sheet found (looked for ${wanted.map((s) => `"${s}"`).join(", ")}); is this the right workbook for this slot?`,
      };
    }
    result = parseMasterWorkbook(slot, sheets);
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
      warnings: result.warnings,
      sheets: result.sheets,
    },
  };
}

export async function uploadRawFile(
  slot: DescMasterSlot,
  file: File,
): Promise<string> {
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
  new: string[];
  updated: number;
  removed: string[];
  relinked: number;
  orphaned: string[];
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
