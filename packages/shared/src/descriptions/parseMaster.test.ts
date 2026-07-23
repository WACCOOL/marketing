import { describe, expect, it } from "vitest";
import {
  cellStr,
  expandModelRange,
  modelBase,
  parseMasterWorkbook,
  slugKey,
  tempBaseOf,
  type Cell,
} from "./parseMaster.js";
import { resolveColumns } from "./headers.js";
import { ImportPayloadSchema } from "./schema.js";

/**
 * ALL fixtures here are synthetic (the repo is public — real master-list data
 * must never be committed). Each fixture reproduces a structural quirk
 * observed in the real workbooks, with invented names/models.
 */

function sheet(headers: Cell[], rows: Cell[][]): Cell[][] {
  // Headers live on sheet row 4 (0-based index 3).
  return [[], [], [], headers, ...rows];
}

// --- Dweled-shaped sheet (alpha mode, name repeated on every row) ----------

const ALPHA_HEADERS: Cell[] = [
  "Name", // 0
  "Rendering", // 1
  "Product Type", // 2
  "Diffuser Type", // 3
  "Finish", // 4
  "Length (in)", // 5
  "Width (in)", // 6
  "Height (in)", // 7
  "LED Color Temp", // 8
  "Model No.", // 9
  "Family Name", // 10
  "Feature # 1", // 11
  "Feature # 2", // 12
  "Romance", // 13
  "LED Lumen", // 14
];

const dweledRows: Cell[][] = [
  // ZALTA: 3 rows, repeated name, duplicate finish, two sizes.
  ["ZALTA", null, "Outdoor Sconce", "Etched Glass", "BK", "26", "5", "7", "3000K", "WSW990726-BK", "Zalta Family", "Hammered Texture", null, "A cozy romance line.", "500"],
  ["ZALTA", null, "Outdoor Sconce", null, "WT", "26", "5", "7", "2700K", "WSW990726-WT", null, null, "Dark Sky Friendly", null, null],
  ["ZALTA", null, null, null, "BK", "32", "5", "7", "3000K", "WSW990732-BK", null, null, null, null, null],
  // KIGLO: one PPID spanning sconce + pendant models, with a model range.
  ["KIGLO", null, "Sconce", null, "BK", 16, 4, 4, "4CCT", "WSW770916/24-BK", null, "Cast Aluminum", null, null, null],
  ["KIGLO", null, "Pendant", null, "BK", 16, 4, 4, "4CCT", "PDW770916-BK", null, null, null, null, null],
];

// --- MF-shaped sheet (hybrid mode: numeric counter + name rows + noise) ----

// DWELED master: ALPHA_HEADERS + its distinctive workbook column.
const DWELED_HEADERS: Cell[] = [...ALPHA_HEADERS, "Tooling Note"]; // 15

const HYBRID_HEADERS: Cell[] = [
  ...ALPHA_HEADERS,
  "Product Hierarchy", // 15
  "For Formula Use", // 16 — the MF master's distinctive column
];

