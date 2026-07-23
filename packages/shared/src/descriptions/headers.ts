/**
 * Descriptions — master-list header resolution.
 *
 * All three master workbooks (DWELED, Modern Forms, Schonbek) share the same
 * skeleton: headers on sheet row 4 (0-based index 3), data from row 5. Column
 * names drift slightly between books ("Length (in)" vs "Length"), so each
 * canonical field resolves through a candidate list: exact normalized match
 * first, then a prefix/contains fallback. REQUIRED_HEADERS hard-fails the
 * parse with the *named* missing columns — the guard against a future column
 * reshuffle silently mis-importing (see plan §3.1).
 */

export type NameMode = "alpha" | "hybrid" | "numeric";

/** 0-based row index of the header row (sheet row 4). */
export const HEADER_ROW_INDEX = 3;

/** Normalize a header cell: collapse newlines/whitespace, trim, lowercase. */
export function normalizeHeader(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).replace(/\s+/g, " ").trim().toLowerCase();
}

/** Canonical column fields the parser consumes. */
export interface ResolvedColumns {
  /** The grouping column: `Name` (alpha/hybrid) or `No` (numeric). */
  name: number;
  productType?: number;
  diffuserType?: number;
  finish?: number;
  length?: number;
  width?: number;
  height?: number;
  cct?: number;
  model?: number;
  family?: number;
  /** `Temporary No./Notes` — the numeric-mode identity column. */
  tempNotes?: number;
  romance?: number;
  hierarchy?: number;
  /** Column indices of `Feature # 1..8`, in feature order (gaps skipped). */
  features: number[];
}

interface FieldSpec {
  /** Exact normalized-header candidates, in preference order. */
  exact: string[];
  /** Fallback: header must start with / contain one of these. */
  contains?: string[];
}

const FIELDS: Record<keyof Omit<ResolvedColumns, "features" | "name">, FieldSpec> = {
  productType: { exact: ["product type"] },
  diffuserType: { exact: ["diffuser type"], contains: ["diffuser"] },
  finish: { exact: ["finish"], contains: ["finish"] },
  length: { exact: ["length (in)", "length"], contains: ["length"] },
  width: { exact: ["width (in)", "width"], contains: ["width"] },
  height: { exact: ["height (in)", "height"], contains: ["height"] },
  cct: { exact: ["led color temp", "cct"], contains: ["color temp"] },
  model: { exact: ["model no.", "model no"], contains: ["model no"] },
  family: { exact: ["family name"], contains: ["family"] },
  tempNotes: { exact: ["temporary no./notes"], contains: ["temporary"] },
  romance: { exact: ["romance"] },
  hierarchy: { exact: ["product hierarchy"], contains: ["hierarchy"] },
};

/** Human names used in the "missing columns" error, per required field. */
const REQUIRED_LABELS = {
  name: "Name",
  no: "No",
  productType: "Product Type",
  finish: "Finish",
  model: "Model No.",
  tempNotes: "Temporary No./Notes",
} as const;

/** Required canonical fields per nameMode (plan §3.1). */
export function requiredHeaders(mode: NameMode): string[] {
  if (mode === "numeric") {
    return [
      REQUIRED_LABELS.no,
      REQUIRED_LABELS.productType,
      REQUIRED_LABELS.finish,
      REQUIRED_LABELS.tempNotes,
    ];
  }
  return [
    REQUIRED_LABELS.name,
    REQUIRED_LABELS.productType,
    REQUIRED_LABELS.finish,
    REQUIRED_LABELS.model,
  ];
}

export type ResolveResult =
  | { ok: true; cols: ResolvedColumns; headerMap: Record<string, number> }
  | { ok: false; missing: string[] };

/**
 * Resolve the canonical columns from a raw header row. Duplicate headers
 * resolve first-wins (Schonbek repeats `IOQ` etc.).
 */
export function resolveColumns(
  headerRow: readonly unknown[],
  mode: NameMode,
): ResolveResult {
  const map: Record<string, number> = {};
  headerRow.forEach((cell, i) => {
    const norm = normalizeHeader(cell);
    if (norm && !(norm in map)) map[norm] = i;
  });
  const keys = Object.keys(map);

  const find = (spec: FieldSpec): number | undefined => {
    for (const cand of spec.exact) {
      if (cand in map) return map[cand];
    }
    for (const frag of spec.contains ?? []) {
      const hit = keys.find((k) => k.includes(frag));
      if (hit !== undefined) return map[hit];
    }
    return undefined;
  };

  // Grouping column: `Name` for alpha/hybrid, `No` for numeric. Numeric sheets
  // headed `No` must not accidentally satisfy an alpha sheet's `Name` (and
  // vice versa) — exact matches only.
  const nameIdx =
    mode === "numeric" ? (map["no"] ?? map["no."]) : map["name"];

  const cols: ResolvedColumns = {
    name: nameIdx ?? -1,
    features: [],
  };
  for (const key of Object.keys(FIELDS) as (keyof typeof FIELDS)[]) {
    const idx = find(FIELDS[key]);
    if (idx !== undefined) cols[key] = idx;
  }
  for (let i = 1; i <= 8; i++) {
    const idx =
      map[`feature # ${i}`] ?? map[`feature #${i}`] ?? map[`feature ${i}`];
    if (idx !== undefined) cols.features.push(idx);
  }

  const missing: string[] = [];
  if (nameIdx === undefined) {
    missing.push(mode === "numeric" ? REQUIRED_LABELS.no : REQUIRED_LABELS.name);
  }
  if (cols.productType === undefined) missing.push(REQUIRED_LABELS.productType);
  if (cols.finish === undefined) missing.push(REQUIRED_LABELS.finish);
  if (mode === "numeric") {
    if (cols.tempNotes === undefined) missing.push(REQUIRED_LABELS.tempNotes);
  } else if (cols.model === undefined) {
    missing.push(REQUIRED_LABELS.model);
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, cols, headerMap: map };
}
