/* ════════════════════════════════════════════════════════════
   WIES — shared types
   The data contract referenced by PRD §10 q3 (decoupled from PIM).
   ──────────────────────────────────────────────────────────── */

/** IES file format variants we acknowledge (LM-63 family). */
export type IESFormat =
  | "LM-63-1986"
  | "LM-63-1991"
  | "LM-63-1995"
  | "LM-63-2002"
  | "LM-63-2019"
  | "UNKNOWN";

/** ANSI/IES LM-63-19 Table 2 file generation type entry, decoded from
 *  the line-11 middle byte's raw token (§5.13.1–5.13.5). Populated by
 *  `decodeFileGenerationType` only when the raw token matches one of
 *  the 10 Table 2 patterns; the parser additionally gates the call on
 *  the file's line-1 header declaring `IESNA:LM-63-2019` (see
 *  `IESParseResult.fileGenerationType`). The match is on the *exact
 *  token string*, not the parsed numeric value: `1` and `1.00000` are
 *  numerically identical but only `1.00000` is a Table 2 entry. */
export interface FileGenerationType {
  /** The original token string from the file (e.g. "1.10100"). */
  raw: string;
  /** Verbatim Title from LM-63-19 Table 2. Render as-is. */
  title: string;
  /** Verbatim Description from LM-63-19 Table 2. Render as-is. */
  description: string;
}

/** Photometric type column 7 of the metadata line. */
export type PhotometricType = "C" | "B" | "A";

export interface IESKeywords {
  /** Free-form keywords keyed by the bracketed name. Repeated keys
   *  are joined with newlines, preserving every value. */
  [keyword: string]: string;
}

export interface IESParseWarning {
  code: string;
  message: string;
  /** "info" for expected, non-error notes (e.g. rotationally symmetric
   *  distributions). Defaults to "warn" when omitted. */
  severity?: "info" | "warn";
}

export interface IESParseResult {
  /** Source filename or short label (no path). */
  source: string;

  format: IESFormat;
  keywords: IESKeywords;

  tilt: "NONE" | "INCLUDE" | "FILE";

  /** Number of lamps. */
  lampCount: number;
  /** Initial rated lumens per lamp (-1 in the file means "absolute"). */
  lumensPerLamp: number;
  /** LM-63 §5.6 candela multiplier as it appeared in the file. ALREADY
   *  applied to `candela[][]` at parse time; this field exists solely
   *  so the report can display the factor per §6.0. Do not multiply
   *  by this again. */
  candelaMultiplierApplied: number;
  /** Number of vertical angles. */
  numV: number;
  /** Number of horizontal angles. */
  numH: number;

  photometricType: PhotometricType;

  /** Units type: 1 = feet, 2 = meters. */
  unitsType: 1 | 2;
  /** Luminous opening width (m or ft per unitsType). Raw value as
   *  read from the file — preserves the §5.11 sign convention so
   *  downstream code can re-decode the shape. Prefer the decoded
   *  `luminousOpening` field below for any calculation. */
  width: number;
  /** Luminous opening length (raw, signed, file units). */
  length: number;
  /** Luminous opening height (raw, signed, file units). */
  height: number;

  /** Decoded luminous opening per LM-63-19 §5.10 + §5.11 + Annex D.
   *  Populated by parseIES via the `luminousOpening()` helper in
   *  photometry.ts. Optional only because the legacy `emptyResult`
   *  short-circuit doesn't compute it; live parses always set it. */
  luminousOpening?: LuminousOpening;

