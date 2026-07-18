/* ────────────────────────────────────────────────────────────
   Unit conversion helpers. Distances are stored canonically in
   metres throughout the app; this module is the only place we
   talk to feet.
   ──────────────────────────────────────────────────────────── */

import type { DistanceSystem } from "./types.js";

export const M_PER_FT = 0.3048;
export const FT_PER_M = 1 / M_PER_FT;

export function mToFt(m: number): number {
  return m * FT_PER_M;
}

export function ftToM(ft: number): number {
  return ft * M_PER_FT;
}

/** Convert a metre value into the user's chosen system. */
export function fromMeters(m: number, system: DistanceSystem): number {
  return system === "imperial" ? mToFt(m) : m;
}

/** Convert a value displayed in the user's system back to metres. */
export function toMeters(v: number, system: DistanceSystem): number {
  return system === "imperial" ? ftToM(v) : v;
}

export function distanceLabel(system: DistanceSystem): string {
  return system === "imperial" ? "ft" : "m";
}
