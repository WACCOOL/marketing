import { describe, expect, it } from "vitest";
import { normalizeFixtureKey, skuLookupCandidates } from "./fixture.js";

describe("skuLookupCandidates", () => {
  it("yields the full SKU then progressively strips dash-joined suffix tokens", () => {
    expect(skuLookupCandidates("bl248606-wv-ab")).toEqual([
      "bl248606-wv-ab",
      "bl248606-wv",
      "bl248606",
    ]);
  });

  it("lowercases and trims", () => {
    expect(skuLookupCandidates("  BFM31612-AB ")).toEqual([
      "bfm31612-ab",
      "bfm31612",
    ]);
  });

  it("returns a dash-less SKU as a single candidate", () => {
    expect(skuLookupCandidates("bpd42635")).toEqual(["bpd42635"]);
  });

  it("never strips down to an absurdly short stem", () => {
    expect(skuLookupCandidates("ab-cd-ef")).toEqual(["ab-cd-ef", "ab-cd"]);
    expect(skuLookupCandidates("ab")).toEqual(["ab"]);
  });
});

describe("normalizeFixtureKey", () => {
  it("lowercases and is idempotent for ordinary keys", () => {
    expect(normalizeFixtureKey("bfm31612-ab")).toBe("bfm31612-ab");
    expect(normalizeFixtureKey("BFM31612-AB")).toBe("bfm31612-ab");
    expect(normalizeFixtureKey("bfm30616_scn010")).toBe("bfm30616_scn010");
    const once = normalizeFixtureKey("BFM_X-1");
    expect(normalizeFixtureKey(once)).toBe(once);
  });

  it("strips characters outside [a-z0-9_-] so the key is URL-safe", () => {
    expect(normalizeFixtureKey("bf m.31612")).toBe("bfm31612");
    expect(normalizeFixtureKey("café-1")).toBe("caf-1");
  });

  it("matches what the thumb-file route accepts (the write key == the read key)", () => {
    // GET /thumb-file/:file requires /^[a-z0-9_-]+\.png$/.
    const allowed = /^[a-z0-9_-]+$/;
    for (const raw of ["BFM31612-AB", "bfm30616_scn010", "a B.c/d"]) {
      const key = normalizeFixtureKey(raw);
      expect(key).toMatch(allowed);
      // The web fixtureThumbUrl and the API cacheFixtureThumb both normalize the
      // same way, so a key normalized once survives a second normalization
      // (encodeURIComponent would leave it untouched too).
      expect(encodeURIComponent(key)).toBe(key);
    }
  });
});