  /** LM-63 §5.12 ballast factor as it appeared in the file. ALREADY
   *  applied to `candela[][]` at parse time; this field exists solely
   *  so the report can display the factor per §6.0. Do not multiply
   *  by this again. */
  ballastFactorApplied: number;
  /** Raw numeric value of the line-11 middle byte. Surfaced for legacy
   *  consumers that historically read this as a lamp-to-luminaire
   *  factor in LM-63-2002 and earlier (the spec called the slot
   *  `<future use>`). LM-63-2019 §5.13 / Annex H repurposes the same
   *  byte as `<file generation type>` — but that interpretation is
   *  GATED on the file's line-1 header self-declaring `IESNA:LM-63-2019`
   *  AND the raw token matching one of the 10 Table 2 patterns.
   *  Readers wanting the LM-63-2019 semantics should use
   *  `fileGenerationType` (which applies both gates); this field is
   *  only the opaque numeric value of the byte regardless of version. */
  futureUse: number;
  /** Decoded ANSI/IES LM-63-19 Table 2 entry (§5.13.1–5.13.5).
   *  Populated only when (a) the file's line-1 header declares
   *  `IESNA:LM-63-2019` AND (b) the line-11 middle byte's raw token
   *  matches one of the 10 Table 2 patterns. Either gate failing yields
   *  `undefined` — for older format declarations the byte is opaque
   *  `<future use>` metadata, and §5.13 is verbatim-only so we do not
   *  decode without a version warrant.
   *
   *  UI consumers must display Title and Description verbatim and SHALL
   *  NOT give any indication beyond them of how trustworthy one set of
   *  data is compared to another (§5.13). */
  fileGenerationType?: FileGenerationType;
  /** Total input watts. */
  inputWatts: number;

  /** Vertical angle array (length = numV). */
  vAngles: number[];
  /** Horizontal angle array (length = numH). */
  hAngles: number[];

  /** Candela values keyed as candela[h][v] — h in [0, numH), v in
   *  [0, numV). Units: candela. Values are stored post-scale: each
   *  entry already includes
   *  `candelaMultiplierApplied × ballastFactorApplied`. Do NOT multiply
   *  by either field above when consuming this matrix. See LM-63 §5.6,
   *  §5.12, §6.0. */
  candela: number[][];

  warnings: IESParseWarning[];
}

/* ── luminous opening (LM-63-19 §5.10–§5.11 + Annex D) ─────── */

/** Decoded luminous-opening shape per LM-63-19 Table 1. We collapse
 *  Table 1's 15 rows into nine canonical shape classes — the
 *  ellipsoidal variants (Vertical Ellipsoidal Cylinder, Ellipsoidal
 *  Spheroid, the two Horizontal Ellipsoidal Cylinders, Ellipse,
 *  Vertical Ellipse Facing PH) collapse into the same class as their
 *  circular siblings because the per-(θ, φ) silhouette formulas
 *  handle W ≠ L generically; the helper just dispatches the same
 *  branch with the right magnitudes. */
export type LuminousShape =
  | "point"
  | "rectangular"
  | "rectangular-with-sides"
  | "circular"
  | "vertical-cylinder"
  | "sphere"
  | "horizontal-cylinder-along-ph"
  | "horizontal-cylinder-perp-ph"
  | "vertical-circle-facing-ph";

export interface LuminousOpening {
  shape: LuminousShape;
  /** Width — perpendicular to the 0° photometric plane (§5.10.2),
   *  positive magnitude in metres after sign / unit decoding. */
  widthM: number;
  /** Length — parallel to the 0° photometric plane / along photometric
   *  horizontal (§5.10.3), positive magnitude in metres. */
  lengthM: number;
  /** Height — parallel to photometric zero (§5.10.4), positive
   *  magnitude in metres. */
  heightM: number;
  /** Area of the downward-facing luminous projection at theta = 0
   *  (what an observer directly below the fixture sees). 0 for point
   *  sources and vertical-circle-facing-PH shapes. */
  bottomAreaM2: number;
  /** True when the (W, L, H) sign / zero pattern matched one of the
   *  15 LM-63-19 Table 1 rows. False when the helper fell back to a
   *  rectangular interpretation because the encoding was exotic
   *  (e.g. mixed signs with no Table 1 row). The parser surfaces this
   *  as a `W_LUMINOUS_SHAPE` warning so downstream consumers know the
   *  shape is best-effort. */
  recognized: boolean;
  /** Projected luminous area at the given polar angle from nadir
   *  (radians), Type-C azimuth-averaged. EXACT closed form for
   *  φ-invariant shapes; uniform 16-point φ-quadrature of the exact
   *  per-(θ, φ) silhouette for non-φ-invariant shapes. Used by the
   *  UGR kernel (`computeUGRScenario`) and the luminance table
   *  (`luminanceAtViewingAngles`). */
  projectedAreaAtTheta(thetaRad: number): number;
}

