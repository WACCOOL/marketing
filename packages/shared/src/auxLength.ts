// =============================================================================
// Auxiliary length parser (Thom attribute-filter plan, Addendum 2).
//
// Sales Layer variants carry auxiliary length fields whose values embed their
// OWN unit as a string — e.g. `zwire_length = "6 Feet"`, `"57\""`, `"96in"` —
// unlike the bare-numeric-inches `z*_fix` dimension fields. The unit is
// REQUIRED here: a bare number in these fields is ambiguous (the same column
// mixes inches and feet across brands) and parses to null, in deliberate
// contrast to the `z*_fix` fields where inches are the declared unit
// (SALES_LAYER_DIMENSION_UNIT).
//
// Build-gate audit of the live connector feed (2026-07-21, 66,840 variant
// rows, 298-field variant schema): `zwire_length` is the ONLY viable
// unit-suffixed aux-length field — 3,834 populated (5.7%), shapes
// `#"` ×1,465, `# Feet` ×1,183, `#'` ×563, bare `#` ×394 (→ null),
// `# Inches` ×204, `#in` ×16, `#ft` ×9. The audited siblings were rejected:
// `zsuspen_min`/`zsuspen_max` are bare-number dominant (6,845/6,975 of
// ~7,000 rows carry NO unit → a unit-required parse would keep only the 38
// `#"` rows each — deferred until the field's unit is declared upstream);
// `zrunlength`/`zvoltdrop` are prose guidance, not a fixture length;
// `zdnrodinc` is Yes/No; `zrel_prod_*` are related-product SKUs.
// =============================================================================

/** Auxiliary lengths on a variant, stored in mm (like `dimensions_mm`).
 *  `wire` = wire/cord/suspension lead length from `zwire_length`. */
export interface AuxLengthsMm {
  wire?: number;
}

// `<number> <unit>` with the unit REQUIRED. Feet: feet|foot|ft|' ; inches:
// inches|inch|in|" (plus the unicode prime/double-prime variants). Optional
// whitespace between number and unit; nothing else on either side.
const AUX_LENGTH_RE =
  /^(\d+(?:\.\d+)?)\s*(feet|foot|ft|'|′|inches|inch|in|"|″|”)$/i;

/**
 * Parse a unit-suffixed auxiliary length string to millimetres.
 * The unit is REQUIRED: `"6 Feet"` → 1828.8, `"72 in"` → 1828.8, `"57\""` →
 * 1447.8, `"96in"` → 2438.4 — but a bare `"180"` is ambiguous and returns
 * null (never guessed). N/A-ish placeholders and prose return null.
 */
export function parseAuxLengthMm(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (!s || /^#?n\/?a$/i.test(s)) return null;
  const m = AUX_LENGTH_RE.exec(s);
  if (!m) return null;
  const n = Number.parseFloat(m[1]!);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2]!.toLowerCase();
  const isFeet = unit === "feet" || unit === "foot" || unit === "ft" || unit === "'" || unit === "′";
  const mm = n * (isFeet ? 304.8 : 25.4);
  return Math.round(mm * 100) / 100;
}
