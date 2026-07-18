// @ts-nocheck — VERBATIM port from WIES Studio (wies-app/src/lib/ies-parser.ts),
// minus fetchAndParseIES/zipCache. Kept faithful to the validated WIES source
// (correctness pinned by ies/ies-parser.test.ts). This repo enables
// `noUncheckedIndexedAccess`, which WIES's tsconfig does not; the resulting
// diagnostics are all bounded-array index accesses in the token/candela reader.
// Suppressing at file scope preserves the port verbatim (zero behavioral change).
// The exported parseIES signature + IES types (ies/types.ts) stay type-checked.
/* ────────────────────────────────────────────────────────────
   IES LM-63 parser
   Strict on the LM-63-2002 grammar (which the entire WAC sample
   set uses) and tolerant of:
     - CRLF, LF, or mixed line endings
     - Extra whitespace around tokens
     - Multi-line numeric blocks (numbers may wrap freely after
       a TILT line, which is exactly what the sample does)
     - Older 1986/1991 files with no leading "IESNA:LM-63-..." line
   References:
     - IES LM-63-2002 (current public summary)
     - LM-63 historical format guides
   ──────────────────────────────────────────────────────────── */

import { decodeFileGenerationType } from "./fileGenerationType.js";
import { BOUNDARY_DECAY_THRESHOLD, luminousOpening } from "./photometry.js";
import type {
  IESFormat,
  IESKeywords,
  IESParseResult,
  IESParseWarning,
  PhotometricType,
} from "./types.js";

/** Detect IES format from the first non-empty line. */
function detectFormat(firstLine: string): IESFormat {
  const trimmed = firstLine.trim().toUpperCase();
  if (trimmed.startsWith("IESNA91")) return "LM-63-1991";
  if (trimmed.startsWith("IESNA:LM-63-1995")) return "LM-63-1995";
  if (trimmed.startsWith("IESNA:LM-63-2002")) return "LM-63-2002";
  if (trimmed.startsWith("IESNA:LM-63-2019")) return "LM-63-2019";
  if (trimmed.startsWith("IESNA")) return "LM-63-1995";
  return "LM-63-1986";
}

/** Pull the next whitespace-separated number off a queue of tokens. */
function nextNumber(tokens: string[], warnings: IESParseWarning[], label: string): number {
  while (tokens.length && tokens[0] === "") tokens.shift();
  const tok = tokens.shift();
  if (tok === undefined) {
    warnings.push({ code: "E_TRUNCATED", message: `Numeric block ended unexpectedly at ${label}` });
    return NaN;
  }
  const n = Number(tok);
  if (Number.isNaN(n)) {
    warnings.push({ code: "E_NUMERIC", message: `Could not parse ${label}: "${tok}"` });
    return NaN;
  }
  return n;
}

/** Like `nextNumber` but also returns the original token text. Used
 *  for fields where the *exact* string representation carries
 *  semantics that the numeric value does not — specifically the
 *  LM-63-2019 §5.13 file generation type byte, where `1` and
 *  `1.00000` are numerically identical but only `1.00000` is a Table 2
 *  entry. The numeric path is unchanged so back-compat consumers of
 *  `IESParseResult.futureUse` still get the same value as before. */
function nextNumberWithRaw(
  tokens: string[],
  warnings: IESParseWarning[],
  label: string,
): { value: number; raw: string } {
  while (tokens.length && tokens[0] === "") tokens.shift();
  const tok = tokens.shift();
  if (tok === undefined) {
    warnings.push({ code: "E_TRUNCATED", message: `Numeric block ended unexpectedly at ${label}` });
    return { value: NaN, raw: "" };
  }
  const n = Number(tok);
  if (Number.isNaN(n)) {
    warnings.push({ code: "E_NUMERIC", message: `Could not parse ${label}: "${tok}"` });
    return { value: NaN, raw: tok };
  }
  return { value: n, raw: tok };
}