/* ── derived metrics ──────────────────────────────────────── */

export interface BeamAngles {
  /** Beam angle (50% to 50% of peak) in degrees, per IES convention.
   *  Computed in the principal plane (C0) using that plane's own peak.
   *  Equal to `beamC0` — preserved as a back-compat alias for any
   *  reader that wants a single principal-plane value. */
  beamAngle: number | null;
  /** Field angle (10% to 10% of peak — the wider "edge of usable light").
   *  Equal to `fieldC0`. */
  fieldAngle: number | null;
  /** Beam angle (50% of peak) computed independently in the C0
   *  horizontal plane. For single-plane (numH === 1, axisymmetric)
   *  files this is equal to `beamC90` by construction — see the
   *  single-plane guard in `beamAngles()` in photometry.ts. */
  beamC0: number | null;
  /** Beam angle (50% of peak) computed independently in the C90
   *  horizontal plane. Equal to `beamC0` for axisymmetric files. */
  beamC90: number | null;
  /** Field angle (10% of peak) in the C0 plane. */
  fieldC0: number | null;
  /** Field angle (10% of peak) in the C90 plane. */
  fieldC90: number | null;
  /** Maximum candela value. */
  maxCandela: number;
  /** Vertical angle at which max candela occurs (degrees). */
  maxAngle: number;
  /** Horizontal plane (degrees) where max occurs (just for transparency). */
  maxHorizontal: number;
}

/** Spacing-criterion (S/MH ratio) used by lighting designers for
 *  uniform-illuminance layout. SC = 2 · tan(θ50) where θ50 is the
 *  half-angle from nadir at which candela drops to 50 % of peak. */
export interface SpacingCriterion {
  /** SC measured in the 0° horizontal plane (along-the-row direction). */
  plane0: number | null;
  /** SC measured in the 90° horizontal plane (across-the-row direction). */
  plane90: number | null;
  /** Average of plane0 and plane90 (or the single available value). */
  average: number | null;
  /** True when the difference between plane0 and plane90 is < 5 %. */
  symmetric: boolean;
}

export interface ZonalLumens {
  total: number;
  /** Lumens emitted into 0..90° vertical (downward hemisphere for a
   *  ceiling-mounted Type C luminaire). */
  downward: number;
  /** Lumens emitted into 90..180° vertical (upward hemisphere). */
  upward: number;
}

export interface BUGResult {
  /** B0..B5, U0..U5, G0..G5 */
  rating: string;
  B: number;
  U: number;
  G: number;
  /** Zonal lumens by zone label (BVH, BH, BM, BL, FVH, FH, FM, FL, UH, UL). */
  zoneLumens: Record<string, number>;
}

export interface UGRResult {
  /** Single UGR value, typical range 10–28. */
  value: number;
  /** True when computed using the standard 4H × 8H, default reflectances. */
  isDefault: boolean;
  /** The reflectance values used (so we can label "default"). */
  reflectances: { ceiling: number; wall: number; floor: number };
}

/** Reflectance combo (ceiling/wall/floor) used by the CIE 117 table. */
export interface UGRTableRefl {
  ceiling: number;
  wall: number;
  floor: number;
}

/** One UGR table row: a fixed Y room dimension (in H units) and the
 *  UGR values across each (reflectance × X-room-size) combination, for
 *  one viewing direction. */
export interface UGRTableRow {
  /** Y room dimension in multiples of H (e.g. 2, 3, 4, 6, 8, 12). */
  y: number;
  /** Per X-size and per reflectance UGR value: values[xIdx][reflIdx]. */
  values: number[][];
}

/** Standard CIE 117 UGR table, computed for both viewing directions
 *  and a small set of luminaire-spacing variations. */
