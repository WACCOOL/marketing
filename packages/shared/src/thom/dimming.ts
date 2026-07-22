// =============================================================================
// Dimming-compatibility pure logic (docs/thom-dimming-compat-plan.md v2,
// ledger DC1–DC15). Everything here is pure and unit-tested: the extraction
// schema (zod twin of the forced-tool contract), normalization (qualifier
// strip -> hyphen fix -> case/space collapse, in THAT order — DC2),
// slash-expansion of related-model shorthand (DC8), the conservative status
// derivation (DC1: null low-end can NEVER derive tested_compatible), report
// code derivation from zip entry filenames (DC9), bounded fuzzy dimmer-model
// ranking (DC10), and the stratified verification sampler (DC5).
//
// I/O lives in apps/docs-ingest/src/dimming.ts (extraction runner) and
// ./dimmingTools.ts (the two chat tools).
// =============================================================================

import { z } from "zod";

/** Bump on any schema/prompt/derivation fix: `--dimming` re-processes active
 *  units whose stored version < current (plan §B.4). */
export const DIMMING_EXTRACTION_VERSION = 1;

/** kb_documents doc_type for captured dimming charts. These rows are NEVER
 *  chunked/embedded (DC7 — Step B excludes them at the SQL level). */
export const DIMMING_REPORT_DOC_TYPE = "dimming_report";

/** Default extracting model (env-overridable in the runner; the id used is
 *  recorded per unit — DC11). */
export const DEFAULT_DIMMING_EXTRACTION_MODEL = "claude-sonnet-4-5";
/** Default verifier model — Haiku-tier by default: cheaper and more
 *  independent than "different framing" on the same model (DC5). */
export const DEFAULT_DIMMING_VERIFIER_MODEL = "claude-haiku-4-5";

export type DimmingPhaseType = "adaptive" | "elv" | "triac" | "zero_to_ten_v" | "other";
export type DimmingModeQualifier = "elv" | "triac";
export type DimmingRowStatus =
  | "tested_compatible"
  | "not_recommended"
  | "not_compatible"
  | "tested_issue";

export const DIMMING_PHASE_TYPES: readonly DimmingPhaseType[] = [
  "adaptive",
  "elv",
  "triac",
  "zero_to_ten_v",
  "other",
];

/** Human phrasing for a phase type, used verbatim in tool answers. */
export function phaseTypeLabel(p: DimmingPhaseType): string {
  switch (p) {
    case "adaptive":
      return "Adaptive phase";
    case "elv":
      return "Reverse phase (ELV)";
    case "triac":
      return "Forward phase (TRIAC)";
    case "zero_to_ten_v":
      return "0-10V";
    default:
      return "Other control";
  }
}

// -----------------------------------------------------------------------------
// Extraction schema — the zod twin of the forced-tool output contract.
// -----------------------------------------------------------------------------

export const extractedDimmingRowSchema = z.object({
  /** 1-based page the row appears on — drives the per-section-per-page
   *  stratified verification sample (DC5). Not persisted. */
  page: z.number().int().min(1),
  /** Verbatim section header band the row sits under. */
  section_header: z.string(),
  manufacturer: z.string(),
  dimmer_series: z.string().nullable(),
  /** Verbatim, parenthetical included ("Adorne Touch (ELV)"). The mode
   *  qualifier is parsed in CODE, never by the model (DC2). */
  dimmer_model: z.string(),
  /** 2025-era "Mfr. Related Models" column cells, verbatim (may carry slash
   *  shorthand or a bare "-" placeholder — normalized in code, DC8). */
  related_dimmer_models: z.array(z.string()).default([]),
  /** Section-derived phase bucket (the model maps the section header; code
   *  re-derives it from section_header as a cross-check). */
  phase_type: z.enum(["adaptive", "elv", "triac", "zero_to_ten_v", "other"]),
  /** TEXT, not numeric — "120-277" exists (DC12). */
  test_voltage: z.string(),
  /** Measured low end %; null when the chart says N/A. */
  low_end_pct: z.number().nullable(),
  comments: z.string().default(""),
});
export type ExtractedDimmingRow = z.infer<typeof extractedDimmingRowSchema>;

