/**
 * Descriptions — master-list grouping (plan §3, the load-bearing algorithm).
 *
 * Input is an already-extracted cell matrix per sheet (plain primitives — the
 * browser does the SheetJS work), so this runs identically under vitest and
 * in the client. One output row per PPID group.
 *
 * Three nameModes, verified against the real workbooks:
 * - `alpha`   (Dweled, Schonbek "2027 Beyond (Core)"): forward-fill the Name
 *   column; a new group starts when the case-folded alpha token CHANGES.
 *   Dweled repeats the name on every row; Beyond leaves blanks between names —
 *   both collapse to the same rule.
 * - `hybrid`  (Modern Forms): the Name column is a numeric group counter on
 *   the first row, then blanks, then the real name repeated. A new group
 *   starts when a non-zero counter changes; `0` rows are noise (but may
 *   carry the group's models). Two adjacent groups can legitimately share a
 *   name, so duplicated names get a model-base suffix in the content_key.
 * - `numeric` (Schonbek "2027 Sigfor (Core)", "2028 Beyond"): `No` is filled
 *   on every row, but in 2028 it does NOT always increment between products —
 *   so the boundary is `No` change OR a Temporary-No. base change (strict
 *   regex; the column is polluted with notes like `8'` or `Quote and Sample`).
 */

import {
  HEADER_ROW_INDEX,
  resolveColumns,
  type NameMode,
  type ResolvedColumns,
} from "./headers.js";
import type {
  DescMasterSlot,
  DescVariant,
  ParsedProduct,
  SheetReport,
  SizeTuple,
} from "./schema.js";

export type Cell = string | number | null;
export type CellMatrix = readonly (readonly Cell[])[];

export interface SheetDescriptor {
  sheetName: string;
  /** Stable content_key prefix for this sheet (never row/sheet-index derived). */
  sheetKey: string;
  brand: string;
  collection: string;
  year: number;
  nameMode: NameMode;
  /**
   * Workbook discriminator: at least ONE of these headers (normalized) must
   * be present, else the parse fails with a "wrong workbook" error. Needed
   * because the DWELED and Modern Forms masters share the sheet name
   * "Master Sheet" AND satisfy each other's REQUIRED_HEADERS — without this
   * they silently cross-import. Headers verified unique per workbook.
   * The Schonbek slots are already discriminated by their unique sheet names.
   */
  distinctive?: { header: string; display: string }[];
}

/** Hardcoded sheet → descriptor table (plan §3). */
export const MASTER_SLOT_SHEETS: Record<DescMasterSlot, SheetDescriptor[]> = {
  dweled_master: [
    {
      sheetName: "Master Sheet",
      sheetKey: "dweled",
      brand: "WAC Lighting",
      collection: "Dweled",
      year: 2027,
      nameMode: "alpha",
      distinctive: [
        { header: "tooling note", display: "Tooling Note" },
        { header: "dallas sample qty", display: "Dallas Sample Qty" },
        { header: "ny sample qty", display: "NY Sample Qty" },
      ],
    },
  ],
  mf_master: [
    {
      sheetName: "Master Sheet",
      sheetKey: "mf",
      brand: "Modern Forms",
      // Fans vs Luminaires resolves per group from Product Type/Hierarchy.
      collection: "Luminaires",
      year: 2027,
      nameMode: "hybrid",
      distinctive: [{ header: "for formula use", display: "For Formula Use" }],
    },
  ],
  schonbek_master: [
    {
      sheetName: "2027 Beyond (Core)",
      sheetKey: "beyond-2027",
      brand: "Schonbek",
      collection: "Beyond",
      year: 2027,
      nameMode: "alpha",
    },
    {
      sheetName: "2027 Sigfor (Core)",
      sheetKey: "sigfor-2027",
      brand: "Schonbek",
      collection: "Signature",
      year: 2027,
      nameMode: "numeric",
    },
    {
      sheetName: "2028 Beyond",
      sheetKey: "beyond-2028",
      brand: "Schonbek",
      collection: "Beyond",
      year: 2028,
      nameMode: "numeric",
    },
  ],
};