export interface UGRTableResult {
  /** Reflectance combos in the table's column order (ρC/ρW/ρF). */
  reflectances: UGRTableRefl[];
  /** Y-axis room dimensions (in H units). */
  yRooms: number[];
  /** X-axis room dimensions (in H units). */
  xRooms: number[];
  /** rows indexed by yRoom; each row has values[xIdx][reflIdx]. */
  crosswise: UGRTableRow[];
  /** Same shape as crosswise, but for endwise viewing. */
  endwise: UGRTableRow[];
  /** Δ-UGR adjustments for non-standard luminaire spacing. Each entry
   *  is (positive_adj, negative_adj) corresponding to S-vs-reference. */
  spacingVariations: { sOverH: number; positive: number; negative: number }[];
  /** True when the IES file is rotationally symmetric, in which case
   *  crosswise and endwise produce identical numbers. */
  symmetric: boolean;
}

export type IsoluxUnit = "fc" | "lux";
export type DistanceSystem = "metric" | "imperial";

export interface RoomInputs {
  /** Canonical storage: always meters, regardless of display system. */
  mountingHeight: number;
  /** Canonical storage: always meters. */
  roomLength: number;
  /** Canonical storage: always meters. */
  roomWidth: number;
  /** Illuminance unit for the heatmap & stats. */
  unit: IsoluxUnit;
  /** Distance unit for the inputs and heatmap axes. */
  system: DistanceSystem;
}

export interface IsoluxGrid {
  unit: IsoluxUnit;
  xs: number[]; // grid cell centers along width (m, canonical)
  ys: number[]; // grid cell centers along length (m, canonical)
  values: number[][]; // values[y][x] in chosen illuminance unit
  avg: number;
  max: number;
  min: number;
  /** avg/min uniformity (per typical specifier convention). */
  uniformity: number;
}

/* ── extended IES-derived report tables ───────────────────── */

export interface CumulativeZoneRow {
  /** Lower vertical-angle bound, degrees from nadir. */
  v0: number;
  /** Upper vertical-angle bound, degrees from nadir. */
  v1: number;
  /** Display label, e.g. "0-30 deg", "Total". */
  label: string;
  lumens: number;
  /** Percent of rated lamp lumens (NaN when lamp lumens are unknown / "absolute"). */
  pctLamp: number;
  /** Percent of total luminaire lumens. */
  pctFixture: number;
}

export interface ConeOfLightRow {
  /** Mounting height in metres (canonical storage). */
  mountingHeightM: number;
  /** Beam diameter (50% of peak) at the working plane, metres. */
  beamDiaM: number;
  /** Field diameter (10% of peak) at the working plane, metres. */
  fieldDiaM: number;
  centerFc: number;
  centerLux: number;
  /** True for the row matching the user's current isolux mounting height. */
  isCurrent: boolean;
}

export interface CUTableRefl {
  ceiling: number;
  wall: number;
  floor: number;
}

export interface CUTable {
  reflectances: CUTableRefl[];
  rcrs: number[];
  /** values[refIdx][rcrIdx] — coefficient of utilization, fractional. */
  values: number[][];
}

export interface LuminanceRow {
  /** Vertical viewing angle in degrees from nadir. */
  angleDeg: number;
  /** Luminance in cd/m^2 in the 0 deg plane. */
  crosswise: number;
  /** Luminance in cd/m^2 in the 90 deg plane. */
  lengthwise: number;
}

export interface LuminanceTable {
  rows: LuminanceRow[];
  /** Projected luminous-opening area used for the calc, m^2. 0 when the
   *  IES file declares a point source — the panel hides itself. */
  openingAreaM2: number;
}

/* ── layout estimator (v1, indoor) ────────────────────────── */

/** How the fixture is physically attached. Drives the local-frame
 *  rotation that maps IES (theta, phi) onto a world direction. */
export type MountingOrientation = "ceiling" | "wall" | "floor";

/** Aim direction for the fixture's optical axis. "down/up/forward"
 *  are sensible presets; the object form lets advanced users specify
 *  an arbitrary tilt + rotation around the mounting normal. */
