import { describe, expect, it } from "vitest";
import { matchScore, pickRepresentative, tokenize } from "./match.js";

describe("tokenize", () => {
  it("splits on non-alphanumerics, keeping alphanumeric codes whole", () => {
    expect(tokenize("R2RAT-FTWA-WT(15W at 4000K)")).toEqual([
      "R2RAT", "FTWA", "WT", "15W", "AT", "4000K",
    ]);
  });

  it("uppercases and drops empties", () => {
    expect(tokenize("aels410-78mt130bk")).toEqual(["AELS410", "78MT130BK"]);
  });
});

describe("matchScore", () => {
  it("scores an exact family+optic filename higher than a sibling optic", () => {
    const sku = "R2RAT-FTWA-WT";
    const exact = matchScore(sku, "R2RAT-FTWA-WT(15W at 4000K).IES");
    const sibling = matchScore(sku, "R2RAT-NTWB-WT(22W at 6500K).IES");
    expect(exact).toBeGreaterThan(sibling);
  });

  it("returns 0 when nothing overlaps", () => {
    expect(matchScore("R2RAT-FTWA-WT", "AELS410-78MT130BK.IES")).toBe(0);
  });

  it("full SKU coverage yields a high score", () => {
    expect(matchScore("R2RD1T-WTWA-WT", "R2RD1T-WTWA-WT.IES")).toBeGreaterThan(0.9);
  });
});

describe("pickRepresentative", () => {
  it("picks the best-matching inner file", () => {
    const files = [
      "R2RAT-NTWB-WT(22W at 6500K).IES",
      "R2RAT-FTWA-WT(15W at 4000K).IES",
      "R2RAT-WTWA-WT(15W at 4000K).IES",
    ];
    const pick = pickRepresentative("R2RAT-FTWA-WT", files);
    expect(pick.index).toBe(1);
    expect(pick.confidence).toBeGreaterThan(0);
    expect(pick.scores).toHaveLength(3);
  });

  it("ties resolve to the earliest file", () => {
    const files = ["A-B.IES", "A-B.IES"];
    expect(pickRepresentative("A-B", files).index).toBe(0);
  });

  it("falls back to the first file with confidence 0 when nothing matches", () => {
    const files = ["ZZZ-1.IES", "YYY-2.IES"];
    const pick = pickRepresentative("R2RAT-FTWA-WT", files);
    expect(pick.index).toBe(0);
    expect(pick.confidence).toBe(0);
  });

  it("handles an empty file list", () => {
    expect(pickRepresentative("X", []).index).toBe(-1);
  });
});