/** Human labels for the slot cards. */
export const DESC_SLOT_LABELS: Record<string, string> = {
  dweled_master: "DWELED master list (.xlsx)",
  mf_master: "Modern Forms master list (.xlsx)",
  schonbek_master: "Schonbek master list (.xlsx)",
  dweled_pptx: "DWELED introductions deck (.pptx)",
  mf_pdf: "Modern Forms naming PDF",
  schonbek_pdf: "Schonbek Beyond names PDF",
};

/** Consecutive fully-empty rows that terminate the scan. */
const EMPTY_ROW_STOP = 25;
/** Hard row cap — sanity rail against runaway sheets. */
const MAX_ROWS = 20_000;

/** Strict Temporary-No. token: `41QF0303`, `41QF0303-1`, `41TV0606.2` … */
const TEMP_BASE_RE = /^(\d{2}[A-Z]{2}\d{4})(?:[-.][\w.]+)?/;

// ---------------------------------------------------------------------------
// Small pure helpers (exported for tests + reuse)
// ---------------------------------------------------------------------------

/** Render a cell to a trimmed string ("" for null/blank). */
export function cellStr(v: Cell | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    // Excel integers render without a trailing .0; keep decimals as-is.
    return Number.isInteger(v) ? String(v) : String(v);
  }
  return String(v).trim();
}