export type AimDirection =
  | "down"
  | "up"
  | "forward"
  | { tiltDeg: number; rotDeg: number };

/** Surface on which to compute illuminance.
 *
 *  - horizontal: an x-y plane at `heightAboveFloor` (canonical metres),
 *    extending across the full room. Used for floors, working planes,
 *    or "horizontal at ceiling" when looking at uplight.
 *  - vertical: a wall-shaped patch perpendicular to the +x axis,
 *    `widthAlong` (m) wide, `heightUp` (m) tall, at `offsetFromOrigin`
 *    metres from the room origin. */
export type TargetSurface =
  | { kind: "horizontal"; heightAboveFloor: number }
  | {
      kind: "vertical";
      offsetFromOrigin: number;
      widthAlong: number;
      heightUp: number;
    };

/** Indoor vs. outdoor classification used to filter task presets by
 *  the active product's category. Treated as "indoor" when omitted
 *  on a task. */
export type TaskEnvironment = "indoor" | "outdoor" | "both";

/** IESNA-style task preset. Used to seed the target illuminance
 *  field; user can override via Expert mode. */
export interface EstimatorTask {
  key: string;
  label: string;
  /** Recommended maintained illuminance in foot-candles. */
  fc: number;
  /** Whether this preset applies to a horizontal target, a vertical
   *  target, or both. */
  appliesTo: ("horizontal" | "vertical")[];
  /** Indoor vs. outdoor scope for this task. When omitted, treated as
   *  ``indoor`` — outdoor-only tasks (pathway, façade, garden, etc.)
   *  must opt in via ``"outdoor"``, and tasks that apply equally to
   *  both (gallery wash, art accent) should use ``"both"``. The Layout
   *  Estimator hides indoor tasks when the active product is in the
   *  ``landscape``/``in-grade`` categories, and hides outdoor tasks
   *  for everything else. */
  environment?: TaskEnvironment;
  /** Source standard, surfaced in tooltip. */
  source?: string;
  /** Maximum acceptable avg/min uniformity ratio for this task type
   *  (e.g. 3.0 for office per IES RP-1, 4.0 for circulation, 2.5 for
   *  detailed task work). Omit to use the global default. */
  uniformityRatio?: number;
  /** ASHRAE 90.1-2019 lighting power-density allowance for this
   *  space type, in W/ft². Used by the LPD-warning callout in the
   *  Layout Estimator. Omit when the space type isn't in the table. */
  lpdWFt2?: number;
}

/** Reflectances of the room's interior surfaces. Used for the
 *  CU-method bonus (only meaningful when target is a horizontal floor
 *  inside an enclosed room). */
export interface RoomReflectances {
  ceiling: number;
  wall: number;
  floor: number;
}

/* ── estimator I/O (ported from WIES types.ts for ies/layout.ts) ──────
   The solver bodies live in ies/layout.ts; these are the data contract
   for its inputs and results. Ported verbatim from WIES so the port's
   numbers stay comparable, with two marketing-app adaptations:
     * the reference tables (ESTIMATOR_TASKS etc) live in ies/estimator.ts;
     * CatalogEntry is a minimal shape (WIES's is much larger) — the
       solver reads only sku / family / wattage off it. */

export interface EstimatorInputs {
  mounting: MountingOrientation;
  aim: AimDirection;
  target: TargetSurface;

  /** Canonical metres. Always present even when the calc is on a
   *  vertical surface — defines the fixture-mounting geometry. */
  roomLength: number;
  roomWidth: number;
  ceilingHeight: number;

  reflectances: RoomReflectances;

  /** Target illuminance in foot-candles (canonical regardless of the
   *  display unit; `unit` controls only display). */
  targetFc: number;
  /** Selected task preset key, or "custom" when overridden. */
  taskKey: string;

  /** Light-loss factor (combined LLD × LDD × RSDD). 0..1. */
  llf: number;

  /** Display units. */
  unit: IsoluxUnit;
  system: DistanceSystem;
}

