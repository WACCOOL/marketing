import { describe, expect, it } from "vitest";
import {
  DESC_EXPORT_HEADERS,
  buildExportRows,
  descriptionsCsv,
  exportRow,
  sizeAxisCell,
  type ExportProduct,
} from "./exportRows.js";

const base: ExportProduct = {
  brand: "WAC Lighting",
  collection: "Dweled",
  year: 2027,
  name: "Aster",
  family: "Aster Family",
  product_type: "Pendant",
  diffuser_type: "Etched Glass",
  finishes: ["Black", "Brushed Nickel"],
  sizes: [{ length: "26", width: "5", height: "7" }],
  cct: ["2700K", "3000K"],
  model_numbers: ["ZZ130726-BK", "ZZ130726-BN"],
  model_bases: ["ZZ130726"],
  features: ["Dimmable", "Wet rated"],
  content: null,
};

describe("DESC_EXPORT_HEADERS", () => {
  it("has the agreed columns in order", () => {
    expect(DESC_EXPORT_HEADERS).toEqual([
      "Brand",
      "Collection",
      "Year",
      "Name",
      "Family",
      "Product Type",
      "Diffuser Type",
      "Finishes",
      "Length",
      "Width",
      "Height",
      "CCT",
      "Model Numbers",
      "Features",
      "Description",
      "HTML Title",
      "Meta Description",
      "Status",
    ]);
  });
});

describe("sizeAxisCell (multi-size representation)", () => {
  it("returns the single value for one tuple", () => {
    expect(sizeAxisCell(base.sizes, (s) => s.length)).toBe("26");
  });
  it("collapses a uniform axis across tuples", () => {
    const sizes = [
      { length: "26", width: "5", height: "7" },
      { length: "32", width: "5", height: "7" },
    ];
    expect(sizeAxisCell(sizes, (s) => s.width)).toBe("5");
    expect(sizeAxisCell(sizes, (s) => s.height)).toBe("7");
  });
  it("joins a varying axis in tuple order so columns stay aligned", () => {
    const sizes = [
      { length: "26", width: "5", height: "7" },
      { length: "32", width: "5", height: "9" },
    ];
    expect(sizeAxisCell(sizes, (s) => s.length)).toBe("26; 32");
    expect(sizeAxisCell(sizes, (s) => s.height)).toBe("7; 9");
  });
  it("marks a missing axis value with ? inside a joined list", () => {
    const sizes = [
      { length: "26", width: "5", height: "7" },
      { length: "32", width: null, height: "7" },
    ];
    expect(sizeAxisCell(sizes, (s) => s.width)).toBe("5; ?");
  });
  it("renders empty for no tuples or a uniformly missing axis", () => {
    expect(sizeAxisCell([], (s) => s.length)).toBe("");
    expect(
      sizeAxisCell([{ length: null, width: "5", height: "7" }], (s) => s.length),
    ).toBe("");
  });
});

describe("exportRow", () => {
  it("assembles the 18 cells with joins and the formula title", () => {
    const row = exportRow(base);
    expect(row).toHaveLength(DESC_EXPORT_HEADERS.length);
    expect(row[0]).toBe("WAC Lighting");
    expect(row[2]).toBe("2027");
    expect(row[7]).toBe("Black, Brushed Nickel");
    expect(row[11]).toBe("2700K, 3000K");
    expect(row[12]).toBe("ZZ130726-BK, ZZ130726-BN");
    expect(row[13]).toBe("Dimmable\nWet rated");
    expect(row[14]).toBe(""); // no content row yet
    expect(row[15]).toBe("ASTER PENDANT | WAC LIGHTING"); // formula, never AI
    expect(row[17]).toBe("not written");
  });

  it("prefers final copy over ai, falls back to ai, and maps status labels", () => {
    const edited = exportRow({
      ...base,
      content: {
        description_ai: "AI draft.",
        description_final: "Edited copy.",
        meta_ai: "AI meta.",
        meta_final: null,
        title_override: null,
        status: "in_review",
      },
    });
    expect(edited[14]).toBe("Edited copy.");
    expect(edited[16]).toBe("AI meta.");
    expect(edited[17]).toBe("edited");
  });

  it("prefers a manual title override over the formula", () => {
    const row = exportRow({
      ...base,
      content: {
        description_ai: null,
        description_final: null,
        meta_ai: null,
        meta_final: null,
        title_override: "Aster Pendant, Hand Tuned | WAC LIGHTING",
        status: "none",
      },
    });
    expect(row[15]).toBe("Aster Pendant, Hand Tuned | WAC LIGHTING");
  });
});

describe("buildExportRows", () => {
  it("prepends the header row", () => {
    const rows = buildExportRows([base]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([...DESC_EXPORT_HEADERS]);
  });
});

/** Minimal RFC-4180 parser used only to prove the quoting round-trips. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
      i++;
    } else {
      cell += ch;
    }
  }
  return rows;
}

describe("descriptionsCsv", () => {
  it("round-trips commas, quotes and newlines through CSV quoting", () => {
    const tricky: ExportProduct = {
      ...base,
      name: 'Aster, the "quoted" one',
      features: ["Line one", "Line two"],
      content: {
        description_ai: null,
        description_final: "First sentence, with commas.\nSecond line.",
        meta_ai: 'Meta with "quotes", commas.',
        meta_final: null,
        title_override: null,
        status: "approved",
      },
    };
    const csv = descriptionsCsv([tricky]);
    const parsed = parseCsv(csv);
    expect(parsed[0]).toEqual([...DESC_EXPORT_HEADERS]);
    const row = parsed[1]!;
    expect(row[3]).toBe('Aster, the "quoted" one');
    expect(row[13]).toBe("Line one\nLine two");
    expect(row[14]).toBe("First sentence, with commas.\nSecond line.");
    expect(row[16]).toBe('Meta with "quotes", commas.');
    expect(row[17]).toBe("approved");
  });
});
