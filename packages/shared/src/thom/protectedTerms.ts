/**
 * Names that must NEVER be rewritten by the public copy normalizer's bare-WAC
 * upgrade. Standalone module with zero imports so the marketing-app SPA can
 * display the list without pulling the Thom agent/transport into its bundle.
 * The thom_dictionary table ADDS to these; they cannot be removed at runtime.
 */
export const DEFAULT_PROTECTED_TERMS: readonly string[] = [
  "WAC Group",
  "WAC Lighting",
  "WAC Landscape",
  "WAC Architectural",
  "WAC Home", // the smart home system
  "My WAC", // the app
  "WAC-Mesh",
];
