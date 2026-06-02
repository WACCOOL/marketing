import { z } from "zod";
import { buildTaggedUrl, type UtmFields } from "./utm.js";

/**
 * Normalised representation of one row from the existing UTM Generator.xlsx
 * sheet. Column headers in the source file are typically:
 *   PROJECT | QR CODE NAME | LINK | utm_source | utm_medium | utm_campaign | utm_content
 */
export const BulkInputRowSchema = z.object({
  project: z.string().trim().optional().default(""),
  qrName: z.string().trim().min(1, "QR Code Name is required"),
  link: z.string().trim().url("LINK must be a valid URL"),
  source: z.string().trim().min(1, "utm_source is required"),
  medium: z.string().trim().min(1, "utm_medium is required"),
  campaign: z.string().trim().min(1, "utm_campaign is required"),
  content: z.string().trim().optional().default(""),
});
export type BulkInputRow = z.infer<typeof BulkInputRowSchema>;

/**
 * Column-name map: the existing sheet uses uppercase/mixed-case headers, while
 * users may name their columns differently. Be forgiving on header matching.
 */
const HEADER_ALIASES: Record<keyof BulkInputRow, string[]> = {
  project: ["project"],
  qrName: ["qr code name", "qr_code_name", "qrname", "qr name"],
  link: ["link", "destination", "url", "destination url", "website url"],
  source: ["utm_source", "source"],
  medium: ["utm_medium", "medium"],
  campaign: ["utm_campaign", "campaign"],
  content: ["utm_content", "content"],
};

export function normalizeHeaderRow(headers: string[]): Record<string, keyof BulkInputRow> {
  const map: Record<string, keyof BulkInputRow> = {};
  for (const raw of headers) {
    const lc = raw.trim().toLowerCase();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES) as Array<
      [keyof BulkInputRow, string[]]
    >) {
      if (aliases.includes(lc)) {
        map[raw] = field;
        break;
      }
    }
  }
  return map;
}

export interface BulkRowResult {
  ok: boolean;
  row: BulkInputRow | null;
  errors: string[];
  taggedUrl?: string;
  rowIndex: number;
}

export function processBulkRow(
  rawRow: Record<string, unknown>,
  rowIndex: number,
): BulkRowResult {
  const parsed = BulkInputRowSchema.safeParse(rawRow);
  if (!parsed.success) {
    return {
      ok: false,
      row: null,
      rowIndex,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }

  const fields: UtmFields = {
    source: parsed.data.source,
    medium: parsed.data.medium,
    campaign: parsed.data.campaign,
    ...(parsed.data.content ? { content: parsed.data.content } : {}),
  };

  try {
    const taggedUrl = buildTaggedUrl(parsed.data.link, fields);
    return {
      ok: true,
      row: parsed.data,
      rowIndex,
      taggedUrl,
      errors: [],
    };
  } catch (e) {
    return {
      ok: false,
      row: parsed.data,
      rowIndex,
      errors: [e instanceof Error ? e.message : String(e)],
    };
  }
}

/**
 * The header row of the dynamic-QR platform import template (per the PRD —
 * "QR Name (mandatory) | Website URL | Add to Watchlist | Folder").
 *
 * This export is for migration / parallel-running with the existing tool, even
 * though we run our own short-link service.
 */
export const DYNAMIC_QR_EXPORT_HEADERS = [
  "QR Name (mandatory)",
  "Website URL",
  "Add to Watchlist",
  "Folder",
] as const;

export interface DynamicQrExportRow {
  qrName: string;
  websiteUrl: string;
  addToWatchlist: "Yes" | "No";
  folder: string;
}

export function toDynamicQrExportRow(opts: {
  qrName: string;
  shortLink: string;
  folder?: string;
}): DynamicQrExportRow {
  return {
    qrName: opts.qrName,
    websiteUrl: opts.shortLink,
    addToWatchlist: "No",
    folder: opts.folder ?? "",
  };
}