export const extractedDimmingReportSchema = z.object({
  /** Chart's own ID ("WAC-S2"); NULL for 2018-era bodies that carry only
   *  "ID V0" (DC9 — derived from the filename downstream). */
  report_code: z.string().nullable(),
  product_family: z.string(),
  skus_tested: z.array(z.string()).default([]),
  /** Verbatim wildcard patterns from the header ("DS-CD05-*"). */
  related_model_patterns: z.array(z.string()).default([]),
  test_voltage_range: z.string().nullable(),
  control_types: z.array(z.string()).default([]),
  /** Header notes incl. the 2025-era firmware line ("CPU SCM: 03.56 ..."). */
  test_notes: z.string().nullable(),
  rows: z.array(extractedDimmingRowSchema),
});
export type ExtractedDimmingReport = z.infer<typeof extractedDimmingReportSchema>;

/** The forced-tool input schema (JSON Schema) whose shape IS the output
 *  contract — mirrors the zod twin above; the runner validates the model's
 *  tool input through extractedDimmingReportSchema. */
export const DIMMING_EXTRACTION_TOOL = {
  name: "record_dimming_chart",
  description:
    "Record every data row of this WAC dimming-compatibility chart exactly as printed. " +
    "One entry per printed table row. Do not invent, merge, or normalize values.",
  input_schema: {
    type: "object",
    properties: {
      report_code: {
        type: ["string", "null"],
        description:
          "The chart's own report ID next to 'ID' in the header (e.g. 'WAC-S2'). null when the header shows only a bare version like 'V0'.",
      },
      product_family: { type: "string", description: "Product family named in the header." },
      skus_tested: {
        type: "array",
        items: { type: "string" },
        description: "The exact SKU(s) listed as tested in the header.",
      },
      related_model_patterns: {
        type: "array",
        items: { type: "string" },
        description:
          "Every related-model wildcard pattern from the header, verbatim (e.g. 'DS-CD05-*').",
      },
      test_voltage_range: { type: ["string", "null"] },
      control_types: { type: "array", items: { type: "string" } },
      test_notes: {
        type: ["string", "null"],
        description:
          "Other header notes verbatim, INCLUDING any firmware line (e.g. 'CPU SCM: 03.56 ...').",
      },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, description: "PDF page the row appears on." },
            section_header: {
              type: "string",
              description:
                "The section band this row sits under, verbatim (e.g. 'Adaptive Phase Dimmers', 'Forward Phase Dimmers (TRIAC) Cont.').",
            },
            manufacturer: { type: "string" },
            dimmer_series: { type: ["string", "null"] },
            dimmer_model: {
              type: "string",
              description:
                "Model number cell VERBATIM, including any parenthetical like '(ELV)' or '(TRIAC)'.",
            },
            related_dimmer_models: {
              type: "array",
              items: { type: "string" },
              description:
                "Related-models cells verbatim when the layout has that column; [] otherwise. Keep slash shorthand and '-' placeholders as printed.",
            },
            phase_type: {
              type: "string",
              enum: ["adaptive", "elv", "triac", "zero_to_ten_v", "other"],
              description:
                "Bucket of the SECTION the row sits under (not of any per-row parenthetical): adaptive, elv (reverse phase), triac (forward phase), zero_to_ten_v (0-10V), other (e.g. app-based sections).",
            },
            test_voltage: {
              type: "string",
              description: "Test voltage cell as printed ('120', '277', '120-277').",
            },
            low_end_pct: {
              type: ["number", "null"],
              description: "Measured low end % as a number; null when the cell reads N/A.",
            },
            comments: { type: "string", description: "Comments cell verbatim; '' when blank." },
          },
          required: [
            "page",
            "section_header",
            "manufacturer",
            "dimmer_series",
            "dimmer_model",
            "phase_type",
            "test_voltage",
            "low_end_pct",
            "comments",
          ],
        },
      },
    },
    required: ["report_code", "product_family", "skus_tested", "related_model_patterns", "rows"],
  },
} as const;

// -----------------------------------------------------------------------------
// Normalization. ORDER MATTERS (DC2): strip the mode-qualifier parenthetical
// FIRST — a naive "collapse spaces in model codes" would fuse
// "ADTP703TU (ELV)" into a garbage key.
// -----------------------------------------------------------------------------

