// =============================================================================
// Extraction golden test (plan §F, DC9): ONE committed real fixture PDF (a
// public WAC dimming chart — repo-is-public safe, no customer data) with
// recorded expected rows. Pins are keyed by zip entry path + CONTENT HASH,
// never by size label (two 5in units exist with different values).
//
//  - The parser/derivation layers run UNCONDITIONALLY (status derivation,
//    report-code derivation, hash pin).
//  - The live Claude extraction runs ONLY when ANTHROPIC_API_KEY is present
//    (the creds-gated test idiom): forced-tool extraction of the real PDF,
//    then the DC2/DC9 golden pins are asserted against the applied rows.
// =============================================================================
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIMMING_EXTRACTION_MODEL,
  deriveRowStatus,
  reportCodeFromEntryPath,
  type DimmingModeQualifier,
  type DimmingPhaseType,
} from "@wac/shared/thom";
import { applyExtraction, extractDimmingUnit, sha256Hex, type AppliedRow } from "./dimming.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "dimming");

interface PinnedRow {
  why: string;
  dimmer_model_norm: string;
  phase_type: DimmingPhaseType;
  mode_qualifier: DimmingModeQualifier | null;
  test_voltage: string;
  low_end_pct: number | null;
  status: string;
  comments_contain?: string;
}

interface Expected {
  zip_entry_path: string;
  content_hash: string;
  report: {
    report_code_body: string | null;
    report_code_derived_from_filename: string;
    product_family_contains: string;
    skus_tested: string[];
    related_model_patterns_include: string[];
    test_voltage_range: string;
    pages: number;
    min_rows: number;
  };
  pinned_rows: PinnedRow[];
}

const expected = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "E1801063-1_25W.expected.json"), "utf8"),
) as Expected;
const pdfBytes = new Uint8Array(readFileSync(join(FIXTURE_DIR, "E1801063-1_25W.pdf")));

// --- unconditional: fixture integrity + derivation-layer pins ----------------

describe("dimming golden fixture (derivation layers, unconditional)", () => {
  it("the committed fixture's CONTENT HASH matches the recorded pin (DC9 keying)", () => {
    expect(sha256Hex(pdfBytes)).toBe(expected.content_hash);
  });

  it("the report code derives from the pinned zip entry path", () => {
    expect(reportCodeFromEntryPath(expected.zip_entry_path)).toBe(
      expected.report.report_code_derived_from_filename,
    );
  });

  it("every pinned row's status derives correctly from its low end + comment (DC1)", () => {
    for (const pin of expected.pinned_rows) {
      const derived = deriveRowStatus(pin.low_end_pct, pin.comments_contain ?? "");
      expect(derived.status, pin.why).toBe(pin.status);
    }
  });

  it("the DC2 golden pair shares model + voltage and differs ONLY by qualifier", () => {
    const pair = expected.pinned_rows.filter((p) => p.dimmer_model_norm === "ADTH700RMTUM1");
    expect(pair).toHaveLength(2);
    expect(pair.map((p) => p.mode_qualifier).sort()).toEqual(["elv", "triac"]);
    expect(new Set(pair.map((p) => p.phase_type))).toEqual(new Set(["adaptive"]));
    expect(pair[0]!.test_voltage).toBe(pair[1]!.test_voltage);
  });
});

// --- live Claude extraction (creds-gated) ------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!API_KEY)("dimming golden fixture (live Claude extraction)", () => {
  it(
    "extracts the real chart and matches every golden pin",
    { timeout: 300_000 },
    async () => {
      const extracted = await extractDimmingUnit(
        { apiKey: API_KEY!, model: process.env.ANTHROPIC_DIMMING_MODEL || DEFAULT_DIMMING_EXTRACTION_MODEL },
        pdfBytes,
      );
      const applied = applyExtraction(extracted, expected.zip_entry_path);

      // Header pins.
      expect(applied.report.report_code).toBe(expected.report.report_code_derived_from_filename);
      expect(applied.report.report_code_derived).toBe(true);
      expect(applied.report.product_family).toContain(expected.report.product_family_contains);
      expect(applied.report.skus_tested).toEqual(expected.report.skus_tested);
      for (const p of expected.report.related_model_patterns_include) {
        expect(applied.report.related_model_patterns).toContain(p);
      }
      expect(applied.rows.length).toBeGreaterThanOrEqual(expected.report.min_rows);

      // Row pins (keyed by norm + voltage + qualifier — the DC2 pair shares
      // model and voltage, so the qualifier is load-bearing).
      const find = (pin: PinnedRow): AppliedRow | undefined =>
        applied.rows.find(
          (r) =>
            r.dimmer_model_norm === pin.dimmer_model_norm &&
            r.test_voltage === pin.test_voltage &&
            r.mode_qualifier === pin.mode_qualifier,
        );
      for (const pin of expected.pinned_rows) {
        const row = find(pin);
        expect(row, `${pin.why}: row ${pin.dimmer_model_norm} (${pin.mode_qualifier}) missing`).toBeDefined();
        expect(row!.phase_type, pin.why).toBe(pin.phase_type);
        expect(row!.low_end_pct, pin.why).toBe(pin.low_end_pct);
        expect(row!.status, pin.why).toBe(pin.status);
        if (pin.comments_contain) {
          expect(row!.comments.toLowerCase(), pin.why).toContain(pin.comments_contain.toLowerCase());
        }
      }
    },
  );
});
