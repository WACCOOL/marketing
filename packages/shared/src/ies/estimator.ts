/* ════════════════════════════════════════════════════════════
   Lighting-requirement reference tables (ported from WIES)

   Only the pure IESNA/ASHRAE reference data + lookup helpers are
   ported here. The WIES layout solver (solveLayout, placeFixtures,
   multiFixtureIlluminance, …) is intentionally NOT ported — Thom Bot
   only needs the recommended-illuminance / uniformity / LPD lookups.

   NOTE (marketing-app adaptation): WIES's `environmentForCategories`
   /`OUTDOOR_PRODUCT_CATEGORIES` keyed off a WIES `ProductCategory`
   enum that does not exist in this repo (marketing `products.category`
   is free text). They are dropped here; `tasksForTarget` defaults the
   environment to "indoor".
   ──────────────────────────────────────────────────────────── */

import type {
  EstimatorTask,
  RoomReflectances,
  TaskEnvironment,
} from "./types.js";

/* ── task presets (IESNA RP-1 / RP-7 / RP-2 family) ──────── */

/** Default avg/min uniformity ratio when a task preset doesn't
 *  specify one. 3.0 ≈ IES RP-1 general-office expectation. */
export const DEFAULT_UNIFORMITY_RATIO = 3.0;

export const ESTIMATOR_TASKS: EstimatorTask[] = [
  // ── Indoor horizontal (working plane at desk/floor) ──────────
  // ASHRAE LPD allowances are space-by-space method per Table 9.6.1
  // of ASHRAE 90.1-2019 (W/ft²); uniformity ratios per IES RP-1.
  { key: "office-general", label: "Office, general", fc: 30, appliesTo: ["horizontal"], environment: "indoor", source: "IES RP-1", uniformityRatio: 3.0, lpdWFt2: 0.79 },
  { key: "office-reading", label: "Office, reading & writing", fc: 50, appliesTo: ["horizontal"], environment: "indoor", source: "IES RP-1", uniformityRatio: 2.5, lpdWFt2: 0.79 },
  { key: "conference", label: "Conference room / boardroom", fc: 30, appliesTo: ["horizontal"], environment: "indoor", uniformityRatio: 3.0, lpdWFt2: 0.97 },
  { key: "classroom", label: "Classroom", fc: 50, appliesTo: ["horizontal"], environment: "indoor", source: "IES RP-3", uniformityRatio: 2.5, lpdWFt2: 0.71 },
  { key: "lobby", label: "Lobby / reception", fc: 20, appliesTo: ["horizontal"], environment: "indoor", uniformityRatio: 4.0, lpdWFt2: 0.84 },
  { key: "corridor", label: "Corridor / circulation", fc: 10, appliesTo: ["horizontal"], environment: "indoor", uniformityRatio: 4.0, lpdWFt2: 0.41 },
  { key: "retail-general", label: "Retail, general", fc: 30, appliesTo: ["horizontal"], environment: "indoor", uniformityRatio: 3.0, lpdWFt2: 1.05 },
  { key: "retail-merchandise", label: "Retail, merchandise display", fc: 75, appliesTo: ["horizontal"], environment: "indoor", uniformityRatio: 3.0, lpdWFt2: 1.69 },
  { key: "kitchen", label: "Residential kitchen", fc: 30, appliesTo: ["horizontal"], environment: "indoor", uniformityRatio: 3.0 },
  { key: "kitchen-task", label: "Residential kitchen, task", fc: 50, appliesTo: ["horizontal"], environment: "indoor", uniformityRatio: 2.5 },
  { key: "living", label: "Residential living room", fc: 10, appliesTo: ["horizontal"], environment: "indoor", uniformityRatio: 4.0 },
  { key: "warehouse", label: "Warehouse, storage", fc: 10, appliesTo: ["horizontal"], environment: "indoor", uniformityRatio: 4.0, lpdWFt2: 0.45 },
  { key: "industrial-fine", label: "Industrial, fine assembly", fc: 100, appliesTo: ["horizontal"], environment: "indoor", uniformityRatio: 2.0, lpdWFt2: 1.21 },

  // ── Indoor vertical (interior wall wash, accent, signage) ────
  { key: "wall-wash-general", label: "Wall wash, general", fc: 30, appliesTo: ["vertical"], environment: "indoor", source: "IALD", uniformityRatio: 4.0 },
  { key: "wall-wash-feature", label: "Wall wash, feature wall", fc: 50, appliesTo: ["vertical"], environment: "indoor", uniformityRatio: 4.0 },
  { key: "gallery-wash", label: "Gallery / museum wash", fc: 5, appliesTo: ["vertical"], environment: "indoor", source: "IES DG-1", uniformityRatio: 3.0 },
  { key: "art-accent", label: "Art accent", fc: 30, appliesTo: ["vertical"], environment: "indoor", uniformityRatio: 5.0 },
  { key: "signage", label: "Interior signage", fc: 100, appliesTo: ["vertical"], environment: "indoor", uniformityRatio: 4.0 },

  // ── Outdoor horizontal (pathway, garden, patio) ──────────────
  // Recommended fc / uniformity per IES RP-33 (Lighting for Exterior
  // Environments). LPD allowances aren't applicable — ASHRAE 90.1
  // governs exterior lighting via a separate per-zone watt-allowance
  // scheme that doesn't fit the W/ft² model used here.
  { key: "outdoor-pathway", label: "Pathway / walkway", fc: 2, appliesTo: ["horizontal"], environment: "outdoor", source: "IES RP-33", uniformityRatio: 4.0 },
  { key: "outdoor-driveway", label: "Driveway", fc: 2, appliesTo: ["horizontal"], environment: "outdoor", source: "IES RP-33", uniformityRatio: 4.0 },
  { key: "outdoor-patio", label: "Patio / deck", fc: 5, appliesTo: ["horizontal"], environment: "outdoor", uniformityRatio: 4.0 },
  { key: "outdoor-garden", label: "Garden / planting bed", fc: 3, appliesTo: ["horizontal"], environment: "outdoor", uniformityRatio: 4.0 },
  { key: "outdoor-entrance", label: "Building entrance / step", fc: 5, appliesTo: ["horizontal"], environment: "outdoor", source: "IES RP-33", uniformityRatio: 3.0 },
  { key: "outdoor-security", label: "Security / perimeter", fc: 1, appliesTo: ["horizontal"], environment: "outdoor", uniformityRatio: 6.0 },
  { key: "outdoor-parking-residential", label: "Parking, residential", fc: 2, appliesTo: ["horizontal"], environment: "outdoor", source: "IES RP-33", uniformityRatio: 4.0 },

  // ── Outdoor vertical (façade, tree uplight) ──────────────────
  { key: "facade-modest", label: "Façade, modest brightness", fc: 5, appliesTo: ["vertical"], environment: "outdoor", uniformityRatio: 6.0 },
  { key: "facade-bright", label: "Façade, high brightness", fc: 30, appliesTo: ["vertical"], environment: "outdoor", uniformityRatio: 6.0 },
  { key: "outdoor-tree-uplight", label: "Tree / landscape feature uplight", fc: 5, appliesTo: ["vertical"], environment: "outdoor", uniformityRatio: 5.0 },
  { key: "outdoor-wall-wash", label: "Exterior wall wash", fc: 10, appliesTo: ["vertical"], environment: "outdoor", uniformityRatio: 5.0 },
];

