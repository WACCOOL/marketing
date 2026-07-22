import { describe, expect, it } from "vitest";
import { healMfSpecs } from "./healMfSpecs.js";

/**
 * One-off Modern Forms spec-sheet heal — injected fetch/probe, in-memory
 * Supabase stub capturing every write (same idiom as stepW.test.ts).
 *
 * The defect: an early --reconcile-write filled pdp_urls.spec_sheet_url with
 * `/product/<slug>?download=specsN`, which answers HTML (not a PDF) to
 * fetchers, so Step B failed the folded kb_documents rows.
 */

interface Call {
  table: string;
  op: "select" | "update" | "delete" | "upsert";
  filters: Record<string, unknown[]>;
  patch?: Record<string, unknown>;
  rows?: Record<string, unknown>[];
}

function sbStub(fixture: {
  pdpRows: Record<string, unknown>[];
  kbByExternalId?: Record<string, { id: string; status: string }>;
  linksByDocId?: Record<string, Record<string, unknown>[]>;
}): { sb: never; calls: Call[] } {
  const calls: Call[] = [];
  const table = (name: string) => {
    const call: Call = { table: name, op: "select", filters: {} };
    const push = (k: string, v: unknown) => {
      (call.filters[k] ??= []).push(v);
    };
    const q = {
      select: () => q,
      like: (k: string, v: unknown) => {
        push(k, v);
        return q;
      },
      eq: (k: string, v: unknown) => {
        push(k, v);
        return q;
      },
      update: (patch: Record<string, unknown>) => {
        call.op = "update";
        call.patch = patch;
        return q;
      },
      delete: () => {
        call.op = "delete";
        return q;
      },
      upsert: (rows: Record<string, unknown>[]) => {
        call.op = "upsert";
        call.rows = rows;
        return q;
      },
      then: (resolve: (v: { data: unknown; error: null }) => void) => {
        calls.push(call);
        let out: unknown = null;
        if (call.op === "select") {
          if (name === "pdp_urls") out = fixture.pdpRows;
          else if (name === "kb_documents") {
            const ext = call.filters.external_id?.[0] as string;
            const hit = fixture.kbByExternalId?.[ext];
            out = hit ? [hit] : [];
          } else if (name === "product_documents") {
            const id = call.filters.document_id?.[0] as string;
            out = fixture.linksByDocId?.[id] ?? [];
          }
        }
        resolve({ data: out, error: null });
      },
    };
    return q;
  };
  return { sb: { from: table } as never, calls };
}

const BAD = "https://modernforms.com/product/fusion?download=specs5";
const PDP = "https://modernforms.com/product/fusion/";
// data-ppid (1539) deliberately differs from the catalog sku (1379) — Fusion's
// real shape in prod — so using the sku as the ppid would be a bug.
const PPID_HTML = `<html><body><div class="pdp" data-ppid="1539"></div></body></html>`;
const FIXED1 = "https://modernforms.com/dynamic-specsheet/?download=specs1&ppid=1539";
const FIXED5 = "https://modernforms.com/dynamic-specsheet/?download=specs5&ppid=1539";

const writes = (calls: Call[]) => calls.filter((c) => c.op !== "select");

