import { describe, it, expect } from "vitest";
import {
  extractFileEntries,
  collectDocs,
  docTypeForField,
  docFieldsFrom,
} from "./saleslayer.js";
import type { Env } from "./env.js";

// Real connector shapes observed from the live Sales Layer schema/data.
const SPEC = [
  ["M", "048492bd02835951834f781692c3092f", "https://cdn.example/CMP11172/files/1/LED-TO24-CH5_SPSHT.pdf"],
];
const INST = [
  ["M", "3f23ed862af66d1cf88ddb0c508af37d", "https://cdn.example/CMP11172/files/1/EN-2460D-C-P_IN_0.pdf"],
];

describe("extractFileEntries", () => {
  it("pulls {hash,url} from the [[STATUS, hash, URL]] shape", () => {
    expect(extractFileEntries(SPEC)).toEqual([
      { hash: "048492bd02835951834f781692c3092f", url: "https://cdn.example/CMP11172/files/1/LED-TO24-CH5_SPSHT.pdf" },
    ]);
  });

  it("handles a single bare [STATUS, hash, URL] entry", () => {
    expect(extractFileEntries(["M", "abc123def456", "https://cdn.example/x.pdf"])).toEqual([
      { hash: "abc123def456", url: "https://cdn.example/x.pdf" },
    ]);
  });

  it("handles multiple entries", () => {
    const v = [
      ["M", "h1", "https://cdn.example/a.pdf"],
      ["M", "h2", "https://cdn.example/b.pdf"],
    ];
    expect(extractFileEntries(v)).toEqual([
      { hash: "h1", url: "https://cdn.example/a.pdf" },
      { hash: "h2", url: "https://cdn.example/b.pdf" },
    ]);
  });

  it("skips the 1-char status flag when picking the hash", () => {
    // The 'M'/'D' status must never be mistaken for the hash.
    expect(extractFileEntries([["D", "realhash", "https://cdn.example/c.pdf"]])[0]!.hash).toBe("realhash");
  });

  it("returns [] for empty / missing / non-array values", () => {
    expect(extractFileEntries([])).toEqual([]);
    expect(extractFileEntries(undefined)).toEqual([]);
    expect(extractFileEntries("")).toEqual([]);
    expect(extractFileEntries(["M", "hash-only-no-url"])).toEqual([]);
  });
});

describe("docTypeForField", () => {
  it("maps the confirmed fields to types + labels", () => {
    expect(docTypeForField("specsheet_pdf")).toEqual({ docType: "spec_sheet", label: "Specification Sheet" });
    expect(docTypeForField("inst_sheet")).toEqual({ docType: "manual", label: "Installation Manual" });
    expect(docTypeForField("ftc_label_pdf").docType).toBe("ftc_label");
    expect(docTypeForField("dim_report").docType).toBe("dim_report");
  });
});

describe("collectDocs", () => {
  it("collects across fields with the right doc types", () => {
    const row = { specsheet_pdf: SPEC, inst_sheet: INST };
    const docs = collectDocs(row, ["specsheet_pdf", "inst_sheet"]);
    expect(docs.map((d) => d.docType)).toEqual(["spec_sheet", "manual"]);
    expect(docs[0]!.hash).toBe("048492bd02835951834f781692c3092f");
    expect(docs[1]!.url).toContain("_IN_0.pdf");
  });

  it("de-duplicates the same URL appearing on two fields", () => {
    const same = [["M", "h", "https://cdn.example/shared.pdf"]];
    const docs = collectDocs({ specsheet_pdf: same, inst_sheet: same }, ["specsheet_pdf", "inst_sheet"]);
    expect(docs).toHaveLength(1);
  });

  it("ignores fields with no file value", () => {
    expect(collectDocs({ specsheet_pdf: [] }, ["specsheet_pdf", "inst_sheet"])).toEqual([]);
  });
});

describe("docFieldsFrom", () => {
  it("defaults to the confirmed connector fields", () => {
    expect(docFieldsFrom({} as Env)).toEqual(["specsheet_pdf", "inst_sheet"]);
  });

  it("honors the CSV override (trimmed, empties dropped)", () => {
    const env = { SALES_LAYER_DOC_FIELDS: " specsheet_pdf , inst_sheet , ftc_label_pdf ," } as Env;
    expect(docFieldsFrom(env)).toEqual(["specsheet_pdf", "inst_sheet", "ftc_label_pdf"]);
  });
});