/** A single fixture placed in world coordinates with a mounting and aim. */
export interface PlacedFixture {
  /** World position in metres. */
  x: number;
  y: number;
  z: number;
  mounting: MountingOrientation;
  aim: AimDirection;
}

export interface EstimatorResult {
  /** Number of fixtures placed. */
  count: number;
  /** Grid layout: cols × rows. For non-grid layouts both are 1. */
  cols: number;
  rows: number;
  /** Spacing between fixtures in metres (canonical). */
  spacingX: number;
  spacingY: number;
  /** Fixture positions (one entry per placed fixture). */
  fixtures: PlacedFixture[];

  /** Computed average maintained illuminance on the target surface,
   *  in foot-candles (canonical). */
  actualFc: number;
  /** Max & min over the *whole* target surface, in fc. */
  maxFc: number;
  minFc: number;
  /** Avg, max & min over the *task area* — a subgrid inset from the
   *  perimeter so the avg:min ratio is computed the IES RP-1 / RP-7 way
   *  (and the way AGi32 / DIALux task-area reports do). `uniformity`
   *  below is taskAvgFc / taskMinFc. */
  taskAvgFc: number;
  taskMaxFc: number;
  taskMinFc: number;
  /** Task-area avg:min uniformity ratio (taskAvgFc / taskMinFc). */
  uniformity: number;

  /** Total electrical wattage of all placed fixtures. */
  totalWatts: number;
  /** Power density in W per square foot of target surface. */
  wPerFt2: number;

  /** Coefficient of utilization used (NaN when not computed). */
  cu: number;
  /** Room cavity ratio used (NaN when not applicable). */
  rcr: number;

  /** Whether actualFc includes a CU-method bonus on top of the
   *  point-by-point direct contribution. */
  includesCUBonus: boolean;

  /** 2D illuminance grid for plotting. values[j][i] in foot-candles.
   *  Axes (xs, ys) are canonical metres on the target surface. */
  grid: {
    xs: number[];
    ys: number[];
    values: number[][];
  };

  /** Working-plane illuminance from a single ceiling bounce for uplight
   *  installs. First-order approximation only. fc. */
  indirectWPFc?: number;

  /** True when the iterative solver hit the 144-fixture cap and the
   *  target is still unmet. */
  unreachable?: boolean;

  /** Set when the solver detected a degenerate fixture/aim/target combo
   *  that produces a (silently) near-zero result. */
  degenerate?: { reason: string; suggestion: string };

  /** True when no wattage data was available (neither IES file nor
   *  catalog provided a value). */
  wattsUnknown?: boolean;

  /** Raw lumen-method N before the grow loop + ceil-to-integer snap.
   *  NaN when the lumen method doesn't apply. */
  lumenMethodNRaw?: number;

  /** Integer lumen-method N (post-iteration, pre-grid-snap). When it
   *  equals `count` no snap was applied. */
  lumenMethodN?: number;
}

/* ── layout estimator — linear-continuous (tape) ─────────── */

/** Phase 2 application preset for `linear-continuous` products. */
export type LinearApplication =
  | "free-form"
  | "cove-uplight"
  | "under-cabinet"
  | "perimeter-accent";

/** Which wall of the room rectangle a run sits on. Plan view uses +x as
 *  room width and +y as room length; `south` is the wall at y = 0,
 *  `north` at y = roomLengthM, `east` at x = roomWidthM, `west` at
 *  x = 0. */
export type RoomWall = "south" | "east" | "north" | "west";

/** User inputs for the tape-light (`linear-continuous`) configurator.
 *  All distances canonical metres. */
export interface LinearEstimatorInputs {
  runLengthM: number;
  driverMaxW?: number;
  cutIncrementM?: number;
  llf: number;
  unit: IsoluxUnit;
  system: DistanceSystem;
  application: LinearApplication;
  coveToCeilingM?: number;
  coveWidthM?: number;
  cabinetHeightM?: number;
  counterDepthM?: number;
  wallMountHeightM?: number;
  wallExtentM?: number;
  roomLengthM: number;
  roomWidthM: number;
  ceilingHeightM: number;
  runWall: RoomWall;
  runStartM: number;
}