/** Parse a single IES file's text content. */
export function parseIES(text: string, source = "unknown"): IESParseResult {
  const warnings: IESParseWarning[] = [];

  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  // 1. Format detection on the first non-empty line.
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;

  let format: IESFormat;
  if (lines[i] && /^IESNA/i.test(lines[i].trim())) {
    format = detectFormat(lines[i]);
    i++;
  } else {
    format = "LM-63-1986";
  }

  // 2. Keyword block: every line starting with [...] is a keyword.
  //    Continues until we hit "TILT=...".
  const keywords: IESKeywords = {};
  let lastKey: string | null = null;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (/^TILT\s*=/i.test(trimmed)) break;
    if (trimmed === "") {
      i++;
      continue;
    }
    const kwMatch = trimmed.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (kwMatch) {
      const [, key, value] = kwMatch;
      const upperKey = key.toUpperCase();
      const existing = keywords[upperKey];
      keywords[upperKey] = existing ? `${existing}\n${value}` : value;
      lastKey = upperKey;
    } else if (lastKey) {
      // Continuation of the previous keyword (LM-63-2002 §4.4).
      keywords[lastKey] = `${keywords[lastKey]}\n${trimmed}`;
    } else {
      // Pre-1995 files often skip keywords entirely; ignore stray
      // header text quietly.
      warnings.push({
        code: "W_STRAY_LINE",
        message: `Ignoring line in keyword block: "${trimmed.slice(0, 60)}"`,
      });
    }
    i++;
  }

  // 3. TILT line.
  if (i >= lines.length) {
    warnings.push({ code: "E_NO_TILT", message: "Missing TILT= line" });
    return emptyResult(source, format, keywords, warnings);
  }
  const tiltLine = lines[i].trim();
  i++;
  const tiltMatch = tiltLine.match(/^TILT\s*=\s*(NONE|INCLUDE|[\w./\\-]+)/i);
  let tilt: "NONE" | "INCLUDE" | "FILE" = "NONE";
  if (tiltMatch) {
    const v = tiltMatch[1].toUpperCase();
    if (v === "NONE") tilt = "NONE";
    else if (v === "INCLUDE") tilt = "INCLUDE";
    else tilt = "FILE";
  } else {
    warnings.push({ code: "E_TILT", message: `Could not parse TILT line: "${tiltLine}"` });
  }

  if (tilt === "INCLUDE") {
    // Skip TILT block: 1 line "lamp-to-luminaire geometry", 1 line
    // "number of pairs of angles & multiplying factors", then
    // angle/multiplier arrays. This isn't present in our sample so
    // we surface a warning rather than implementing it fully.
    warnings.push({
      code: "W_TILT_INCLUDE",
      message: "TILT=INCLUDE block skipped (not implemented in MVP parser)",
    });
  }

  // 4. From here, everything is whitespace-separated numbers across
  //    arbitrary lines until the file ends.
  const numericText = lines.slice(i).join(" ");
  const tokens = numericText.split(/\s+/).filter((t) => t !== "");

  // Line 10: 10 numbers. number-of-lamps, lumens-per-lamp,
  //   candela-multiplier, num-vertical, num-horizontal,
  //   photometric-type, units-type, width, length, height
  const lampCount = nextNumber(tokens, warnings, "number of lamps");
  const lumensPerLamp = nextNumber(tokens, warnings, "lumens per lamp");
  const candelaMultiplier = nextNumber(tokens, warnings, "candela multiplier");
  const numV = nextNumber(tokens, warnings, "number of vertical angles");
  const numH = nextNumber(tokens, warnings, "number of horizontal angles");
  const photTypeNum = nextNumber(tokens, warnings, "photometric type");
  const unitsTypeNum = nextNumber(tokens, warnings, "units type");
  const width = nextNumber(tokens, warnings, "width");
  const length = nextNumber(tokens, warnings, "length");
  const height = nextNumber(tokens, warnings, "height");

  // Line 11: 3 numbers. ballast-factor, future-use / file-generation-
  // type, input-watts. The middle byte's slot is structurally
  // identical across LM-63 versions; only the *interpretation* changed:
  //
  //   - LM-63-2002 and earlier: <future use> (historically a lamp-to-
  //     luminaire factor; treated as opaque metadata).
  //   - LM-63-2019 §5.13 / Annex H: <file generation type> — a 1.XYZWV
  //     decimal where each digit is a flag bit for Accredited /
  //     Interpolated / Scaled / Simulated / Undefined; the 10 valid
  //     decimal patterns are enumerated in Table 2.
  //
  // Table 2 decoding is gated by TWO warrants and we require BOTH:
  //
  //   1. Version warrant: the file's line-1 header must self-declare
  //      `IESNA:LM-63-2019` (no year-≥-2019 widening, no fuzzy match).
  //   2. Token warrant: the raw token must match one of the 10 Table 2
  //      patterns verbatim (compared as strings, since `1` and `1.00000`
  //      are numerically equal but only `1.00000` is a Table 2 entry).
  //
  // Strict version gating means a 2026-issued WAC pipeline file
  // stamped `IESNA: LM-63-2002` (cf. WTK-72S-E930-BK_2.IES) will NOT
  // have its byte decoded as a file generation type even if the raw
  // token happens to land on a Table 2 pattern. Per LM-63-19 §1.0
  // the format transition is permissive — emitting a 2002-format
  // file in 2026 is valid output, not a mistake — and §5.13 is
  // verbatim-only: decoding without a version warrant would invent a
  // §5.13 disclosure the file did not author. A future ISSUEDATE-
  // based promotion heuristic could relax this if real specifier
  // confusion materializes; loosening the §5.13 gate is not the
  // right fix.
  const ballastFactor = nextNumber(tokens, warnings, "ballast factor");
  const futureUseToken = nextNumberWithRaw(
    tokens,
    warnings,
    "future-use / file-generation-type byte",
  );
  const futureUse = futureUseToken.value;
  const fileGenerationType =
    format === "LM-63-2019"
      ? decodeFileGenerationType(futureUseToken.raw)
      : undefined;
  const inputWatts = nextNumber(tokens, warnings, "input watts");

  // 5. Vertical angles, horizontal angles, candela block.
  if (!Number.isFinite(numV) || !Number.isFinite(numH) || numV <= 0 || numH <= 0) {
    warnings.push({
      code: "E_GRID",
      message: `Invalid angle grid: numV=${numV}, numH=${numH}`,
    });
    return emptyResult(source, format, keywords, warnings);
  }

  const vAngles: number[] = [];
  for (let k = 0; k < numV; k++) {
    vAngles.push(nextNumber(tokens, warnings, `vertical angle ${k}`));
  }
  const hAngles: number[] = [];
  for (let k = 0; k < numH; k++) {
    hAngles.push(nextNumber(tokens, warnings, `horizontal angle ${k}`));
  }

  // candela[h][v]
  // LM-63 §5.6 requires the candela multiplier to be applied to all
  // candela values; §5.12 requires the same for the ballast factor.
  // We fold both into a single scale here so every downstream consumer
  // (candelaAt, zonalLumens, plots, BUG/UGR, exports) sees post-scale
  // values automatically. The applied factors are surfaced separately
  // on the result (§6.0) — see types.ts for the "do not double-apply"
  // contract.
  const mult = Number.isFinite(candelaMultiplier) ? candelaMultiplier : 1;
  const bf =
    Number.isFinite(ballastFactor) && ballastFactor > 0 ? ballastFactor : 1;
  const totalScale = mult * bf;
  const candela: number[][] = [];
  for (let h = 0; h < numH; h++) {
    const row: number[] = [];
    for (let v = 0; v < numV; v++) {
      const raw = nextNumber(tokens, warnings, `candela[${h}][${v}]`);
      row.push(Number.isFinite(raw) ? raw * totalScale : 0);
    }
    candela.push(row);
  }

  // 6. Photometric type / units interpretation
  const photometricType: PhotometricType =
    photTypeNum === 1 ? "C" : photTypeNum === 2 ? "B" : photTypeNum === 3 ? "A" : "C";
  if (![1, 2, 3].includes(photTypeNum as number)) {
    warnings.push({
      code: "W_PHOT_TYPE",
      message: `Unknown photometric type code "${photTypeNum}", defaulting to C`,
    });
  }
  // LM-63 §5.9: Type A and Type B use different goniometer coordinate
  // systems from Type C. Our zonalLumens / efficacy / beam-angle math
  // is Type-C-shaped, so surface a known-limitation warning. BUG/UGR
  // are already hidden via photometry.metricsAvailable.
  if (photometricType !== "C") {
    warnings.push({
      code: "I_PHOT_TYPE_NON_C",
      severity: "warn",
      message:
        `Photometric type ${photometricType} (LM-63 §5.9). ` +
        "Total lumens, efficacy, zonal summary, and beam/field angles assume " +
        "Type C goniometry and may be inaccurate for this file. BUG and UGR are disabled.",
    });
  }
  const unitsType = (unitsTypeNum === 1 ? 1 : 2) as 1 | 2;

  // 7. Sanity warnings (PRD §8.4: "validate and surface parse warnings").
  // LM-63 §5.5: <lumens per lamp> = -1 is the canonical sentinel for
  // absolute photometry; some files use 0 or omit the value. Treat any
  // non-positive (or non-finite) value the same way the report does
  // (isAbsolutePhotometry).
  if (!Number.isFinite(lumensPerLamp) || lumensPerLamp <= 0) {
    warnings.push({
      code: "W_LUMENS_ABSOLUTE",
      severity: "info",
      message:
        `Lumens per lamp = ${lumensPerLamp} (absolute photometry per LM-63 §5.5); ` +
        "rated-lumen ratios in the zonal table will be omitted.",
    });
  }
  // BUG and UGR both require multi-plane data with reasonable angular
  // resolution. Emit a *specific* note so the report doesn't read like
  // an error for files that are simply rotationally symmetric (the
  // common case for round downlights / Type C optics).
  if (numH === 1) {
    warnings.push({
      code: "I_SYMMETRIC",
      severity: "info",
      message:
        "Rotationally symmetric distribution (1 horizontal plane). " +
        "BUG and UGR not computed — these require multi-plane photometry.",
    });
  } else if (numV < 91 || numH < 5) {
    warnings.push({
      code: "I_GRID",
      severity: "warn",
      message:
        `Angular grid resolution is low (${numV}×${numH}); ` +
        "UGR results may be approximate.",
    });
  }

  // LM-63 §5.15: Type C may legitimately store a partial vertical
  // range (downlight-only V 0..90, uplight-only V 90..180, etc.).
  // Surface this as an info note so users understand why uplight or
  // downlight zones may read 0 lm.
  //
  // BOUNDARY-DECAY SUPPRESSION: when the range is exactly 0°–90° AND
  // the candela has already trailed off to noise by 90° (max boundary
  // value across all H planes is below BOUNDARY_DECAY_THRESHOLD of
  // the global peak), the missing 90°–180° band carries no
  // measurable light. The "0 lumens uplight" report is honest, not a
  // gap, so the info note is suppressed. The check is purely
  // photometric — we do not infer fixture category from the IES
  // file. The zonal lumen calculation is unchanged: 90°–180° still
  // correctly reports 0 lm in the suppressed cases.
  if (photometricType === "C" && vAngles.length > 0) {
    const v0 = vAngles[0];
    const vLast = vAngles[vAngles.length - 1];
    const isPartial = v0 > 0.01 || vLast < 179.99;

    let suppress = false;
    if (
      isPartial &&
      Math.abs(v0) < 0.01 &&
      Math.abs(vLast - 90) < 0.01
    ) {
      let peak = 0;
      let boundary = 0;
      const lastV = vAngles.length - 1;
      for (let h = 0; h < numH; h++) {
        const plane = candela[h];
        if (!plane) continue;
        for (let v = 0; v < plane.length; v++) {
          const c = plane[v];
          if (c > peak) peak = c;
        }
        const cBoundary = plane[lastV] ?? 0;
        if (cBoundary > boundary) boundary = cBoundary;
      }
      if (peak > 0 && boundary / peak < BOUNDARY_DECAY_THRESHOLD) {
        suppress = true;
      }
    }

    if (isPartial && !suppress) {
      warnings.push({
        code: "I_PARTIAL_V",
        severity: "info",
        message:
          `Vertical range ${v0}°..${vLast}° (LM-63 §5.15 allows partial Type C). ` +
          "Zones outside this range report 0 lumens.",
      });
    }
  }

  const result: IESParseResult = {
    source,
    format,
    keywords,
    tilt,
    lampCount,
    lumensPerLamp,
    candelaMultiplierApplied: mult,
    numV,
    numH,
    photometricType,
    unitsType,
    width,
    length,
    height,
    ballastFactorApplied: bf,
    futureUse,
    fileGenerationType,
    inputWatts,
    vAngles,
    hAngles,
    candela,
    warnings,
  };

  // LM-63-19 §5.10 + §5.11 + Annex D: decode the luminous opening
  // *once* and cache it on the parse result so every consumer
  // (UGR kernel, luminance table, report panel) reads the same
  // descriptor. Surface a `W_LUMINOUS_SHAPE` warning when the
  // (W, L, H) encoding doesn't match any Table 1 row — we fall back
  // to a rectangular interpretation but the result is best-effort.
  const opening = luminousOpening(result);
  result.luminousOpening = opening;
  if (!opening.recognized) {
    warnings.push({
      code: "W_LUMINOUS_SHAPE",
      severity: "warn",
      message:
        `Luminous opening encoding (w=${width}, l=${length}, h=${height}, ` +
        `unitsType=${unitsType}) doesn't match any LM-63-19 Table 1 shape; ` +
        "falling back to a rectangular interpretation. UGR and luminance " +
        "may be approximate.",
    });
  }
  return result;
}

function emptyResult(
  source: string,
  format: IESFormat,
  keywords: IESKeywords,
  warnings: IESParseWarning[],
): IESParseResult {
  return {
    source,
    format,
    keywords,
    tilt: "NONE",
    lampCount: 0,
    lumensPerLamp: 0,
    candelaMultiplierApplied: 1,
    numV: 0,
    numH: 0,
    photometricType: "C",
    unitsType: 2,
    width: 0,
    length: 0,
    height: 0,
    ballastFactorApplied: 1,
    futureUse: 1,
    inputWatts: 0,
    vAngles: [],
    hAngles: [],
    candela: [],
    warnings,
  };
}
