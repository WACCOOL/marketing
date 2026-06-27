import { asString, field } from "./headers.js";

/**
 * Customer Risk Codes legend parser — the "Customer Risk Codes" tab of the daily
 * SAP "Open Orders Master" workbook maps each risk code to a concise
 * `Code Description` and a longer `Meaning` (policy text). The header is on the
 * first row, so the caller passes rows straight from `sheet_to_json` (no range
 * offset, unlike the Report sheet).
 *
 * Codes are a mix of numeric (100–999) and string (COD, INA, POF, …) and can
 * carry stray whitespace ("EOF "); we trim the code so it joins cleanly to the
 * Report sheet's `Risk Code` (also trimmed at push time). Rows without a code are
 * skipped; on a duplicate code the last occurrence wins.
 */

export interface RiskCodeRow {
  /** SAP Risk Code, trimmed (e.g. "102", "COD"). */
  code: string;
  /** Concise label (e.g. "Poor Payer"); null when blank. */
  codeDescription: string | null;
  /** Longer policy text; null when blank. */
  meaning: string | null;
}

export function parseRiskCodes(rows: Record<string, unknown>[]): RiskCodeRow[] {
  const byCode = new Map<string, RiskCodeRow>();
  for (const raw of rows) {
    const code = asString(field(raw, "Risk Code"));
    if (!code) continue; // skip blank / separator rows
    byCode.set(code, {
      code,
      codeDescription: asString(field(raw, "Code Description")) || null,
      meaning: asString(field(raw, "Meaning")) || null,
    });
  }
  return [...byCode.values()];
}