/** Whether ``task`` is shown for a given installation environment.
 *  Tasks without an explicit environment are treated as ``indoor``
 *  (the historical default — every task pre-dating the outdoor split
 *  was an interior application). */
export function taskMatchesEnvironment(
  task: EstimatorTask,
  env: "indoor" | "outdoor",
): boolean {
  const taskEnv: TaskEnvironment = task.environment ?? "indoor";
  if (taskEnv === "both") return true;
  return taskEnv === env;
}

export function tasksForTarget(
  targetKind: "horizontal" | "vertical",
  environment: "indoor" | "outdoor" = "indoor",
): EstimatorTask[] {
  return ESTIMATOR_TASKS.filter(
    (t) => t.appliesTo.includes(targetKind) && taskMatchesEnvironment(t, environment),
  );
}

export function findTask(key: string): EstimatorTask | undefined {
  return ESTIMATOR_TASKS.find((t) => t.key === key);
}

/* ── reflectance presets ─────────────────────────────────── */

export const REFLECTANCE_PRESETS: { key: string; label: string; values: RoomReflectances }[] = [
  { key: "standard", label: "Standard (80/50/20)", values: { ceiling: 0.8, wall: 0.5, floor: 0.2 } },
  { key: "office", label: "Office (80/50/20)", values: { ceiling: 0.8, wall: 0.5, floor: 0.2 } },
  { key: "darker-office", label: "Darker office (70/30/20)", values: { ceiling: 0.7, wall: 0.3, floor: 0.2 } },
  { key: "warehouse", label: "Warehouse (50/30/10)", values: { ceiling: 0.5, wall: 0.3, floor: 0.1 } },
  { key: "dark-room", label: "Dark room (30/30/20)", values: { ceiling: 0.3, wall: 0.3, floor: 0.2 } },
];