/** U+2010 HYPHEN / U+2011 NON-BREAKING HYPHEN (the charts' text layer uses
 *  U+2010: `NTELV‐600`, `DS‐CD05‐*`) -> ASCII '-'. */
export function normalizeHyphens(s: string): string {
  return s.replace(/[‐‑]/g, "-");
}

const QUALIFIER_RE = /\(\s*(elv|triac)\s*\)/i;

/** Parse and strip the per-row (ELV)/(TRIAC) parenthetical. Returns the
 *  qualifier (null when absent) and the cell text WITHOUT it. */
export function parseModeQualifier(cell: string): {
  text: string;
  qualifier: DimmingModeQualifier | null;
} {
  const m = cell.match(QUALIFIER_RE);
  if (!m) return { text: cell.trim(), qualifier: null };
  const qualifier = m[1]!.toLowerCase() as DimmingModeQualifier;
  return { text: cell.replace(QUALIFIER_RE, " ").replace(/\s+/g, " ").trim(), qualifier };
}

/** Build the match key for a dimmer model cell: qualifier stripped FIRST,
 *  hyphens fixed, spaces/periods dropped, uppercased. Original text is
 *  preserved elsewhere for display. */
export function normalizeDimmerModel(cell: string): string {
  const { text } = parseModeQualifier(cell);
  return normalizeHyphens(text).replace(/[\s.]+/g, "").toUpperCase();
}

/**
 * Expand one related-models cell (DC8):
 *  - bare "-" placeholder cells are dropped (return []);
 *  - slash shorthand shares the prefix up to the last '-' of the FIRST model:
 *    "AYCL-153P/253P" -> ["AYCL-153P", "AYCL-253P"];
 *    "HQRD-6ND/10D"   -> ["HQRD-6ND", "HQRD-10D"];
 *  - an alternative that itself contains '-' is a complete model of its own.
 * Returns display-form strings (hyphens normalized, trimmed).
 */
export function expandRelatedModels(cell: string): string[] {
  const raw = normalizeHyphens(cell).trim();
  if (!raw || raw === "-") return [];
  const parts = raw.split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return parts;
  const first = parts[0]!;
  const lastDash = first.lastIndexOf("-");
  const prefix = lastDash >= 0 ? first.slice(0, lastDash + 1) : "";
  const out = [first];
  for (const alt of parts.slice(1)) {
    if (alt === "-") continue;
    out.push(alt.includes("-") || !prefix ? alt : prefix + alt);
  }
  return out;
}

/** Expand + normalize a set of related-model cells into match keys. */
export function normalizeRelatedModels(cells: readonly string[]): string[] {
  const out: string[] = [];
  for (const cell of cells) {
    for (const m of expandRelatedModels(cell)) {
      const norm = normalizeDimmerModel(m);
      if (norm && !out.includes(norm)) out.push(norm);
    }
  }
  return out;
}

/** Convert a header wildcard pattern to its normalized LIKE form: U+2010 ->
 *  '-', uppercase, '*' -> '%' (DC8 — the text layer's patterns carry U+2010:
 *  `DS‐CD05‐*`). */
export function patternToLike(pattern: string): string {
  return normalizeHyphens(pattern).trim().toUpperCase().replace(/\*/g, "%");
}

