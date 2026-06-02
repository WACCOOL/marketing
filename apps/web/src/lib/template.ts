import ExcelJS from "exceljs";
import { encodeCampaignValue, type HubspotCampaign } from "@wac/shared";

/**
 * Live controlled vocab used to populate the bulk-import template dropdowns.
 * Mirrors what the UTM Builder offers, so a sheet filled out from the template
 * can only contain values the API will accept.
 */
export interface TemplateVocab {
  source: string[];
  medium: string[];
  content: string[];
  campaigns: HubspotCampaign[];
}

/** Input-sheet column headers, in the order the bulk parser expects. */
const HEADERS = [
  "PROJECT",
  "QR CODE NAME",
  "LINK",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
] as const;

/** How many rows get the dropdown validation applied. */
const VALIDATED_ROWS = 200;

/**
 * Build a blank bulk-import workbook with in-cell dropdowns for the four UTM
 * fields. The dropdown options live on a separate "Reference" sheet and the
 * input columns reference them via Excel data validation.
 *
 * Note: Excel data validation can only insert the literal cell value, so the
 * utm_campaign dropdown lists the *encoded* HubSpot value (e.g.
 * `39174698_hd_expo_2026`) — the exact string the parser validates. The
 * Reference sheet shows the human campaign name beside each encoded value.
 */
export async function buildBulkTemplate(v: TemplateVocab): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "WAC Marketing App";
  wb.created = new Date();

  const ws = wb.addWorksheet("Import");
  const ref = wb.addWorksheet("Reference");

  const campaignValues = v.campaigns.map(encodeCampaignValue);

  // ---- Reference sheet: one column per controlled list. ----
  // Columns: A=utm_source B=utm_medium C=utm_campaign D=utm_content
  //          E=campaign name (human-readable lookup for column C)
  const refColumns: Array<{ header: string; values: string[] }> = [
    { header: "utm_source", values: v.source },
    { header: "utm_medium", values: v.medium },
    { header: "utm_campaign", values: campaignValues },
    { header: "utm_content", values: v.content },
    { header: "campaign name (reference only)", values: v.campaigns.map((c) => c.name) },
  ];
  refColumns.forEach((col, i) => {
    const c = i + 1;
    const headerCell = ref.getCell(1, c);
    headerCell.value = col.header;
    headerCell.font = { bold: true };
    col.values.forEach((val, r) => {
      ref.getCell(r + 2, c).value = val;
    });
    ref.getColumn(c).width = Math.max(18, col.header.length + 2);
  });

  // ---- Import sheet: header + one example row. ----
  ws.addRow([...HEADERS]);
  ws.getRow(1).font = { bold: true };
  HEADERS.forEach((_, i) => {
    ws.getColumn(i + 1).width = 24;
  });
  ws.addRow([
    "HD Expo 2026",
    "HD Expo postcard",
    "https://waclighting.com/",
    v.source[0] ?? "",
    v.medium[0] ?? "",
    campaignValues[0] ?? "",
    v.content[0] ?? "",
  ]);

  // ---- Dropdowns: map each input column to its Reference column range. ----
  const dropdowns: Array<{
    col: string;
    refCol: string;
    count: number;
    optional: boolean;
  }> = [
    { col: "D", refCol: "A", count: v.source.length, optional: false },
    { col: "E", refCol: "B", count: v.medium.length, optional: false },
    { col: "F", refCol: "C", count: campaignValues.length, optional: false },
    { col: "G", refCol: "D", count: v.content.length, optional: true },
  ];
  for (const d of dropdowns) {
    if (d.count === 0) continue;
    const range = `Reference!$${d.refCol}$2:$${d.refCol}$${d.count + 1}`;
    for (let r = 2; r <= VALIDATED_ROWS + 1; r++) {
      ws.getCell(`${d.col}${r}`).dataValidation = {
        type: "list",
        allowBlank: d.optional,
        formulae: [range],
        showErrorMessage: true,
        errorStyle: "stop",
        errorTitle: "Pick a value from the list",
        error: "Use one of the controlled values from the Reference sheet.",
      };
    }
  }

  const buf = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;
  return new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
