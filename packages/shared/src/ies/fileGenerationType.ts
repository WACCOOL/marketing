/* ════════════════════════════════════════════════════════════════
   ANSI/IES LM-63-19 Table 2 — file generation type lookup
   ────────────────────────────────────────────────────────────────
   The text in this module is reproduced VERBATIM from
   ANSI/IES LM-63-19 §5.13.1–5.13.5 / Table 2. §5.13 is explicit:

     "Programs parsing IES LM-63-2019 files shall identify the file
      generation type using only the exact Title and Description text
      in Table 2. Programs shall not give any indication beyond the
      title and description of how trustworthy one set of data is
      compared to another."

   Do not paraphrase, summarize, abbreviate, or annotate the Title /
   Description strings below. Add new entries only when a future LM-63
   revision extends Table 2. The byte-pattern → numeric-value mapping
   is defined in Annex H — each of the five flag bits (Accredited /
   Interpolated / Scaled / Simulated / Undefined) is encoded as a
   decimal digit position after the leading `1.` constant.
   ──────────────────────────────────────────────────────────────── */

import type { FileGenerationType } from "./types.js";

const TABLE_2: Record<string, { title: string; description: string }> = {
  "1.00001": {
    title: "Undefined",
    description:
      "The file generation type is unspecified, or the file is an older file.",
  },
  "1.00010": {
    title: "Computer Simulation",
    description:
      "Raytracing software generated the IES file using models of the lamp and optical system. User should request more information from manufacturer on method of simulation.",
  },
  "1.00000": {
    title: "Test at an unaccredited lab",
    description:
      "An absolute test at a lab without accreditation for this test method.",
  },
  "1.00100": {
    title: "Test at an unaccredited lab that has been lumen scaled",
    description:
      "An absolute test at a lab without accreditation for this test method. A test at one lumen level has been scaled to another lumen level based on a method chosen by the manufacturer. User should request more information from manufacturer on method of scaling.",
  },
  "1.01000": {
    title: "Test at an unaccredited lab with interpolated angle set",
    description:
      "An absolute test at a lab without accreditation for this test method. Some angles in the IES file were not directly measured, but interpolated from adjacent angles.",
  },
  "1.01100": {
    title:
      "Test at an unaccredited lab with interpolated angle set that has been lumen scaled",
    description:
      "An absolute test at a lab without accreditation for this test method. A test at one lumen level has been scaled to another lumen level based on a method chosen by the manufacturer. User should request more information from manufacturer on method of scaling. Some angles in the IES file were not directly measured, but interpolated from adjacent angles.",
  },
  "1.10000": {
    title: "Test at an accredited lab",
    description:
      "An absolute test at a lab with accreditation for this test method.",
  },
  "1.10100": {
    title: "Test at an accredited lab that has been lumen scaled",
    description:
      "An absolute test at a lab with accreditation for this test method. A test at one lumen level has been scaled to another lumen level based on a method chosen by the manufacturer. User should request more information from manufacturer on method of scaling.",
  },
  "1.11000": {
    title: "Test at an accredited lab with interpolated angle set",
    description:
      "An absolute test at a lab with accreditation for this test method. Some angles in the IES file were not directly measured, but interpolated from adjacent angles.",
  },
  "1.11100": {
    title:
      "Test at an accredited lab with interpolated angle set that has been lumen scaled",
    description:
      "An absolute test at a lab with accreditation for this test method. A test at one lumen level has been scaled to another lumen level based on a method chosen by the manufacturer. User should request more information from manufacturer on method of scaling. Some angles in the IES file were not directly measured, but interpolated from adjacent angles.",
  },
};

/** Decode the raw line-11 middle byte token against ANSI/IES LM-63-19
 *  Table 2 (§5.13.1–5.13.5). The match is on the *exact token string*,
 *  not the parsed numeric value: `1` and `1.00000` are numerically
 *  identical but only `1.00000` is a Table 2 entry (the all-flags-zero
 *  Title "Test at an unaccredited lab"). Returns `undefined` for any
 *  token that isn't one of the 10 valid Table 2 patterns; that covers
 *  legacy `<future use>` values (`1`, `0`) and any non-conforming
 *  values. The caller is responsible for the version-string gate —
 *  this helper does not look at the file's declared LM-63 version. */
export function decodeFileGenerationType(
  raw: string,
): FileGenerationType | undefined {
  const trimmed = raw.trim();
  const entry = TABLE_2[trimmed];
  return entry ? { raw: trimmed, ...entry } : undefined;
}