/** A LIKE pattern as an anchored RegExp over an uppercased SKU. */
export function likeToRegExp(like: string): RegExp {
  const escaped = like.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** Does a SKU (any case, possibly with U+2010 hyphens) match any of the
 *  normalized LIKE patterns? */
export function skuMatchesLikes(sku: string, likes: readonly string[]): boolean {
  const norm = normalizeHyphens(sku).trim().toUpperCase();
  if (!norm) return false;
  return likes.some((l) => likeToRegExp(l).test(norm));
}

/** Derive the report code from a zip entry filename when the PDF body carries
 *  none (DC9): basename without extension ("5in Tube and Cube/E1801063-1_25W.pdf"
 *  -> "E1801063-1_25W"). */
export function reportCodeFromEntryPath(entryPath: string): string {
  const base = entryPath.split("/").pop() ?? entryPath;
  return base.replace(/\.pdf$/i, "");
}

/** Re-derive the phase bucket from a verbatim section header — the code-side
 *  cross-check of the model's phase_type, and the verifier's section mapping. */
export function phaseFromSectionHeader(header: string): DimmingPhaseType {
  const h = header.toLowerCase();
  if (/adaptive/.test(h)) return "adaptive";
  if (/reverse|(^|[^a-z])elv([^a-z]|$)/.test(h)) return "elv";
  if (/forward|triac/.test(h)) return "triac";
  if (/0\s*[-‐‑]?\s*10\s*v/.test(h)) return "zero_to_ten_v";
  return "other";
}

// -----------------------------------------------------------------------------
// Status derivation (DC1 — in CODE, never by the model; conservative default).
// -----------------------------------------------------------------------------

const NOT_RECOMMENDED_RE = /not\s+recommended/i;

/** Null-low-end comments that mean the dimmer does not function at all. */
export const NOT_COMPATIBLE_COMMENT_RES: readonly RegExp[] = [
  /not\s+responsive/i,
  /does\s+not\s+find\s+appropriate\s+load/i,
  /phase\s+control\s+not\s+supported/i,
];

/** KNOWN issue vocabulary for null-low-end rows (from the audited corpus).
 *  Anything OUTSIDE this list still derives tested_issue (conservative), but
 *  is surfaced in the run report for Davis's vocabulary review before rows
 *  activate (DC1, §G.3). */
export const KNOWN_ISSUE_COMMENT_RES: readonly RegExp[] = [
  /flashing\s+at\s+all\s+dimming\s+levels/i,
  /flashing\s+at\s+high\s+dimming\s+level/i,
  /flash\s+when\s+switched\s+on\s+at\s+maximum/i,
  /not\s+rated\s+for\s+led/i,
  /toggle\s+on\/?off\s+not\s+functional/i,
  /follow\s+dimmer\s+wiring\s+without\s+relay/i,
  /flicker/i,
];

export interface DerivedRowStatus {
  status: DimmingRowStatus;
  /** True when a null-low-end classification came from OUTSIDE the known
   *  vocabulary — collected into the run report for human review (DC1). */
  unknownVocabulary: boolean;
}

/**
 * The four-value conservative derivation (DC1):
 *  1. "Not Recommended" anywhere in comments -> not_recommended.
 *  2. null low end + a known non-function comment -> not_compatible.
 *  3. null low end otherwise -> tested_issue. A null low end can NEVER derive
 *     tested_compatible (hard rule — the real charts carry
 *     `HRD-5NE, 120V, N/A, "Flashing at all dimming levels"`).
 *  4. numeric low end + no "Not Recommended" -> tested_compatible (blank
 *     comment + numeric low end = compatible-as-tested is faithful to the
 *     chart; we still never invent the words "Compatible"/"Recommended").
 */
export function deriveRowStatus(lowEndPct: number | null, comments: string): DerivedRowStatus {
  const c = (comments ?? "").trim();
  if (NOT_RECOMMENDED_RE.test(c)) return { status: "not_recommended", unknownVocabulary: false };
  if (lowEndPct === null || lowEndPct === undefined || Number.isNaN(lowEndPct)) {
    if (NOT_COMPATIBLE_COMMENT_RES.some((re) => re.test(c))) {
      return { status: "not_compatible", unknownVocabulary: false };
    }
    const known = c === "" ? false : KNOWN_ISSUE_COMMENT_RES.some((re) => re.test(c));
    // Blank-comment null-low-end is tested_issue too — and flagged for review:
    // the chart said N/A without saying why.
    return { status: "tested_issue", unknownVocabulary: !known };
  }
  return { status: "tested_compatible", unknownVocabulary: false };
}

/** Human phrasing for a derived status, used verbatim in tool answers. The
 *  charts never say "Compatible"/"Recommended" and neither do we. */
export function statusLabel(s: DimmingRowStatus): string {
  switch (s) {
    case "tested_compatible":
      return "tested compatible";
    case "not_recommended":
      return "Not Recommended";
    case "not_compatible":
      return "not compatible";
    default:
      return "tested with issues, see the chart's comment";
  }
}

// -----------------------------------------------------------------------------
// Bounded fuzzy dimmer-model matching (DC10).
// -----------------------------------------------------------------------------

/** Finish/packaging suffix tokens commonly appended to dimmer models. */
const FINISH_SUFFIX_RE = /^[A-Z]{1,2}$/;

/**
 * Reduce a normalized model toward its base: drop a trailing 1–2 letter
 * finish token (`DVCL-153P-WH` -> `DVCL-153P`), then trim trailing letters
 * after the numeric block of the last token down to one (`DVCL-153PD` and
 * `DVCL-153PH` both -> `DVCL-153P`; `HQRD-6ND` -> `HQRD-6N`). The manufacturer
 * prefix token is always preserved, so `AYCL-153P` can never collide with
 * `DVCL-153P` (the DC10 cross-manufacturer junk guard).
 */
export function baseDimmerModel(norm: string): string {
  const tokens = norm.split("-").filter(Boolean);
  if (!tokens.length) return norm;
  if (tokens.length > 1 && FINISH_SUFFIX_RE.test(tokens[tokens.length - 1]!)) tokens.pop();
  const last = tokens[tokens.length - 1]!;
  const m = last.match(/^(.*\d)([A-Z]+)$/);
  if (m && m[2]!.length > 1) tokens[tokens.length - 1] = m[1]! + m[2]![0]!;
  return tokens.join("-");
}

/** Split a user dimmer query into an optional manufacturer (when the user
 *  names one that exists in the corpus) and the model part. */
export function splitDimmerQuery(
  query: string,
  knownManufacturers: readonly string[],
): { manufacturer: string | null; modelQuery: string } {
  const q = query.trim();
  const lower = q.toLowerCase();
  // Longest-first so "Cooper Lighting" style names win over prefixes.
  const sorted = [...knownManufacturers].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const m of sorted) {
    const ml = m.toLowerCase();
    if (lower === ml) return { manufacturer: m, modelQuery: "" };
    if (lower.startsWith(ml + " ")) {
      return { manufacturer: m, modelQuery: q.slice(m.length).trim() };
    }
  }
  return { manufacturer: null, modelQuery: q };
}