/** Result of `solveLinearLayout()`. */
export interface LinearEstimatorResult {
  requestedLengthM: number;
  buildableLengthM: number;
  lumensPerFt: number;
  wattsPerFt: number;
  totalLumens: number;
  totalWatts: number;
  driverMaxW: number;
  driverCount: number;
  driverOverloaded: boolean;
  cutCount?: number;
  cutIncrementM?: number;
  wattsUnknown?: boolean;
  surface?: {
    xs: number[];
    ys: number[];
    values: number[][];
    avgFc: number;
    minFc: number;
    maxFc: number;
    view: "plan" | "elevation";
    targetRect: { x: number; y: number; w: number; h: number };
    fixtureLine: { x0: number; y0: number; x1: number; y1: number };
  };
  indirectWPFc?: number;
}

/* ── layout estimator — area-continuous (pixels) ─────────── */

/** Phase 2 application preset for `area-continuous` products. */
export type AreaApplication = "free-form" | "feature-wall" | "ceiling-array" | "signage";

/** Surface orientation for an `area-continuous` install. */
export type AreaSurface = "ceiling" | "wall" | "floor";

/** User inputs for the pixel (`area-continuous`) configurator. */
export interface AreaEstimatorInputs {
  regionLengthM: number;
  regionWidthM: number;
  surface: AreaSurface;
  moduleIncrementMx?: number;
  moduleIncrementMy?: number;
  driverMaxW?: number;
  llf: number;
  unit: IsoluxUnit;
  system: DistanceSystem;
  application: AreaApplication;
  targetDistanceM?: number;
  reflectances?: RoomReflectances;
  roomLengthM: number;
  roomWidthM: number;
  ceilingHeightM: number;
  arrayWall: RoomWall;
  arrayStartXM: number;
  arrayStartYM: number;
}

/** Result of `solveAreaLayout()`. */
export interface AreaEstimatorResult {
  requestedLengthM: number;
  requestedWidthM: number;
  buildableLengthM: number;
  buildableWidthM: number;
  modulesAlong: number;
  modulesAcross: number;
  moduleCount: number;
  lumensPerModule: number;
  wattsPerModule: number;
  totalLumens: number;
  totalWatts: number;
  driverMaxW: number;
  driverCount: number;
  driverOverloaded: boolean;
  moduleIncrementMx: number;
  moduleIncrementMy: number;
  pixelCount?: number;
  wattsUnknown?: boolean;
  surface?: {
    xs: number[];
    ys: number[];
    values: number[][];
    avgFc: number;
    minFc: number;
    maxFc: number;
    view: "plan" | "elevation";
    targetRect: { x: number; y: number; w: number; h: number };
    fixtureRect: { x: number; y: number; w: number; h: number };
    roomAvgFc?: number;
    rcr?: number;
    cu?: number;
  };
}

/** How a product lays out in a room — the dispatch key for the layout
 *  solver. Ported AS-IS from WIES: it has NO track member. A track
 *  layout is a relationship between a track product and one or more head
 *  products (a multi-product session shape), not a property of a single
 *  product — track BOM is handled by ies/trackBom.ts, not this enum.
 *  When absent (or "area-grid"), the grid-of-point-fixtures solver runs
 *  (recessed downlights, surface mount, troffers). */
export type LayoutKind =
  | "area-grid"
  | "linear-continuous"
  | "area-continuous"
  | "linear-pitch"
  | "wall-wash-row"
  | "accent-single"
  | "decorative-single";

/** Minimal catalog-entry shape the layout solver reads. The full WIES
 *  CatalogEntry is much larger; the solver only needs a wattage source
 *  (`wattage`) and family/sku hints (for the tape/pixel cut-increment
 *  family lookups). Everything is optional so callers can pass a partial
 *  record or omit it entirely. */
export interface CatalogEntry {
  sku?: string;
  family?: string;
  wattage?: number;
}
