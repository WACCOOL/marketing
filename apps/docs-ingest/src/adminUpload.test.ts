import { describe, expect, it } from "vitest";
import {
  ADMIN_VISION_PAGE_CAP,
  extractAdminUpload,
  FORCE_VISION_META_KEY,
  SCANNED_TOO_LARGE_ERROR,
  TRUNCATION_WARNING,
  type AdminUploadDeps,
} from "./adminUpload.js";

/** Bytes that pass the %PDF magic check (the rest is irrelevant — extraction is
 *  injected). */
function pdfBytes(): Uint8Array {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
}

function deps(over: Partial<AdminUploadDeps> = {}): AdminUploadDeps {
  return {
    getObject: async () => ({ bytes: pdfBytes(), meta: {} }),
    extractPages: async () => ({
      pages: ["First page body text. ".repeat(10), "Second page body text. ".repeat(10)],
      pageCount: 2,
    }),
    vision: null,
    ...over,
  };
}

describe("extractAdminUpload", () => {
  it("fails clearly when the R2 store is not configured", async () => {
    const res = await extractAdminUpload("kb/admin_uploads/x.pdf", deps({ getObject: null }));
    expect(res).toEqual({ ok: false, error: expect.stringContaining("R2 store not configured") });
  });

  it("fails clearly when the row has no r2_key or the object is gone", async () => {
    expect(await extractAdminUpload(null, deps())).toEqual({
      ok: false,
      error: expect.stringContaining("no r2_key"),
    });
    const gone = deps({ getObject: async () => null });
    expect(await extractAdminUpload("kb/admin_uploads/x.pdf", gone)).toEqual({
      ok: false,
      error: expect.stringContaining("missing from R2"),
    });
  });

  it("rejects a stored object that is not a PDF", async () => {
    const bad = deps({
      getObject: async () => ({ bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]), meta: {} }),
    });
    const res = await extractAdminUpload("k", bad);
    expect(res).toEqual({ ok: false, error: "stored object is not a PDF" });
  });

  it("extracts per-page text into page-stamped chunks (text-layer path)", async () => {
    const res = await extractAdminUpload("k", deps());
    if (!res.ok) throw new Error(res.error);
    expect(res.method).toBe("text-layer");
    expect(res.pageCount).toBe(2);
    expect(res.truncated).toBe(false);
    expect(res.chunks.length).toBeGreaterThan(0);
    expect(res.chunks[0]!.page).toBe(1);
    // Every chunk carries a REAL page number on this path.
    for (const c of res.chunks) expect(typeof c.page).toBe("number");
  });

  it("reports truncation via the WARNING constant contract", () => {
    // The UI keys off the prefix; the ingest writes this exact string.
    expect(TRUNCATION_WARNING.startsWith("WARNING")).toBe(true);
  });

  it("falls back to vision on a sparse text layer, chunks with page: null", async () => {
    const d = deps({
      extractPages: async () => ({ pages: ["", "  "], pageCount: 2 }),
      vision: async () => "Vision transcript of the scanned pages. ".repeat(5),
    });
    const res = await extractAdminUpload("k", d);
    if (!res.ok) throw new Error(res.error);
    expect(res.method).toBe("claude-vision");
    expect(res.chunks.every((c) => c.page === null)).toBe(true);
  });

  it("fails a sparse doc over the vision page cap with the clear last_error", async () => {
    const d = deps({
      extractPages: async () => ({
        pages: Array.from({ length: ADMIN_VISION_PAGE_CAP + 1 }, () => ""),
        pageCount: ADMIN_VISION_PAGE_CAP + 1,
      }),
      vision: async () => "never called",
    });
    const res = await extractAdminUpload("k", d);
    expect(res).toEqual({ ok: false, error: SCANNED_TOO_LARGE_ERROR });
  });

  it("fails a sparse doc when vision is not configured", async () => {
    const d = deps({ extractPages: async () => ({ pages: [""], pageCount: 1 }) });
    const res = await extractAdminUpload("k", d);
    expect(res).toEqual({
      ok: false,
      error: expect.stringContaining("ANTHROPIC_API_KEY unset"),
    });
  });

  it("honors the force-vision R2 metadata toggle (skips the text layer)", async () => {
    let textLayerChunked = false;
    const d = deps({
      getObject: async () => ({ bytes: pdfBytes(), meta: { [FORCE_VISION_META_KEY]: "1" } }),
      extractPages: async () => {
        // Still called for the page count, but its (rich) text must NOT be used.
        textLayerChunked = true;
        return { pages: ["Rich text layer that would normally win. ".repeat(20)], pageCount: 1 };
      },
      vision: async () => "Forced vision transcript. ".repeat(10),
    });
    const res = await extractAdminUpload("k", d);
    if (!res.ok) throw new Error(res.error);
    expect(res.method).toBe("claude-vision");
    expect(textLayerChunked).toBe(true); // page count still probed
    expect(res.chunks[0]!.content).toContain("Forced vision transcript");
  });

  it("force-vision still respects the page cap", async () => {
    const d = deps({
      getObject: async () => ({ bytes: pdfBytes(), meta: { [FORCE_VISION_META_KEY]: "1" } }),
      extractPages: async () => ({ pages: [], pageCount: ADMIN_VISION_PAGE_CAP + 50 }),
      vision: async () => "never called",
    });
    const res = await extractAdminUpload("k", d);
    expect(res).toEqual({ ok: false, error: SCANNED_TOO_LARGE_ERROR });
  });
});
