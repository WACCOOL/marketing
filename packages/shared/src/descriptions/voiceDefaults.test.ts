import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANTI_FORMULAIC_RULE, DESC_VOICE_DEFAULTS } from "./voiceDefaults.js";

/**
 * Migrations 0072 (the original 7 profiles) and 0073 (WAC Architectural ·
 * Core, added with the WAC slots) seed desc_voice_profiles with the SAME text
 * as these shared constants (they back "Reset to default"). This guard fails
 * when either side drifts — update both together.
 */

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../supabase/migrations",
);
const MIGRATION_PATHS = [
  join(MIGRATIONS_DIR, "0072_descriptions.sql"),
  join(MIGRATIONS_DIR, "0073_descriptions_wac_slots.sql"),
];

describe("voice defaults", () => {
  it("covers all 8 brand+collection tabs", () => {
    expect(
      DESC_VOICE_DEFAULTS.map((d) => `${d.brand} · ${d.collection}`),
    ).toEqual([
      "WAC Lighting · Dweled",
      "WAC Lighting · Limited",
      "WAC Architectural · Core",
      "Modern Forms · Fans",
      "Modern Forms · Luminaires",
      "Schonbek · Beyond",
      "Schonbek · Forever",
      "Schonbek · Signature",
    ]);
  });

  it("every prompt carries the anti-formulaic hard rule and copy-style rules", () => {
    for (const d of DESC_VOICE_DEFAULTS) {
      expect(d.prompt).toContain(ANTI_FORMULAIC_RULE);
      expect(d.prompt).toContain("No em dashes");
      expect(d.prompt).toContain("WAC Group");
      // No em dashes in our own copy either.
      expect(d.prompt.includes("—")).toBe(false);
      expect(d.voice_guidance.includes("—")).toBe(false);
    }
  });

  it("migrations 0072+0073 seed the exact same text (keep in sync)", () => {
    const sql = MIGRATION_PATHS.map((p) => readFileSync(p, "utf8")).join("\n");
    for (const d of DESC_VOICE_DEFAULTS) {
      expect(sql, `${d.brand} · ${d.collection} prompt drifted`).toContain(d.prompt);
      expect(sql, `${d.brand} · ${d.collection} voice drifted`).toContain(
        d.voice_guidance,
      );
      expect(sql).toContain(`('${d.brand}', '${d.collection}',`);
    }
  });
});