/** Reduce a free-text dimmer query to its MODEL part: when any word carries a
 *  digit, leading digit-less words (manufacturer / series names — "Lutron
 *  Diva DVCL-153P", "Caseta PD-5NE") are dropped; a fully alphabetic query
 *  ("Adorne Touch") is kept whole. */
export function dimmerModelPart(query: string): string {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const firstDigit = words.findIndex((w) => /\d/.test(w));
  if (firstDigit <= 0) return words.join(" ");
  return words.slice(firstDigit).join(" ");
}

export type DimmerMatchTier = "exact" | "related" | "base" | "contains";

export interface DimmerMatchCandidate {
  manufacturer: string;
  dimmer_model_norm: string;
  related_dimmer_models_norm: readonly string[];
}

export interface DimmerMatch<T extends DimmerMatchCandidate> {
  row: T;
  tier: DimmerMatchTier;
}

/** Is the contains tier even allowed for this query? Minimum 6 chars including
 *  at least one digit (DC10 — the corpus is dense with shared fragments). */
export function containsTierAllowed(modelNorm: string): boolean {
  return modelNorm.length >= 6 && /\d/.test(modelNorm);
}

/** Token-anchored containment: the query must match starting at a '-' token
 *  boundary of the row's normalized model — never mid-token ("153" may not
 *  hit MACL-153M / DVCL-153P / AYCL-153PH across manufacturers). */
export function tokenAnchoredContains(rowNorm: string, queryNorm: string): boolean {
  const tokens = rowNorm.split("-");
  for (let i = 0; i < tokens.length; i++) {
    const suffix = tokens.slice(i).join("-");
    if (suffix.startsWith(queryNorm)) return true;
  }
  return false;
}

