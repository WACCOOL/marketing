/* ════════════════════════════════════════════════════════════
   Track bill-of-materials — data contract

   Track-with-heads is deliberately NOT a `LayoutKind` (see the note on
   that union in ./types.ts): a track layout is a relationship between a
   track SYSTEM product and one or more HEAD products, not a property of a
   single product. The pure solver in ./trackBom.ts consumes a seeded
   `TrackSystem` record (the tool reads it from the DB and passes it in)
   plus the head's IES + estimator inputs, and returns a buildable BOM +
   layout summary.

   Seed data lives in track_systems / track_components (migration 0049 =
   tables; a separate migration 0050 = rows). These types mirror those
   table shapes, in canonical FEET for lengths (matching the SQL columns).
   ──────────────────────────────────────────────────────────── */

import type { EstimatorResult } from "./types.js";

/** Voltage class of a track system — drives whether the BOM sizes
 *  line-voltage circuits (`circuitVa`) or low-voltage feeds /
 *  transformers (`feedCapacityW`). */
export type TrackVoltageClass = "line" | "low";

/** Role a component plays in a track system. Mirrors track_components.role. */
export type TrackComponentRole =
  | "channel"
  | "head"
  | "feed"
  | "connector"
  | "joiner"
  | "endcap"
  | "transformer";

/** One buildable component of a track system (a row of track_components). */
export interface TrackComponent {
  role: TrackComponentRole;
  sku: string;
  description?: string;
  /** For `channel` rows: the segment length this SKU provides, in feet. */
  segmentLengthFt?: number;
  /** For `head` rows: the head's wattage. */
  headWatts?: number;
  /** For `feed` / `transformer` rows: the capacity this SKU provides (W). */
  capacityW?: number;
}

/** A seeded track SYSTEM (a row of track_systems + its components). */
export interface TrackSystem {
  key: string;
  label: string;
  /** Physical track type — H | J | J2 | L | W | X | FLEXRAIL. */
  trackType: string;
  voltageClass: TrackVoltageClass;
  /** Buildable channel segment lengths (feet), used to bin-pack a run. */
  segmentLengthsFt: number[];
  /** Line-voltage circuit capacity in volt-amps. */
  circuitVa?: number;
  /** Low-voltage feed / transformer capacity in watts. */
  feedCapacityW?: number;
  /** Optional hard cap on heads per single run. */
  maxHeadsPerRun?: number;
  /** Default head spacing (feet) when the solver can't derive one. */
  defaultHeadSpacingFt?: number;
  /** Head track types compatible with this system (for the mismatch warn). */
  compatibleHeadTrackTypes: string[];
  components: TrackComponent[];
}

/** One aggregated line of the bill of materials. `sku` is null when the
 *  seed doesn't carry a SKU for that role — the tool surfaces it as a
 *  descriptive line the model can resolve via get_related_products. */
export interface BomLine {
  sku: string | null;
  description: string;
  qty: number;
  role: TrackComponentRole;
}

/** Result of `solveTrackBom()` — a buildable BOM + layout summary. */
export interface TrackLayoutResult {
  bom: { lines: BomLine[] };
  summary: {
    headCount: number;
    runs: number;
    headsPerRun: number;
    headSpacingFt: number;
    totalTrackFt: number;
    transformerCount: number;
    /** Line-voltage circuits required (undefined for low-voltage). */
    circuits?: number;
    avgFc: number;
    uniformity: number;
    totalWatts: number;
  };
  /** The underlying area-grid estimator result (present when an IES file
   *  was available to solve the photometric layout). */
  estimator?: EstimatorResult;
  /** Per-head placement — writable, reserved for a future head-level
   *  detail view. Empty in v1. */
  heads: { x: number; y: number }[];
  warnings: string[];
}