/** Lowercase slug for content_key segments (alnum + dashes). */
export function slugKey(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Expand a compact model range: `WSW770916/24-BK` → `WSW770916-BK`,
 * `WSW770924-BK` (each slash chunk substitutes the trailing digits of equal
 * length; a trailing finish suffix applies to every expanded model).
 * Unparseable ranges are returned as-is.
 */
export function expandModelRange(raw: string): string[] {
  const s = raw.trim();
  const slash = s.indexOf("/");
  if (slash <= 0) return s ? [s] : [];
  const head = s.slice(0, slash);
  const headMatch = head.match(/^(.*?)(\d+)$/);
  if (!headMatch) return [s];
  const pre = headMatch[1]!;
  const digits = headMatch[2]!;
  const bases = [head];
  let suffix = "";
  for (const part of s.slice(slash + 1).split("/")) {
    const m = part.match(/^(\d+)(.*)$/);
    if (!m) return [s];
    const alt = m[1]!;
    if (m[2]) suffix = m[2];
    if (alt.length > digits.length) return [s];
    bases.push(pre + digits.slice(0, digits.length - alt.length) + alt);
  }
  return bases.map((b) => b + suffix);
}

/**
 * A model's base for matching/relinking: the finish/variant suffix stripped —
 * `WSW660312-BK/VB` → `WSW660312`, `BPD11223O-TWA-AB` → `BPD11223O`.
 */
export function modelBase(model: string): string {
  const m = model.trim().toUpperCase();
  const idx = m.indexOf("-");
  return idx > 0 ? m.slice(0, idx) : m;
}

/** Extract the Temporary-No. base (`41QF0303-1` → `41QF0303`), or null. */
export function tempBaseOf(cell: string): string | null {
  const m = cell.trim().toUpperCase().match(TEMP_BASE_RE);
  return m ? m[1]! : null;
}

type Token = { kind: "blank" | "numeric" | "alpha"; text: string };

function classifyToken(v: Cell | undefined): Token {
  const text = cellStr(v);
  if (!text) return { kind: "blank", text };
  if (/^\d+(\.0+)?$/.test(text)) {
    return { kind: "numeric", text: String(parseInt(text, 10)) };
  }
  return { kind: "alpha", text };
}

// ---------------------------------------------------------------------------
// Row extraction + group scan
// ---------------------------------------------------------------------------

interface RowData {
  rowIndex: number; // 0-based sheet row
  token: Token;
  models: string[]; // expanded model numbers
  tempBase: string | null;
  tempFull: string | null; // full matched Temporary-No. token
  productType: string;
  diffuser: string;
  finish: string;
  length: string;
  width: string;
  height: string;
  cct: string;
  family: string;
  romance: string;
  hierarchy: string;
  featureVals: string[]; // aligned with cols.features
  raw: readonly Cell[];
}

interface Group {
  alphaName: string | null;
  ordinal: string | null; // hybrid counter / numeric `No` token
  tempBase: string | null;
  tempFull: string | null;
  rows: RowData[];
}

function extractRow(
  row: readonly Cell[],
  rowIndex: number,
  cols: ResolvedColumns,
): RowData {
  const at = (i: number | undefined) => (i === undefined ? "" : cellStr(row[i]));
  const modelRaw = at(cols.model);
  const tempCell = at(cols.tempNotes);
  const tempMatch = tempCell
    ? tempCell.trim().toUpperCase().match(TEMP_BASE_RE)
    : null;
  return {
    rowIndex,
    token: classifyToken(cols.name >= 0 ? row[cols.name] : null),
    models: modelRaw ? expandModelRange(modelRaw) : [],
    tempBase: tempMatch ? tempMatch[1]! : null,
    tempFull: tempMatch ? tempMatch[0]! : null,
    productType: at(cols.productType),
    diffuser: at(cols.diffuserType),
    finish: at(cols.finish),
    length: at(cols.length),
    width: at(cols.width),
    height: at(cols.height),
    cct: at(cols.cct),
    family: at(cols.family),
    romance: at(cols.romance),
    hierarchy: at(cols.hierarchy),
    featureVals: cols.features.map((i) => cellStr(row[i])),
    raw: row,
  };
}

function rowIsEmpty(row: readonly Cell[] | undefined): boolean {
  if (!row) return true;
  return row.every((c) => cellStr(c) === "");
}

function scanGroups(
  cells: CellMatrix,
  cols: ResolvedColumns,
  mode: NameMode,
  sheetName: string,
  warnings: string[],
): { groups: Group[]; rows: number } {
  const groups: Group[] = [];
  let cur: Group | null = null;
  let empties = 0;
  let dataRows = 0;

  const push = () => {
    if (cur && cur.rows.length > 0) groups.push(cur);
    cur = null;
  };
  const newGroup = (init: Partial<Group>): Group => ({
    alphaName: null,
    ordinal: null,
    tempBase: null,
    tempFull: null,
    rows: [],
    ...init,
  });

  const end = Math.min(cells.length, MAX_ROWS);
  for (let r = HEADER_ROW_INDEX + 1; r < end; r++) {
    const row = cells[r];
    if (rowIsEmpty(row)) {
      empties++;
      if (empties >= EMPTY_ROW_STOP) break;
      continue;
    }
    empties = 0;
    dataRows++;
    const data = extractRow(row!, r, cols);
    const tok = data.token;

    if (mode === "alpha") {
      if (tok.kind === "alpha") {
        if (!cur || tok.text.toLowerCase() !== cur.alphaName?.toLowerCase()) {
          push();
          cur = newGroup({ alphaName: tok.text });
        }
      } else if (tok.kind === "numeric" && !cur) {
        warnings.push(
          `${sheetName} row ${r + 1}: numeric name "${tok.text}" before any product name`,
        );
        cur = newGroup({ ordinal: tok.text });
      } else if (tok.kind === "blank" && !cur) {
        warnings.push(`${sheetName} row ${r + 1}: data row before any product name; skipped`);
        continue;
      }
      // blank/numeric token with a current group → forward-fill (continue).
    } else if (mode === "hybrid") {
      // Real MF block shapes (verified against the workbook): a counter row
      // (which may or may not carry a model), optional extra model rows,
      // repeated name rows, `0` noise rows (with or without models), and
      // occasional UNNUMBERED blocks that open with a bare model row.
      const hasModel = data.models.length > 0 || data.tempBase !== null;
      const groupComplete =
        cur !== null &&
        cur.alphaName !== null &&
        cur.rows.some((x) => x.models.length > 0);
      if (tok.kind === "numeric") {
        if (!cur) {
          cur = newGroup({ ordinal: tok.text });
        } else if (tok.text === "0") {
          // `0` is always counter noise, never a boundary — but it can carry
          // the group's models when the counter row itself had none.
          if (!hasModel) {
            warnings.push(
              `${sheetName} row ${r + 1}: stray counter "0" without a model; kept in current group`,
            );
          }
        } else if (tok.text !== cur.ordinal) {
          // A real counter change is a boundary even when the counter row
          // carries no model (models can trail on `0`/name rows).
          push();
          cur = newGroup({ ordinal: tok.text });
        }
      } else if (tok.kind === "alpha") {
        if (!cur) {
          warnings.push(
            `${sheetName} row ${r + 1}: name "${tok.text}" before any group counter`,
          );
          cur = newGroup({});
        } else if (
          groupComplete &&
          tok.text.toLowerCase() !== cur.alphaName!.toLowerCase()
        ) {
          // A different name after the group is fully formed (name + models)
          // starts an unnumbered block.
          push();
          cur = newGroup({});
        }
        if (!cur.alphaName) cur.alphaName = tok.text; // first alpha wins
      } else {
        // Blank counter cell.
        if (!cur) {
          warnings.push(`${sheetName} row ${r + 1}: data row before any group; skipped`);
          continue;
        }
        if (hasModel && groupComplete) {
          // Model-first unnumbered block (observed workbook shape): the
          // previous group already has its name and models, so a fresh model
          // row with no counter opens a new group.
          push();
          cur = newGroup({});
        }
      }
    } else {
      // numeric mode: boundary on `No` change OR tempBase base-change.
      const base = data.tempBase;
      if (!cur) {
        cur = newGroup({ ordinal: tok.text || null, tempBase: base, tempFull: data.tempFull });
      } else if (tok.text !== (cur.ordinal ?? "")) {
        push();
        cur = newGroup({ ordinal: tok.text || null, tempBase: base, tempFull: data.tempFull });
      } else if (base && cur.tempBase && base !== cur.tempBase) {
        push();
        cur = newGroup({ ordinal: tok.text || null, tempBase: base, tempFull: data.tempFull });
      }
      if (cur && !cur.tempBase && base) {
        cur.tempBase = base;
        cur.tempFull = data.tempFull;
      }
    }

    cur?.rows.push(data);
  }
  push();
  return { groups, rows: dataRows };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function firstNonEmpty(vals: Iterable<string>): string | null {
  for (const v of vals) if (v) return v;
  return null;
}

function distinct(vals: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of vals) {
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** Structural columns excluded from the attributes.sheet catch-all. */
const STRUCTURAL_KEYS = new Set([
  "name",
  "no",
  "no.",
  "rendering",
  "romance",
]);

function aggregateGroup(
  group: Group,
  desc: SheetDescriptor,
  cols: ResolvedColumns,
  headerRow: readonly Cell[],
  sortOrder: number,
): ParsedProduct {
  const rows = group.rows;
  const models = distinct(rows.flatMap((r) => r.models)).slice(0, 500);
  const bases = distinct(models.map(modelBase));
  if (group.tempBase && !bases.includes(group.tempBase)) bases.push(group.tempBase);

  const sizes: SizeTuple[] = [];
  const sizeSeen = new Set<string>();
  for (const r of rows) {
    if (!r.length && !r.width && !r.height) continue;
    const key = `${r.length} ${r.width} ${r.height}`;
    if (sizeSeen.has(key)) continue;
    sizeSeen.add(key);
    sizes.push({
      length: r.length || null,
      width: r.width || null,
      height: r.height || null,
    });
  }

  const features: string[] = [];
  for (let f = 0; f < cols.features.length && features.length < 8; f++) {
    const v = firstNonEmpty(rows.map((r) => r.featureVals[f] ?? ""));
    if (v) features.push(v.slice(0, 500));
  }

  const variants: DescVariant[] = [];
  for (const r of rows) {
    for (const m of r.models) {
      if (variants.length >= 300) break;
      const size =
        r.length || r.width || r.height
          ? [r.length || "?", r.width || "?", r.height || "?"].join(" × ")
          : null;
      variants.push({
        model: m.slice(0, 80),
        finish: r.finish ? r.finish.slice(0, 120) : null,
        cct: r.cct ? r.cct.slice(0, 120) : null,
        size: size ? size.slice(0, 120) : null,
      });
    }
  }

  // Catch-all: first non-empty value per remaining recognized column.
  const structuralIdx = new Set<number>(
    [
      cols.name,
      cols.productType,
      cols.diffuserType,
      cols.finish,
      cols.length,
      cols.width,
      cols.height,
      cols.cct,
      cols.model,
      cols.family,
      cols.tempNotes,
      cols.romance,
      cols.hierarchy,
      ...cols.features,
    ].filter((i): i is number => i !== undefined && i >= 0),
  );
  const sheet: Record<string, string> = {};
  let sheetKeys = 0;
  for (let cIdx = 0; cIdx < headerRow.length && sheetKeys < 120; cIdx++) {
    const header = cellStr(headerRow[cIdx]);
    if (!header || structuralIdx.has(cIdx)) continue;
    if (STRUCTURAL_KEYS.has(header.toLowerCase())) continue;
    const v = firstNonEmpty(rows.map((r) => cellStr(r.raw[cIdx])));
    if (!v) continue;
    if (header in sheet) continue; // duplicate headers: first wins
    sheet[header] = v.slice(0, 500);
    sheetKeys++;
  }

  const family = firstNonEmpty(rows.map((r) => r.family));
  const productType = firstNonEmpty(rows.map((r) => r.productType));
  const hierarchy = firstNonEmpty(rows.map((r) => r.hierarchy));
  const romance = firstNonEmpty(rows.map((r) => r.romance));

  const name =
    group.alphaName ??
    family ??
    (group.tempBase ? group.tempBase.toUpperCase() : null) ??
    (group.ordinal ? `Item ${group.ordinal}` : null);

  // Modern Forms: fan-vs-luminaire split per group.
  let collection = desc.collection;
  if (desc.sheetKey === "mf") {
    const hay = `${productType ?? ""} ${hierarchy ?? ""}`.toLowerCase();
    collection = hay.includes("fan") ? "Fans" : "Luminaires";
  }

  const attributes: ParsedProduct["attributes"] = {
    variants,
    sheet,
    ...(romance ? { romance: romance.slice(0, 4000) } : {}),
    ...(hierarchy ? { hierarchy: hierarchy.slice(0, 300) } : {}),
  };

  return {
    // content_key finalized in a post-pass (duplicate-name suffixing).
    content_key: "",
    brand: desc.brand,
    collection,
    year: desc.year,
    name: name ? name.slice(0, 200) : null,
    family: family ? family.slice(0, 200) : null,
    product_type: productType ? productType.slice(0, 200) : null,
    diffuser_type: rows.map((r) => r.diffuser).find((v) => v)?.slice(0, 200) ?? null,
    finishes: distinct(rows.map((r) => r.finish)).slice(0, 120),
    sizes: sizes.slice(0, 200),
    cct: distinct(rows.map((r) => r.cct)).slice(0, 60),
    model_numbers: models,
    model_bases: bases.slice(0, 200),
    features,
    attributes,
    source_rows: rows.length,
    sort_order: sortOrder,
  };
}

/**
 * Finalize content_keys for one sheet's groups. Keys are content-derived
 * (never row-index-derived): `sheetKey:name`, with a primary-model-base
 * suffix appended to EVERY member of a duplicated name (name ×2 →
 * `mf:name:wsw660312` / `mf:name:wsw660315`); numeric-identity groups key
 * on the Temporary-No. base (`sigfor-2027:41qf0303`).
 */
function assignContentKeys(
  sheetKey: string,
  groups: Group[],
  products: ParsedProduct[],
  warnings: string[],
  sheetName: string,
): void {
  interface KeyParts {
    base: string;
    disambiguator: string | null;
  }
  const parts: KeyParts[] = groups.map((g, i) => {
    const p = products[i]!;
    const primaryBase = p.model_bases[0] ?? null;
    if (g.alphaName) {
      return {
        base: slugKey(g.alphaName),
        disambiguator: primaryBase ? slugKey(primaryBase) : null,
      };
    }
    if (g.tempBase) {
      // Two products can share a Temporary-No. base (41QF0303-1 vs -9): the
      // token's suffix disambiguates duplicated bases.
      const suffix =
        g.tempFull && g.tempFull !== g.tempBase
          ? slugKey(g.tempFull.slice(g.tempBase.length))
          : "";
      return { base: slugKey(g.tempBase), disambiguator: suffix || null };
    }
    if (primaryBase) return { base: slugKey(primaryBase), disambiguator: null };
    return { base: `no-${slugKey(g.ordinal ?? "x")}`, disambiguator: null };
  });

  const counts = new Map<string, number>();
  for (const k of parts) counts.set(k.base, (counts.get(k.base) ?? 0) + 1);

  const used = new Set<string>();
  parts.forEach((k, i) => {
    let key = `${sheetKey}:${k.base}`;
    if ((counts.get(k.base) ?? 0) > 1 && k.disambiguator) {
      key = `${sheetKey}:${k.base}:${k.disambiguator}`;
    }
    // Last-resort uniqueness (identical name AND base): stable content-derived
    // ordinal within the duplicate set only.
    if (used.has(key)) {
      let n = 2;
      while (used.has(`${key}:${n}`)) n++;
      key = `${key}:${n}`;
      warnings.push(
        `${sheetName}: duplicate identity for "${products[i]!.name ?? k.base}"; suffixed "${key}"`,
      );
    }
    used.add(key);
    products[i]!.content_key = key;
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The sheet-row extent of one PPID group (0-based, inclusive). Drawing
 * anchors map onto groups through these spans (Stage 2 image import) — the
 * spans stay client-side and are never part of the ImportPayload.
 */
export interface GroupRowSpan {
  content_key: string;
  sheet: string;
  startRow: number;
  endRow: number;
}

export type ParseMasterResult =
  | {
      ok: true;
      products: ParsedProduct[];
      warnings: string[];
      sheets: SheetReport[];
      /** One span per product, same order as `products`. */
      spans: GroupRowSpan[];
    }
  | {
      ok: false;
      error: string;
      sheet?: string;
      missing?: string[];
    };

/**
 * Parse a master workbook's extracted cell matrices into PPID groups.
 * `sheetCells` maps sheet name → cell matrix (all rows, including the four
 * pre-header rows). A missing sheet or missing REQUIRED_HEADERS fails loudly.
 */
export function parseMasterWorkbook(
  slot: DescMasterSlot,
  sheetCells: Record<string, CellMatrix>,
): ParseMasterResult {
  const descriptors = MASTER_SLOT_SHEETS[slot];
  const products: ParsedProduct[] = [];
  const warnings: string[] = [];
  const sheets: SheetReport[] = [];
  const spans: GroupRowSpan[] = [];

  for (const desc of descriptors) {
    const cells = sheetCells[desc.sheetName];
    if (!cells) {
      return {
        ok: false,
        error: `missing sheet "${desc.sheetName}"; this doesn't look like the right workbook for this slot`,
        sheet: desc.sheetName,
      };
    }
    const headerRow = cells[HEADER_ROW_INDEX] ?? [];
    const resolved = resolveColumns(headerRow, desc.nameMode);
    if (!resolved.ok) {
      return {
        ok: false,
        error: `missing columns: ${resolved.missing.join(", ")}`,
        sheet: desc.sheetName,
        missing: resolved.missing,
      };
    }
    if (
      desc.distinctive &&
      !desc.distinctive.some((d) => d.header in resolved.headerMap)
    ) {
      const expected = desc.distinctive.map((d) => d.display);
      return {
        ok: false,
        error: `this workbook is missing the slot's distinguishing column${
          expected.length === 1 ? "" : "s"
        } (expected one of: ${expected.join(", ")}); it looks like a different brand's master list`,
        sheet: desc.sheetName,
        missing: expected,
      };
    }
    const { groups, rows } = scanGroups(
      cells,
      resolved.cols,
      desc.nameMode,
      desc.sheetName,
      warnings,
    );
    const sheetProducts = groups.map((g, i) =>
      aggregateGroup(g, desc, resolved.cols, headerRow, products.length + i),
    );
    assignContentKeys(desc.sheetKey, groups, sheetProducts, warnings, desc.sheetName);
    products.push(...sheetProducts);
    groups.forEach((g, i) => {
      spans.push({
        content_key: sheetProducts[i]!.content_key,
        sheet: desc.sheetName,
        startRow: g.rows[0]!.rowIndex,
        endRow: g.rows[g.rows.length - 1]!.rowIndex,
      });
    });
    sheets.push({ sheet: desc.sheetName, rows, groups: groups.length });
  }

  if (products.length === 0) {
    return { ok: false, error: "no product rows found below the header row" };
  }
  return { ok: true, products, warnings, sheets, spans };
}
