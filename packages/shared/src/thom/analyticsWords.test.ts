import { describe, expect, it } from "vitest";
import { wordFrequencies } from "./analyticsWords.js";

describe("wordFrequencies", () => {
  it("weights words by query hit counts and ranks descending", () => {
    const out = wordFrequencies([
      { query: "outdoor track lighting", hits: 5 },
      { query: "track heads", hits: 3 },
      { query: "smart landscape", hits: 2 },
    ]);
    expect(out[0]).toEqual({ word: "track", hits: 8 });
    expect(out).toContainEqual({ word: "outdoor", hits: 5 });
    expect(out).toContainEqual({ word: "landscape", hits: 2 });
  });

  it("drops stopwords, domain noise, and short tokens", () => {
    const out = wordFrequencies([{ query: "what is the WAC lighting for my TV", hits: 9 }]);
    const words = out.map((w) => w.word);
    expect(words).not.toContain("wac");
    expect(words).not.toContain("lighting");
    expect(words).not.toContain("the");
    expect(words).not.toContain("tv"); // < 3 chars
  });

  it("counts a repeated word once per query but keeps hyphenated codes", () => {
    const out = wordFrequencies([{ query: "track track fr-w1801 track", hits: 4 }]);
    expect(out).toContainEqual({ word: "track", hits: 4 });
    expect(out).toContainEqual({ word: "fr-w1801", hits: 4 });
  });
});