const mfRows: Cell[][] = [
  // Group 1 "Tovler": counter row carries the first model; a second model row
  // follows; then repeated name rows; then a `0` noise row with no model.
  [1, null, "Pendant", null, "BN", "12", "12", "18", "3000K", "PDW551418-BN", null, "Glossy Opal Glass", null, null, null, "Luminaires"],
  [null, null, null, null, "BK", "12", "12", "18", "3000K", "PDW551418-BK", null, null, null, null, null, null],
  ["Tovler", null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  // Stray `0` noise row mid-group, no model — must NOT start a group.
  [0, null, null, null, "BN", null, null, null, null, null, null, null, null, null, null, null],
  // Group 2 "Cazbie" (first of a duplicated name).
  [2, null, "Sconce", null, "BK", "7", "5", "12", "2700K", "WSW660312-BK", null, null, null, null, null, "Luminaires"],
  ["Cazbie", null, null, null, "VB", "7", "5", "12", "2700K", "WSW660312-VB", null, null, null, null, null, null],
  // Group 3 "Cazbie" again — same name, different model base.
  [3, null, "Sconce", null, "BK", "9", "5", "15", "2700K", "WSW660315-BK", null, null, null, null, null, "Luminaires"],
  ["Cazbie", null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  // Group 4 "Trivlie": the counter row carries NO model — the models arrive
  // on a `0` noise row and a name row (observed real-workbook shape).
  [7, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  [0, null, "Outdoor Flush", null, "VB", null, null, null, "3000K", "PMW551418-VB", null, null, null, null, null, null],
  ["Trivlie", null, null, null, "BK", null, null, null, "3000K", "PMW551418-BK", null, null, null, null, null, null],
  ["Trivlie", null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  // Groups 5+6: UNNUMBERED blocks — a bare model row opens each (a real
  // workbook shape), followed by name rows.
  [null, null, "Wall Sconce", null, "VB", null, null, null, "2700K", "WS971725-VB", null, null, null, null, null, null],
  ["Shelly", null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  [null, null, "Wall Sconce", null, "VB", null, null, null, "2700K", "WS982729-TWA-VB", null, null, null, null, null, null],
  ["Charm", null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  // Group 7: a fan (collection split).
  [4, null, "Smart Fan", null, "MB", "60", "60", "14", "3000K", "FRW200160-MB", null, "Wet Rated", null, null, null, "Fans - Smart"],
];

// --- Schonbek sheets -------------------------------------------------------

const beyond2027Rows: Cell[][] = [
  // Forward-fill: name only on the first row of each group.
  ["BRIGA", null, "Pendant", null, "AB", "21", "21", "24", "3000K", "BPD88401-AB", null, "Hand-set Crystal", null, null, null],
  [null, null, null, null, "PN", "21", "21", "24", "3000K", "BPD88401-PN", null, null, null, null, null],
  ["CHANTOLE", null, "Chandelier", null, "AB", "30", "30", "36", "2700K", "BCH99205-AB", null, null, null, null, null],
  [null, null, null, null, "BK", "30", "30", "36", "2700K", "BCH99205-BK", null, null, null, null, null],
];

const NUMERIC_HEADERS: Cell[] = [
  "No", // 0
  "Product Type", // 1
  "Finish", // 2
  "Length (in)", // 3
  "Width (in)", // 4
  "Height (in)", // 5
  "LED Color Temp", // 6
  "Model No.", // 7
  "Temporary No./Notes", // 8
  "Family Name", // 9
];

const sigforRows: Cell[][] = [
  // Group No=1, identity = Temporary-No. base 41QF0303. The notes column is
  // polluted (`8'`, prose) — those rows continue the group.
  [1, "Flush Mount", "AB", "12", "12", "4", "3000K", null, "41QF0303-1", null],
  [1, null, "PN", "12", "12", "4", "3000K", null, "8'", null],
  [1, null, "BK", "16", "16", "4", "3000K", null, "41QF0303-2", null],
  // Group No=2, new base.
  [2, "Wall Sconce", "AB", "5", "5", "14", "2700K", null, "41KJ0808-1", null],
  [2, null, "PN", "5", "5", "14", "2700K", null, "Quote and Sample program", null],
  // Group No=3 SHARES the 41QF0303 base (different token suffix) — the two
  // groups must get distinct content_keys via the suffix.
  [3, "Semi Flush", "AB", "9", "9", "5", "3000K", null, "41QF0303-9", null],
];

const beyond2028Rows: Cell[][] = [
  // 2028 quirk: `No` does NOT increment between two different products —
  // the tempBase base-change is the boundary.
  [1, "Flush Mount", "AB", "12", "12", "4", "3000K", null, "41QF0303-1", null],
  [1, null, "PN", "12", "12", "4", "3000K", null, "41QF0303-2", null],
  [1, "Task Light", "BK", "6", "6", "18", "2700K", null, "41TV0606-1", null],
  [2, "Pendant", "AB", "10", "10", "20", "3000K", null, "41PL0909-1", null],
];

function schonbekSheets() {
  return {
    "2027 Beyond (Core)": sheet(ALPHA_HEADERS, beyond2027Rows),
    "2027 Sigfor (Core)": sheet(NUMERIC_HEADERS, sigforRows),
    "2028 Beyond": sheet(NUMERIC_HEADERS, beyond2028Rows),
  };
}

// ---------------------------------------------------------------------------

describe("helpers", () => {
  it("cellStr renders numbers and trims strings", () => {
    expect(cellStr(26)).toBe("26");
    expect(cellStr(26.5)).toBe("26.5");
    expect(cellStr("  x ")).toBe("x");
    expect(cellStr(null)).toBe("");
  });

  it("expandModelRange expands slash ranges with the trailing finish suffix", () => {
    expect(expandModelRange("WSW770916/24-BK")).toEqual([
      "WSW770916-BK",
      "WSW770924-BK",
    ]);
    expect(expandModelRange("WSW770916/24/32-BK")).toEqual([
      "WSW770916-BK",
      "WSW770924-BK",
      "WSW770932-BK",
    ]);
    expect(expandModelRange("PDW770916-BK")).toEqual(["PDW770916-BK"]);
    // Unparseable ranges pass through untouched.
    expect(expandModelRange("ABC/XYZ")).toEqual(["ABC/XYZ"]);
  });

  it("modelBase strips the finish suffix", () => {
    expect(modelBase("WSW660312-BK/VB")).toBe("WSW660312");
    expect(modelBase("BPD11223O-TWA-AB")).toBe("BPD11223O");
    expect(modelBase("wsw660312")).toBe("WSW660312");
  });

  it("tempBaseOf accepts model-like tokens and rejects notes", () => {
    expect(tempBaseOf("41QF0303-1")).toBe("41QF0303");
    expect(tempBaseOf("41QF0303.2")).toBe("41QF0303");
    expect(tempBaseOf("8'")).toBeNull();
    expect(tempBaseOf("Quote and Sample program")).toBeNull();
    expect(tempBaseOf("")).toBeNull();
  });

  it("slugKey normalizes", () => {
    expect(slugKey("CHANTOLE")).toBe("chantole");
    expect(slugKey("Item 12 / B")).toBe("item-12-b");
  });
});

describe("REQUIRED_HEADERS guard", () => {
  it("hard-fails with the named missing columns", () => {
    const badHeaders: Cell[] = ["Rendering", "Diffuser Type", "LED Lumen"];
    const res = parseMasterWorkbook("dweled_master", {
      "Master Sheet": sheet(badHeaders, [["x", "y", "z"]]),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.missing).toEqual(["Name", "Product Type", "Finish", "Model No."]);
      expect(res.error).toContain("Name");
      expect(res.error).toContain("Model No.");
    }
  });

  it("fails on a missing sheet (wrong workbook for the slot)", () => {
    const res = parseMasterWorkbook("schonbek_master", {
      "Master Sheet": sheet(ALPHA_HEADERS, dweledRows),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('missing sheet "2027 Beyond (Core)"');
  });

  it("numeric sheets require No + Temporary No./Notes", () => {
    const res = parseMasterWorkbook("schonbek_master", {
      ...schonbekSheets(),
      "2027 Sigfor (Core)": sheet(ALPHA_HEADERS, sigforRows),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.sheet).toBe("2027 Sigfor (Core)");
      expect(res.missing).toEqual(["No", "Temporary No./Notes"]);
    }
  });

  it("rejects the MF workbook fed into the DWELED slot (cross-import guard)", () => {
    // Both masters use sheet "Master Sheet" and satisfy each other's
    // REQUIRED_HEADERS — the distinctive-column check must catch the swap.
    const res = parseMasterWorkbook("dweled_master", {
      "Master Sheet": sheet(HYBRID_HEADERS, mfRows),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("distinguishing column");
      expect(res.error).toContain("Tooling Note");
      expect(res.error).toContain("different brand's master list");
    }
  });

  it("rejects the DWELED workbook fed into the MF slot (cross-import guard)", () => {
    const res = parseMasterWorkbook("mf_master", {
      "Master Sheet": sheet(DWELED_HEADERS, dweledRows),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("distinguishing column");
      expect(res.error).toContain("For Formula Use");
    }
  });

  it("resolveColumns tolerates header drift via candidates", () => {
    const r = resolveColumns(
      ["Name", "Product Type", "Finish Color", "Model No", "Length"],
      "alpha",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cols.finish).toBe(2);
      expect(r.cols.model).toBe(3);
      expect(r.cols.length).toBe(4);
    }
  });
});

describe("alpha mode (Dweled: repeated names)", () => {
  const res = parseMasterWorkbook("dweled_master", {
    "Master Sheet": sheet(DWELED_HEADERS, dweledRows),
  });
  it("groups repeated names into one PPID row and aggregates", () => {
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.products).toHaveLength(2);
    const zalta = res.products[0]!;
    expect(zalta.name).toBe("ZALTA");
    expect(zalta.content_key).toBe("dweled:zalta");
    expect(zalta.brand).toBe("WAC Lighting");
    expect(zalta.collection).toBe("Dweled");
    expect(zalta.year).toBe(2027);
    expect(zalta.family).toBe("Zalta Family");
    expect(zalta.product_type).toBe("Outdoor Sconce");
    expect(zalta.diffuser_type).toBe("Etched Glass");
    expect(zalta.finishes).toEqual(["BK", "WT"]); // ordered distinct
    expect(zalta.cct).toEqual(["3000K", "2700K"]);
    expect(zalta.model_numbers).toEqual([
      "WSW990726-BK",
      "WSW990726-WT",
      "WSW990732-BK",
    ]);
    expect(zalta.model_bases).toEqual(["WSW990726", "WSW990732"]);
    expect(zalta.sizes).toEqual([
      { length: "26", width: "5", height: "7" },
      { length: "32", width: "5", height: "7" },
    ]);
    // Features: first non-empty per Feature # column, in column order.
    expect(zalta.features).toEqual(["Hammered Texture", "Dark Sky Friendly"]);
    expect(zalta.attributes.romance).toBe("A cozy romance line.");
    expect(zalta.attributes.sheet["LED Lumen"]).toBe("500");
    expect(zalta.source_rows).toBe(3);
  });

  it("keeps a WSW+PDW mixed group as ONE PPID and expands model ranges", () => {
    if (!res.ok) return;
    const kiglo = res.products[1]!;
    expect(kiglo.name).toBe("KIGLO");
    expect(kiglo.content_key).toBe("dweled:kiglo");
    expect(kiglo.model_numbers).toEqual([
      "WSW770916-BK",
      "WSW770924-BK",
      "PDW770916-BK",
    ]);
    expect(kiglo.model_bases).toEqual(["WSW770916", "WSW770924", "PDW770916"]);
    expect(kiglo.product_type).toBe("Sconce"); // first non-empty
  });

  it("output validates against the ImportPayload zod schema", () => {
    if (!res.ok) return;
    const parsed = ImportPayloadSchema.safeParse({
      slot: "dweled_master",
      products: res.products,
      warnings: res.warnings,
      sheets: res.sheets,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("hybrid mode (Modern Forms: counter + names + noise)", () => {
  const res = parseMasterWorkbook("mf_master", {
    "Master Sheet": sheet(HYBRID_HEADERS, mfRows),
  });

  it("boundaries on counter change; `0` noise stays put", () => {
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.products.map((p) => p.name)).toEqual([
      "Tovler",
      "Cazbie",
      "Cazbie",
      "Trivlie",
      "Shelly",
      "Charm",
      "Item 4", // the fan group has no name rows — ordinal fallback
    ]);
    const tovler = res.products[0]!;
    // The `0` noise row stayed in group 1 (its BN finish already present).
    expect(tovler.source_rows).toBe(4);
    expect(tovler.model_bases).toEqual(["PDW551418"]);
    expect(res.warnings.some((w) => w.includes('stray counter "0"'))).toBe(true);
  });

  it("a model-less counter row still opens its group; `0` rows can carry the models", () => {
    if (!res.ok) return;
    const trivlie = res.products[3]!;
    expect(trivlie.name).toBe("Trivlie");
    expect(trivlie.source_rows).toBe(4);
    expect(trivlie.model_bases).toEqual(["PMW551418"]);
    expect(trivlie.model_numbers).toEqual(["PMW551418-VB", "PMW551418-BK"]);
  });

  it("unnumbered model-first blocks split from the previous group", () => {
    if (!res.ok) return;
    const shelly = res.products[4]!;
    const charm = res.products[5]!;
    expect(shelly.name).toBe("Shelly");
    expect(shelly.model_bases).toEqual(["WS971725"]);
    expect(shelly.content_key).toBe("mf:shelly");
    expect(charm.name).toBe("Charm");
    expect(charm.model_bases).toEqual(["WS982729"]);
  });

  it("duplicate names get a model-base suffix in the content_key (both groups)", () => {
    if (!res.ok) return;
    const [c1, c2] = [res.products[1]!, res.products[2]!];
    expect(c1.name).toBe("Cazbie");
    expect(c2.name).toBe("Cazbie");
    expect(c1.content_key).toBe("mf:cazbie:wsw660312");
    expect(c2.content_key).toBe("mf:cazbie:wsw660315");
  });

  it("fan groups land in the Fans collection, luminaires elsewhere", () => {
    if (!res.ok) return;
    expect(res.products[0]!.collection).toBe("Luminaires");
    const fan = res.products[6]!;
    expect(fan.collection).toBe("Fans");
    expect(fan.brand).toBe("Modern Forms");
    expect(fan.content_key).toBe("mf:frw200160"); // model-base fallback key
  });
});

describe("Schonbek workbook (alpha forward-fill + numeric modes)", () => {
  const res = parseMasterWorkbook("schonbek_master", schonbekSheets());

  it("Beyond 2027 forward-fills sparse names", () => {
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const beyond = res.products.filter(
      (p) => p.collection === "Beyond" && p.year === 2027,
    );
    expect(beyond.map((p) => p.name)).toEqual(["BRIGA", "CHANTOLE"]);
    expect(beyond[0]!.content_key).toBe("beyond-2027:briga");
    expect(beyond[0]!.finishes).toEqual(["AB", "PN"]);
    expect(beyond[0]!.source_rows).toBe(2);
  });

  it("Sigfor groups by No + Temporary-No. base; notes never break identity", () => {
    if (!res.ok) return;
    const sigfor = res.products.filter((p) => p.collection === "Signature");
    expect(sigfor).toHaveLength(3);
    const first = sigfor[0]!;
    // Identity + display name derive from the tempBase (no alpha names).
    expect(first.name).toBe("41QF0303");
    expect(first.model_bases).toContain("41QF0303");
    expect(first.source_rows).toBe(3); // incl. the `8'` note row
    expect(first.year).toBe(2027);
    expect(sigfor[1]!.content_key).toBe("sigfor-2027:41kj0808");
    expect(sigfor[1]!.source_rows).toBe(2); // incl. the prose note row
  });

  it("two Sigfor products sharing a base get suffix-disambiguated keys", () => {
    if (!res.ok) return;
    const sigfor = res.products.filter((p) => p.collection === "Signature");
    expect(sigfor[0]!.content_key).toBe("sigfor-2027:41qf0303:1");
    expect(sigfor[2]!.content_key).toBe("sigfor-2027:41qf0303:9");
    expect(sigfor[2]!.product_type).toBe("Semi Flush");
  });

  it("2028 Beyond splits products under a non-incrementing No", () => {
    if (!res.ok) return;
    const b28 = res.products.filter((p) => p.year === 2028);
    expect(b28).toHaveLength(3);
    expect(b28.map((p) => p.content_key)).toEqual([
      "beyond-2028:41qf0303",
      "beyond-2028:41tv0606",
      "beyond-2028:41pl0909",
    ]);
    expect(b28[0]!.product_type).toBe("Flush Mount");
    expect(b28[1]!.product_type).toBe("Task Light");
    expect(b28.every((p) => p.collection === "Beyond")).toBe(true);
  });

  it("sort_order is sequential across the workbook's sheets", () => {
    if (!res.ok) return;
    expect(res.products.map((p) => p.sort_order)).toEqual(
      res.products.map((_, i) => i),
    );
    expect(res.sheets.map((s) => s.groups)).toEqual([2, 3, 3]);
  });
});

describe("content_key stability", () => {
  it("keys are content-derived: blank-row insertions and appended groups do not shift them", () => {
    const base = parseMasterWorkbook("dweled_master", {
      "Master Sheet": sheet(DWELED_HEADERS, dweledRows),
    });
    const shifted = parseMasterWorkbook("dweled_master", {
      "Master Sheet": sheet(DWELED_HEADERS, [
        ...dweledRows.slice(0, 3),
        [], // inserted blank row mid-sheet
        [],
        ...dweledRows.slice(3),
        ["NUVIO", null, "Pendant", null, "BK", "10", "10", "12", "3000K", "PDW555510-BK", null, null, null, null, null],
      ]),
    });
    expect(base.ok && shifted.ok).toBe(true);
    if (!base.ok || !shifted.ok) return;
    const baseKeys = base.products.map((p) => p.content_key);
    const shiftedKeys = shifted.products.map((p) => p.content_key);
    expect(shiftedKeys.slice(0, baseKeys.length)).toEqual(baseKeys);
    expect(shiftedKeys[baseKeys.length]).toBe("dweled:nuvio");
  });

  it("re-parsing identical input yields identical products", () => {
    const a = parseMasterWorkbook("mf_master", {
      "Master Sheet": sheet(HYBRID_HEADERS, mfRows),
    });
    const b = parseMasterWorkbook("mf_master", {
      "Master Sheet": sheet(HYBRID_HEADERS, mfRows),
    });
    expect(a).toEqual(b);
  });
});