describe("healMfSpecs", () => {
  it("heals the bad form to the PROBED dynamic-specsheet URL and requeues the failed kb row", async () => {
    const { sb, calls } = sbStub({
      pdpRows: [{ sku: "1379", url: PDP, spec_sheet_url: BAD }],
      kbByExternalId: { [BAD]: { id: "doc-1", status: "failed" } },
    });
    const probed: string[] = [];
    const report = await healMfSpecs(
      sb,
      {
        fetchHtml: async (u) => (u === PDP ? PPID_HTML : null),
        // Harvested specs5 is tried FIRST but answers HTML; only specs1 is a PDF.
        probePdf: async (u) => {
          probed.push(u);
          return u.includes("download=specs1");
        },
        log: () => {},
      },
      { dryRun: false },
    );

    expect(probed[0]).toBe(FIXED5); // harvested template probed first
    expect(report).toMatchObject({ scanned: 1, healed: 1, cleared: 0, kbRequeued: 1, kbSuperseded: 0 });

    const w = writes(calls);
    const pdpW = w.find((c) => c.table === "pdp_urls")!;
    expect(pdpW.patch).toEqual({ spec_sheet_url: FIXED1 });
    // Guarded on the bad value so a concurrent writer is never clobbered.
    expect(pdpW.filters.sku).toEqual(["1379"]);
    expect(pdpW.filters.spec_sheet_url).toEqual([BAD]);

    const kbW = w.find((c) => c.table === "kb_documents")!;
    expect(kbW.patch).toEqual({ external_id: FIXED1, url: FIXED1, status: "pending_extract", last_error: null });
    expect(kbW.filters.id).toEqual(["doc-1"]);

    const linkW = w.find((c) => c.table === "product_documents")!;
    expect(linkW.op).toBe("update");
    expect(linkW.patch).toEqual({ url: FIXED1 });
  });

  it("unresolvable rows revert to null (pre-bad-heal state) and the kb row is superseded", async () => {
    const { sb, calls } = sbStub({
      pdpRows: [{ sku: "1379", url: PDP, spec_sheet_url: BAD }],
      kbByExternalId: { [BAD]: { id: "doc-1", status: "failed" } },
    });
    const report = await healMfSpecs(
      sb,
      { fetchHtml: async () => PPID_HTML, probePdf: async () => false, log: () => {} },
      { dryRun: false },
    );
    expect(report).toMatchObject({ scanned: 1, healed: 0, cleared: 1, kbRequeued: 0, kbSuperseded: 1 });
    const w = writes(calls);
    expect(w.find((c) => c.table === "pdp_urls")!.patch).toEqual({ spec_sheet_url: null });
    expect(w.find((c) => c.table === "kb_documents")!.patch).toEqual({ status: "superseded" });
    expect(w.find((c) => c.table === "product_documents")!.op).toBe("delete");
  });

  it("when a doc for the fixed URL already exists, supersedes the bad doc and moves its links", async () => {
    const { sb, calls } = sbStub({
      pdpRows: [{ sku: "1379", url: PDP, spec_sheet_url: BAD }],
      kbByExternalId: {
        [BAD]: { id: "doc-old", status: "failed" },
        [FIXED5]: { id: "doc-dup", status: "active" },
      },
      linksByDocId: {
        "doc-old": [{ product_sku: "1379", doc_type: "spec_sheet", label: "Specification Sheet", scope: "public" }],
      },
    });
    const report = await healMfSpecs(
      sb,
      { fetchHtml: async () => PPID_HTML, probePdf: async (u) => u === FIXED5, log: () => {} },
      { dryRun: false },
    );
    expect(report).toMatchObject({ scanned: 1, healed: 1, kbRequeued: 0, kbSuperseded: 1 });
    const w = writes(calls);
    const kbW = w.find((c) => c.table === "kb_documents")!;
    expect(kbW.patch).toEqual({ status: "superseded" });
    expect(kbW.filters.id).toEqual(["doc-old"]);
    const up = w.find((c) => c.table === "product_documents" && c.op === "upsert")!;
    expect(up.rows).toEqual([
      {
        document_id: "doc-dup",
        product_sku: "1379",
        doc_type: "spec_sheet",
        label: "Specification Sheet",
        url: FIXED5,
        scope: "public",
      },
    ]);
    expect(w.some((c) => c.table === "product_documents" && c.op === "delete")).toBe(true);
  });

  it("dry-run resolves but never writes", async () => {
    const { sb, calls } = sbStub({
      pdpRows: [{ sku: "1379", url: PDP, spec_sheet_url: BAD }],
      kbByExternalId: { [BAD]: { id: "doc-1", status: "failed" } },
    });
    const report = await healMfSpecs(
      sb,
      { fetchHtml: async () => PPID_HTML, probePdf: async () => true, log: () => {} },
      { dryRun: true },
    );
    expect(report.healed).toBe(1);
    expect(writes(calls)).toEqual([]);
  });
});
