/**
 * Product availability rules — decides whether a variant material shows on the
 * site / in Thom Bot, and if so with what availability label. Pure logic shared
 * by the Sales Layer ingest (apps/api/src/saleslayer.ts) and products-sync so
 * the rules live in one place.
 *
 * Source of truth: the WAC merchandising spec (four rules), keyed on the SAP
 * `zusage` lifecycle code (variant-level), the material's plant status, whether
 * the product carries an L2/L3 category reference, and whether it has a PPID.
 *
 *   Rule 3  zusage N or P                                    → hidden (never shows)
 *   Rule 1  L2/L3 + zusage A/B/W + retired plant status      → "Retired" label
 *   Rule 4  PPID + L2/L3 + zusage W/B + retired plant status → "Limited Availability,
 *                                                               Consult Factory" label
 *   Rule 2  L2/L3 + zusage A/B/W + plant UR/EX/T1/blank       → shows, no label
 *
 * NOTE (2026-07): plant status is not yet in the Sales Layer export and `zppid`
 * is present but unpopulated, so today only Rule 3 fires — every A/B/W variant
 * has a blank plant status and resolves to "normal". Rules 1/4 activate
 * automatically once the connector exports plant status (and PPID for Rule 4).
 */

export type Availability = "hidden" | "retired" | "limited" | "normal";

/** zusage codes that are actively sold (subject to the plant-status rules). */
export const ZUSAGE_ACTIVE = new Set(["A", "B", "W"]);
/** zusage codes that must never surface on the site or in Thom (Rule 3). */
export const ZUSAGE_HIDDEN = new Set(["N", "P"]);
/** zusage codes eligible for the "Limited Availability" label (Rule 4). */
export const ZUSAGE_LIMITED = new Set(["W", "B"]);
/** Plant statuses that mark a material as retired / limited rather than
 *  actively produced. Anything outside this set (incl. UR/EX/T1 and blank) is
 *  treated as active (Rule 2). */
export const RETIRED_PLANT_STATUS = new Set(["DW", "DV", "IW", "IV", "IG", "PW", "PV"]);

/** Customer-facing label for each availability state ("" = no label shown). */
export const AVAILABILITY_LABEL: Record<Availability, string> = {
  hidden: "",
  retired: "Retired",
  limited: "Limited Availability, Consult Factory",
  normal: "",
};

export interface AvailabilityInput {
  /** Variant-level SAP lifecycle code (A/B/W/N/P). */
  zusage: string | null | undefined;
  /** Material plant status (DW/DV/…/UR/EX/T1/blank). Blank => active. */
  plantStatus?: string | null;
  /** The product carries an L2/L3 category reference (no category => retired). */
  hasCategory: boolean;
  /** The product carries a PPID (required for the Limited-Availability rule). */
  isPpid?: boolean;
}

/**
 * Resolve a variant's availability state. Precedence is most-specific-first so
 * overlapping rules (a PPID W/B at a retired plant matches both Rule 1 and
 * Rule 4) resolve deterministically to the narrower label.
 */
export function variantAvailability(inp: AvailabilityInput): Availability {
  const zusage = (inp.zusage ?? "").trim().toUpperCase();
  const plant = (inp.plantStatus ?? "").trim().toUpperCase();

  // Rule 3 — N/P never shows, anywhere. Absolute: wins over every other signal.
  if (ZUSAGE_HIDDEN.has(zusage)) return "hidden";

  // No category reference => retired product (per PIM: L2/L3 is assigned via a
  // category ref; a product without one is retired). Checked before the plant
  // rules because Rules 1/2/4 are all scoped to L2/L3 (has-category) products.
  if (!inp.hasCategory) return "retired";

  const retiredPlant = RETIRED_PLANT_STATUS.has(plant);

  // Rule 4 (most specific) — a PPID L2/L3 with zusage W/B at a retired plant is
  // limited availability, not fully retired.
  if (retiredPlant && inp.isPpid && ZUSAGE_LIMITED.has(zusage)) return "limited";

  // Rule 1 — L2/L3 with an active zusage at a retired plant => Retired.
  if (retiredPlant && ZUSAGE_ACTIVE.has(zusage)) return "retired";

  // Rule 2 — L2/L3 + active zusage + non-retired plant (UR/EX/T1/blank) shows
  // with no label. An unknown/blank zusage also defaults to showing (preserving
  // the prior "everything visible" behavior rather than hiding on surprise).
  return "normal";
}

/** The label to display for a resolved availability state ("" = none). */
export function availabilityLabel(a: Availability): string {
  return AVAILABILITY_LABEL[a];
}

/** True when a variant should be dropped from the catalog entirely (Rule 3). */
export function isHiddenVariant(inp: AvailabilityInput): boolean {
  return variantAvailability(inp) === "hidden";
}
