import { describe, expect, it } from "vitest";
import {
  checkPdfBytes,
  isDuplicateUploadError,
  isPdfMagic,
  isTruncationWarning,
  MAX_PDF_BYTES,
  parseUploadFields,
  scopeFlipAllowed,
  sha256HexBytes,
  titleEditionWarning,
} from "./thomUploads.js";

function pdfBuffer(size = 8): ArrayBuffer {
  const b = new Uint8Array(size);
  b.set([0x25, 0x50, 0x44, 0x46]); // %PDF
  return b.buffer;
}

describe("isPdfMagic / checkPdfBytes", () => {
  it("accepts %PDF-prefixed bytes", () => {
    expect(isPdfMagic(pdfBuffer())).toBe(true);
    expect(checkPdfBytes(pdfBuffer())).toEqual({ ok: true });
  });

  it("rejects non-PDF bytes (e.g. a zip header)", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]).buffer;
    expect(isPdfMagic(zip)).toBe(false);
    expect(checkPdfBytes(zip)).toEqual({
      ok: false,
      error: "file is not a valid PDF (missing %PDF header)",
    });
  });

  it("rejects empty and truncated files", () => {
    expect(checkPdfBytes(new ArrayBuffer(0))).toEqual({ ok: false, error: "empty file" });
    expect(isPdfMagic(new Uint8Array([0x25, 0x50]).buffer)).toBe(false);
  });

  it("rejects files over the 30MB cap", () => {
    // Don't allocate 30MB — fake the length via a zero-copy trick: an
    // ArrayBuffer of cap+1 is still cheap enough at 30MB… so use a small
    // assertion on the constant + a real just-over buffer.
    expect(MAX_PDF_BYTES).toBe(30 * 1024 * 1024);
    const over = new Uint8Array(MAX_PDF_BYTES + 1);
    over.set([0x25, 0x50, 0x44, 0x46]);
    expect(checkPdfBytes(over.buffer)).toEqual({
      ok: false,
      error: `file exceeds max size (${MAX_PDF_BYTES} bytes)`,
    });
  });
});

describe("parseUploadFields", () => {
  it("requires a title", () => {
    expect(parseUploadFields({})).toEqual({ ok: false, error: 'missing "title" field' });
    expect(parseUploadFields({ title: "   " })).toEqual({
      ok: false,
      error: 'missing "title" field',
    });
  });

  it("defaults scope to internal", () => {
    const res = parseUploadFields({ title: "VA Lighting Design Manual PG-18-10 (2022)" });
    expect(res).toEqual({
      ok: true,
      fields: {
        title: "VA Lighting Design Manual PG-18-10 (2022)",
        brand: null,
        scope: "internal",
        forceVision: false,
      },
    });
  });

  it("rejects an unknown scope", () => {
    const res = parseUploadFields({ title: "T", scope: "everyone" });
    expect(res).toEqual({ ok: false, error: 'scope must be "public" or "internal"' });
  });

  it("blocks direct-public upload without the review confirmation", () => {
    const res = parseUploadFields({ title: "T", scope: "public" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("review confirmation");
  });

  it("allows public upload WITH the review confirmation", () => {
    const res = parseUploadFields({ title: "T", scope: "public", confirmed: "true" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.fields.scope).toBe("public");
  });

  it("parses brand and force_vision", () => {
    const res = parseUploadFields({
      title: "T",
      brand: "  WAC Lighting  ",
      force_vision: "1",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.fields.brand).toBe("WAC Lighting");
      expect(res.fields.forceVision).toBe(true);
    }
  });
});

describe("titleEditionWarning (R13 nudge)", () => {
  it("nudges a standards/code title with no edition or year", () => {
    expect(titleEditionWarning("ASHRAE Lighting Guide")).toContain("edition or year");
    expect(titleEditionWarning("Title 24 Part 6")).toContain("edition or year");
  });

  it("is silent when the title carries a year or edition", () => {
    expect(titleEditionWarning("CA Title 24 Part 6 (2025)")).toBeNull();
    expect(titleEditionWarning("IECC lighting guide, 2021 edition")).toBeNull();
  });

  it("is silent for non-standards titles", () => {
    expect(titleEditionWarning("LED fundamentals fact sheet")).toBeNull();
  });
});

describe("isDuplicateUploadError (0059 partial-index conflict)", () => {
  it("matches the unique-violation on the admin-upload hash index", () => {
    expect(
      isDuplicateUploadError({
        code: "23505",
        message: 'duplicate key value violates unique constraint "kb_documents_admin_upload_hash_uniq"',
      }),
    ).toBe(true);
  });

  it("ignores other unique violations and other errors", () => {
    expect(
      isDuplicateUploadError({
        code: "23505",
        message: 'duplicate key value violates unique constraint "kb_documents_source_system_external_id_key"',
      }),
    ).toBe(false);
    expect(isDuplicateUploadError({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isDuplicateUploadError(null)).toBe(false);
  });
});

describe("scopeFlipAllowed (C.4 review gate)", () => {
  it("blocks a flip to public without confirmation", () => {
    const res = scopeFlipAllowed("public", false);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("third-party brand names");
  });

  it("allows a confirmed flip to public", () => {
    expect(scopeFlipAllowed("public", true)).toEqual({ ok: true });
  });

  it("never gates a flip back to internal", () => {
    expect(scopeFlipAllowed("internal", false)).toEqual({ ok: true });
  });
});

describe("isTruncationWarning", () => {
  it("keys off the WARNING prefix the ingest writes", () => {
    expect(isTruncationWarning("WARNING: document exceeded the indexing cap")).toBe(true);
    expect(isTruncationWarning("fetch 502")).toBe(false);
    expect(isTruncationWarning(null)).toBe(false);
    expect(isTruncationWarning(undefined)).toBe(false);
  });
});

describe("sha256HexBytes", () => {
  it("hashes bytes deterministically to lowercase hex", async () => {
    const a = await sha256HexBytes(pdfBuffer());
    const b = await sha256HexBytes(pdfBuffer());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const c = await sha256HexBytes(pdfBuffer(16));
    expect(c).not.toBe(a);
  });
});
