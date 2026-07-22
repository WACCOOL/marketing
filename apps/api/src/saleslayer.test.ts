import { describe, it, expect, vi } from "vitest";
import {
  extractFileEntries,
  collectDocs,
  docTypeForField,
  docFieldsFrom,
  productTaxonomy,
  refreshSpecMatview,
  type SpecMatviewRpcClient,
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
    // The dimming-compatibility chart, NOT a dimensional drawing (dimming plan
    // audit; the old "Dimensional Report" mapping was a mislabel).
    expect(docTypeForField("dim_report")).toEqual({
      docType: "dimming_report",
      label: "Dimming Compatibility Report",
    });
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
    expect(docFieldsFrom({} as Env)).toEqual(["specsheet_pdf", "inst_sheet", "dim_report"]);
  });

  it("honors the CSV override (trimmed, empties dropped)", () => {
    const env = { SALES_LAYER_DOC_FIELDS: " specsheet_pdf , inst_sheet , ftc_label_pdf ," } as Env;
    expect(docFieldsFrom(env)).toEqual(["specsheet_pdf", "inst_sheet", "ftc_label_pdf"]);
  });
});

// 0068: the four product-level Sales Layer taxonomy fields mapped onto the
// products upsert. mounting_type (zmntyp) is the authoritative fixture-type
// facet the spec views' class derivation now leads with.
describe("productTaxonomy", () => {
  it("maps zprdtyp/zprdstyp/zmntyp/zinout, cleaned like name/brand/family", () => {
    expect(
      productTaxonomy({
        zprdtyp: " Downlights ",
        zprdstyp: "Trims",
        zmntyp: "Recessed Downlights",
        zinout: "Indoor",
      }),
    ).toEqual({
      product_type: "Downlights",
      product_subtype: "Trims",
      mounting_type: "Recessed Downlights",
      indoor_outdoor: "Indoor",
    });
  });

  it("decodes entities and drops N/A placeholders (cleanText parity)", () => {
    expect(
      productTaxonomy({
        zprdtyp: "Task &amp; Cove Lighting",
        zprdstyp: "N/A",
        zmntyp: "n/a",
        zinout: "",
      }),
    ).toEqual({
      product_type: "Task & Cove Lighting",
      product_subtype: null,
      mounting_type: null,
      indoor_outdoor: null,
    });
  });

  it("VENTRIX-as-zmntyp falls back to zprdtyp (the brand is not a mounting type)", () => {
    expect(
      productTaxonomy({ zmntyp: "VENTRIX", zprdtyp: "Track Systems", zinout: "Indoor" }),
    ).toMatchObject({ mounting_type: "Track Systems", product_type: "Track Systems" });
    // Case-insensitive, and a missing zprdtyp yields null (never the brand).
    expect(productTaxonomy({ zmntyp: "Ventrix" })).toMatchObject({ mounting_type: null });
  });

  it("returns all-null for a row without the fields (columns stay null pre-sync)", () => {
    expect(productTaxonomy({})).toEqual({
      product_type: null,
      product_subtype: null,
      mounting_type: null,
      indoor_outdoor: null,
    });
  });
});

// The 0064 spec-matview refresh is a post-success, best-effort sync step: it
// must call the service-role-only RPC, and NO failure mode may throw (a stale
// filter surface beats a failed product sync).
describe("refreshSpecMatview", () => {
  it("calls the refresh RPC and reports success + duration", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const res = await refreshSpecMatview({ rpc } as SpecMatviewRpcClient);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("refresh_product_spec_mat");
    expect(res.ok).toBe(true);
    expect(res.ms).toBeGreaterThanOrEqual(0);
  });

  it("swallows a PostgREST error result (never throws)", async () => {
    const rpc = vi.fn().mockResolvedValue({
      error: { message: "canceling statement due to statement timeout" },
    });
    const res = await refreshSpecMatview({ rpc } as SpecMatviewRpcClient);
    expect(res.ok).toBe(false);
  });

  it("swallows a thrown/rejected rpc (never throws)", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("network down"));
    const res = await refreshSpecMatview({ rpc } as SpecMatviewRpcClient);
    expect(res.ok).toBe(false);
  });
});
