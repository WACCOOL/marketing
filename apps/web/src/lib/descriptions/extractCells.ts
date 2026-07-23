import type { Cell } from "@wac/shared";

/**
 * Browser-side xlsx cell extraction (plan decision 1: ALL binary parsing in
 * the browser). SheetJS is dynamically imported so the page's main chunk
 * stays lean. Output is a plain primitive matrix per sheet — the exact input
 * shape the shared parseMasterWorkbook consumes — with merged cells filled
 * from their anchor value so forward-fill grouping sees them.
 */

export interface ExtractResult {
  sheets: Record<string, Cell[][]>;
  /** Requested sheet names that don't exist in the workbook. */
  missing: string[];
}

function coerce(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export async function extractWorkbookCells(
  file: File,
  sheetNames: readonly string[],
): Promise<ExtractResult> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });

  const sheets: Record<string, Cell[][]> = {};
  const missing: string[] = [];

  for (const name of sheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) {
      missing.push(name);
      continue;
    }
    // header:1 + blankrows keeps row indices aligned with the sheet (headers
    // must land on index 3); defval:null pads rows to full width.
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });
    const matrix: Cell[][] = rows.map((r) => r.map(coerce));

    // Merged cells: SheetJS leaves non-anchor cells empty. Copy the anchor
    // value into every covered cell (only where blank) so forward-fill and
    // aggregation see the value on each row of the merge.
    const merges = (ws["!merges"] ?? []) as {
      s: { r: number; c: number };
      e: { r: number; c: number };
    }[];
    for (const m of merges) {
      const anchor = matrix[m.s.r]?.[m.s.c];
      if (anchor === null || anchor === undefined || anchor === "") continue;
      for (let r = m.s.r; r <= m.e.r; r++) {
        const row = (matrix[r] ??= []);
        for (let c = m.s.c; c <= m.e.c; c++) {
          if (row[c] === null || row[c] === undefined || row[c] === "") {
            row[c] = anchor;
          }
        }
      }
    }
    sheets[name] = matrix;
  }

  return { sheets, missing };
}
