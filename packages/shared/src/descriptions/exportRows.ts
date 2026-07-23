import { toCsv } from "../productinfo.js";
import { DESC_STATUS_LABELS } from "./schema.js";
import type { SizeTuple } from "./schema.js";
import { titleFor } from "./titles.js";

/**
 * Descriptions — client-side export assembly (plan decision 9).
 *
 * Export is fully client-side: the page already holds the whole dataset, so
 * the exported rows are exactly what the user is looking at (single source of
 * truth). This module is pure — it takes plain product rows (the GET /
 * response shape) and returns header + cell matrices for XLSX (SheetJS
 * aoa_to_sheet) and CSV (shared toCsv quoting, RFC-4180-ish).
 *
 * Multi-size products (several distinct L/W/H tuples) export as ONE row with
 * per-axis columns. Representation, chosen for Excel readability:
 *   - every tuple shares the value on an axis → the single value ("5")
 *   - values differ → tuple-order join with "; " ("26; 32"), so the Nth entry
 *     of Length, Width and Height always belongs to the same size tuple
 *   - a missing axis inside a joined list renders "?" to keep that alignment;
 *     a missing single value renders "" (empty cell)
 */

/** The effective-copy fields of a desc_content row used by the export. */
export interface ExportContent {
  description_ai: string | null;
  description_final: string | null;
  meta_ai: string | null;
  meta_final: string | null;
  title_override: string | null;
  /** Editor's corrected product name (optional pre-0073). */
  name_override?: string | null;
  status: keyof typeof DESC_STATUS_LABELS;
}

/** Structural subset of a loaded dataset row (GET / product shape). */
export interface ExportProduct {
  brand: string;
  collection: string;
  year: number;
  name: string | null;
  family: string | null;
  product_type: string | null;
  diffuser_type: string | null;
  finishes: string[];
  sizes: SizeTuple[];
  cct: string[];
  model_numbers: string[];
  model_bases: string[];
  features: string[];
  content: ExportContent | null;
}

export const DESC_EXPORT_HEADERS = [
  "Brand",
  "Collection",
  "Year",
  "Name",
  "Family",
  "Product Type",
  "Diffuser Type",
  "Finishes",
  "Length",
  "Width",
  "Height",
  "CCT",
  "Model Numbers",
  "Features",
  "Description",
  "HTML Title",
  "Meta Description",
  "Status",
] as const;

/**
 * One axis across the product's size tuples: collapse when uniform, else a
 * tuple-order "; " join with "?" placeholders keeping the columns aligned.
 */
export function sizeAxisCell(
  sizes: readonly SizeTuple[],
  pick: (s: SizeTuple) => string | null,
): string {
  if (sizes.length === 0) return "";
  const values = sizes.map((s) => pick(s)?.trim() || null);
  const distinct = new Set(values);
  if (distinct.size === 1) return values[0] ?? "";
  return values.map((v) => v ?? "?").join("; ");
}

/** One export row (cells ordered per DESC_EXPORT_HEADERS). */
export function exportRow(p: ExportProduct): string[] {
  const c = p.content;
  const description = c?.description_final ?? c?.description_ai ?? "";
  const meta = c?.meta_final ?? c?.meta_ai ?? "";
  // The editor's corrected name wins everywhere: the Name column AND the
  // title formula input (so the Schonbek pattern picks up the fixed name).
  const name = c?.name_override ?? p.name;
  const title =
    c?.title_override ??
    titleFor({
      brand: p.brand,
      collection: p.collection,
      name,
      productType: p.product_type,
      modelBases: p.model_bases,
    });
  return [
    p.brand,
    p.collection,
    String(p.year),
    name ?? "",
    p.family ?? "",
    p.product_type ?? "",
    p.diffuser_type ?? "",
    p.finishes.join(", "),
    sizeAxisCell(p.sizes, (s) => s.length),
    sizeAxisCell(p.sizes, (s) => s.width),
    sizeAxisCell(p.sizes, (s) => s.height),
    p.cct.join(", "),
    p.model_numbers.join(", "),
    p.features.join("\n"),
    description,
    title,
    meta,
    DESC_STATUS_LABELS[c?.status ?? "none"],
  ];
}

/** Header + rows, ready for XLSX.utils.aoa_to_sheet. */
export function buildExportRows(products: readonly ExportProduct[]): string[][] {
  return [[...DESC_EXPORT_HEADERS], ...products.map(exportRow)];
}

/**
 * CSV text (shared toCsv quoting: commas/quotes/newlines round-trip). The
 * caller prepends a UTF-8 BOM when building the download blob so Excel opens
 * it as UTF-8.
 */
export function descriptionsCsv(products: readonly ExportProduct[]): string {
  return toCsv([...DESC_EXPORT_HEADERS], products.map(exportRow));
}
