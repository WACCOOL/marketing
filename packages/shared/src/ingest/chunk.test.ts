import { describe, expect, it } from "vitest";
import { chunkText, estimateTokens } from "./chunk.js";

describe("chunkText", () => {
  it("returns no chunks for empty / whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t  ")).toEqual([]);
  });

  it("keeps short text as a single chunk with a trimmed body", () => {
    const chunks = chunkText("  Hello world.  ");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ index: 0, content: "Hello world." });
  });

  it("splits long text into overlapping, sequentially-indexed chunks", () => {
    const para = "This is a sentence that repeats. ".repeat(400); // ~13k chars
    const chunks = chunkText(para, { targetChars: 400, overlapChars: 60 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => expect(c.index).toBe(i));
    // Each chunk stays near the target size (never wildly over).
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(400);
  });

  it("prefers to break on a paragraph boundary near the target", () => {
    const first = "A".repeat(300);
    const second = "B".repeat(300);
    const chunks = chunkText(`${first}\n\n${second}`, {
      targetChars: 400,
      overlapChars: 20,
    });
    // The first chunk should end at the paragraph break, not mid-run.
    expect(chunks[0]!.content).toBe(first);
  });

  it("honors the maxChunks safety cap", () => {
    const huge = "word ".repeat(100_000);
    const chunks = chunkText(huge, { targetChars: 100, overlapChars: 10, maxChunks: 5 });
    expect(chunks.length).toBeLessThanOrEqual(5);
  });
});

describe("estimateTokens", () => {
  it("estimates ~4 chars per token, minimum 1", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});
