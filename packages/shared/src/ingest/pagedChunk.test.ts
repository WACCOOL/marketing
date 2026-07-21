import { describe, expect, it } from "vitest";
import { chunkText } from "./chunk.js";
import { ADMIN_UPLOAD_MAX_CHUNKS, pagedChunk } from "./pagedChunk.js";

describe("pagedChunk", () => {
  it("returns no chunks for empty page arrays", () => {
    expect(pagedChunk([])).toEqual({ chunks: [], truncated: false, pageCount: 0 });
    expect(pagedChunk(["", "   \n  "])).toEqual({ chunks: [], truncated: false, pageCount: 2 });
  });

  it("keeps a short single page as one chunk on page 1", () => {
    const res = pagedChunk(["  Hello world.  "]);
    expect(res.chunks).toEqual([{ index: 0, content: "Hello world.", page: 1 }]);
    expect(res.truncated).toBe(false);
    expect(res.pageCount).toBe(1);
  });

  it("assigns each chunk the page its first character came from", () => {
    // Three pages of ~330 chars with a 400-char target and no overlap: the
    // chunker prefers the paragraph boundary (= the page join), so each page
    // becomes exactly one chunk stamped with its own page number.
    const pages = [
      "Page one text. ".repeat(22),
      "Page two text. ".repeat(22),
      "Page three text. ".repeat(20),
    ];
    const res = pagedChunk(pages, { targetChars: 400, overlapChars: 0 });
    expect(res.chunks).toHaveLength(3);
    expect(res.chunks.map((c) => c.page)).toEqual([1, 2, 3]);
    const p3 = res.chunks.find((c) => c.content.startsWith("Page three"));
    expect(p3?.page).toBe(3);
    // Pages are non-decreasing even with overlap in play.
    const overlapped = pagedChunk(pages, { targetChars: 400, overlapChars: 60 });
    let prev = 0;
    for (const c of overlapped.chunks) {
      expect(c.page).toBeGreaterThanOrEqual(prev);
      prev = c.page;
    }
    expect(overlapped.chunks[0]!.page).toBe(1);
  });

  it("keeps ORIGINAL page numbers when blank pages are interleaved", () => {
    const res = pagedChunk(["", "Only real page.", ""]);
    expect(res.chunks).toEqual([{ index: 0, content: "Only real page.", page: 2 }]);
    expect(res.pageCount).toBe(3);
  });

  it("produces the same chunk contents as chunkText over the joined pages", () => {
    const pages = ["Alpha section. ".repeat(50), "Beta section. ".repeat(50)];
    const joined = pages.map((p) => p.trim()).join("\n\n");
    const plain = chunkText(joined, { targetChars: 300, overlapChars: 30 });
    const paged = pagedChunk(pages, { targetChars: 300, overlapChars: 30 });
    expect(paged.chunks.map((c) => c.content)).toEqual(plain.map((c) => c.content));
  });

  it("defaults maxChunks to the admin-upload cap (2000), not chunkText's 400", () => {
    // ~1200 chunks worth of text at target 100: the default 400 cap would
    // truncate; the admin cap must not.
    const bigPage = "word ".repeat(6000); // 30k chars
    const pages = Array.from({ length: 5 }, () => bigPage);
    const res = pagedChunk(pages, { targetChars: 100, overlapChars: 0 });
    expect(res.chunks.length).toBeGreaterThan(400);
    expect(res.truncated).toBe(false);
    expect(ADMIN_UPLOAD_MAX_CHUNKS).toBe(2000);
  });

  it("reports truncation when the cap is hit with pages remaining", () => {
    const bigPage = "word ".repeat(6000);
    const pages = Array.from({ length: 3 }, () => bigPage);
    const res = pagedChunk(pages, { targetChars: 100, overlapChars: 0, maxChunks: 10 });
    expect(res.chunks).toHaveLength(10);
    expect(res.truncated).toBe(true);
    // Truncation drops the LATER pages: everything kept is from page 1.
    expect(res.chunks.every((c) => c.page === 1)).toBe(true);
  });
});