/**
 * Rank candidate rows for a user dimmer query (DC10 — bounded tiers):
 *  1. exact `dimmer_model_norm` match;
 *  2. exact match within `related_dimmer_models_norm` (slash-expanded forms);
 *  3. base-model reduction equality (suffix variants — ALWAYS labeled
 *     "closest tested model", never presented as an exact test result);
 *  4. token-anchored contains, only for queries >= 6 chars with a digit.
 * When the user names a manufacturer, rows must co-match it (all tiers).
 */
export function rankDimmerMatches<T extends DimmerMatchCandidate>(
  query: string,
  rows: readonly T[],
): DimmerMatch<T>[] {
  const manufacturers = [...new Set(rows.map((r) => r.manufacturer).filter(Boolean))];
  const { manufacturer, modelQuery } = splitDimmerQuery(query, manufacturers);
  const queryNorm = normalizeDimmerModel(dimmerModelPart(modelQuery || query));
  if (!queryNorm) return [];
  const pool = manufacturer
    ? rows.filter((r) => r.manufacturer.toLowerCase() === manufacturer.toLowerCase())
    : rows;

  const out: DimmerMatch<T>[] = [];
  const seen = new Set<T>();
  const take = (row: T, tier: DimmerMatchTier) => {
    if (seen.has(row)) return;
    seen.add(row);
    out.push({ row, tier });
  };

  for (const r of pool) if (r.dimmer_model_norm === queryNorm) take(r, "exact");
  for (const r of pool) {
    if (r.related_dimmer_models_norm.includes(queryNorm)) take(r, "related");
  }
  const queryBase = baseDimmerModel(queryNorm);
  for (const r of pool) {
    if (baseDimmerModel(r.dimmer_model_norm) === queryBase) take(r, "base");
  }
  if (containsTierAllowed(queryNorm)) {
    for (const r of pool) {
      if (tokenAnchoredContains(r.dimmer_model_norm, queryNorm)) take(r, "contains");
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Stratified verification sampling (DC5).
// -----------------------------------------------------------------------------

export interface VerifiableRow {
  page: number;
  section_header: string;
  phase_type: DimmingPhaseType;
  manufacturer: string;
  dimmer_model: string;
  mode_qualifier: DimmingModeQualifier | null;
  dimmer_model_norm: string;
  test_voltage: string;
  low_end_pct: number | null;
  comments: string;
}

export interface VerificationSection {
  page: number;
  phase_type: DimmingPhaseType;
  section_header: string;
  rowCount: number;
  /** The sampled row for this section, or null when every row in the section
   *  is ambiguous (duplicate key even after qualifier disambiguation). */
  sample: VerifiableRow | null;
}

/**
 * At least one row per section per page (DC5 — random N=3 systematically
 * under-samples page-2 bands like "Forward Phase Dimmers (TRIAC) Cont." and
 * "0-10V Dimmers"). Rows whose (model, voltage) key is duplicated in the unit
 * are skipped unless the mode qualifier disambiguates them — never asked
 * ambiguously ("ADTH700RMTUM1 at 120V" matches TWO rows in the 2018 layout).
 * Deterministic (middle eligible row) so runs are reproducible.
 */
export function pickVerificationSamples(rows: readonly VerifiableRow[]): VerificationSection[] {
  const keyCount = new Map<string, number>();
  const qualifiedKeyCount = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.dimmer_model_norm}|${r.test_voltage}`;
    keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
    const qk = `${r.dimmer_model_norm}|${r.mode_qualifier ?? ""}|${r.test_voltage}`;
    qualifiedKeyCount.set(qk, (qualifiedKeyCount.get(qk) ?? 0) + 1);
  }
  const eligible = (r: VerifiableRow): boolean => {
    const k = `${r.dimmer_model_norm}|${r.test_voltage}`;
    if ((keyCount.get(k) ?? 0) <= 1) return true;
    // Duplicated (model, voltage): only usable when the qualifier makes the
    // question unambiguous.
    if (!r.mode_qualifier) return false;
    const qk = `${r.dimmer_model_norm}|${r.mode_qualifier}|${r.test_voltage}`;
    return (qualifiedKeyCount.get(qk) ?? 0) === 1;
  };

  const sections = new Map<string, VerificationSection & { rows: VerifiableRow[] }>();
  for (const r of rows) {
    const key = `${r.page}|${r.phase_type}`;
    let s = sections.get(key);
    if (!s) {
      s = {
        page: r.page,
        phase_type: r.phase_type,
        section_header: r.section_header,
        rowCount: 0,
        sample: null,
        rows: [],
      };
      sections.set(key, s);
    }
    s.rowCount++;
    s.rows.push(r);
  }
  return [...sections.values()].map(({ rows: sectionRows, ...s }) => {
    const candidates = sectionRows.filter(eligible);
    const sample = candidates.length ? candidates[Math.floor(candidates.length / 2)]! : null;
    return { ...s, sample };
  });
}

// -----------------------------------------------------------------------------
// Verification comparison (pure — the runner feeds it the verifier's answers).
// -----------------------------------------------------------------------------

export interface VerifierAnswer {
  /** Which sampled question this answers (index into the samples array). */
  index: number;
  low_end_pct: number | null;
  comments: string;
  section_header: string;
}

export interface VerifierSectionCount {
  page: number;
  section_header: string;
  row_count: number;
}

function looseComment(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9%]/g, "");
}

/** Loose comment equality: normalized equality, containment either way, or
 *  both effectively blank ("", "-", "none", "n/a"). */
export function commentsMatch(a: string, b: string): boolean {
  const la = looseComment(a);
  const lb = looseComment(b);
  const blank = (x: string) => x === "" || x === "none" || x === "na";
  if (blank(la) && blank(lb)) return true;
  if (la === lb) return true;
  return la.length > 0 && lb.length > 0 && (la.includes(lb) || lb.includes(la));
}

export interface VerificationResult {
  ok: boolean;
  mismatches: string[];
}

/**
 * Compare the verifier's independent answers to the extraction (DC5): the
 * low-end %, the comment, and — the field the plan identifies as the
 * catastrophic failure mode — SECTION MEMBERSHIP (the verifier's section
 * header re-derived to a phase bucket must equal the extracted phase_type).
 * Also cross-checks per-section row counts. Any mismatch -> needs_review.
 */
export function verifyExtraction(
  sections: readonly VerificationSection[],
  answers: readonly VerifierAnswer[],
  sectionCounts: readonly VerifierSectionCount[],
): VerificationResult {
  const mismatches: string[] = [];
  const sampled = sections.filter((s) => s.sample !== null);
  for (let i = 0; i < sampled.length; i++) {
    const s = sampled[i]!;
    const row = s.sample!;
    const a = answers.find((x) => x.index === i);
    if (!a) {
      mismatches.push(`no verifier answer for sample ${i} (${row.dimmer_model})`);
      continue;
    }
    const num = (v: number | null) => (v === null || v === undefined ? null : Number(v));
    const ev = num(row.low_end_pct);
    const av = num(a.low_end_pct);
    const lowEndOk =
      ev === null || av === null ? ev === av : Math.abs(ev - av) < 0.05;
    if (!lowEndOk) {
      mismatches.push(
        `${row.dimmer_model} @ ${row.test_voltage}V low-end: extracted ${ev} vs verifier ${av}`,
      );
    }
    if (!commentsMatch(row.comments, a.comments)) {
      mismatches.push(
        `${row.dimmer_model} @ ${row.test_voltage}V comment: extracted "${row.comments}" vs verifier "${a.comments}"`,
      );
    }
    const verifierPhase = phaseFromSectionHeader(a.section_header);
    if (verifierPhase !== row.phase_type) {
      mismatches.push(
        `${row.dimmer_model} @ ${row.test_voltage}V section: extracted ${row.phase_type} vs verifier "${a.section_header}" (${verifierPhase})`,
      );
    }
  }
  // Per-section row-count cross-check (page + phase bucket).
  for (const s of sections) {
    const vc = sectionCounts.find(
      (c) => c.page === s.page && phaseFromSectionHeader(c.section_header) === s.phase_type,
    );
    if (!vc) {
      mismatches.push(`no verifier row count for p.${s.page} ${s.phase_type}`);
    } else if (Number(vc.row_count) !== s.rowCount) {
      mismatches.push(
        `p.${s.page} ${s.phase_type} row count: extracted ${s.rowCount} vs verifier ${vc.row_count}`,
      );
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
