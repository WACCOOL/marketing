import { describe, it, expect } from "vitest";
import { FEEDBACK_DISCLOSURE_COPY, FEEDBACK_LABEL_COPY, WARNING_COPY } from "./app.js";

/** The start-of-chat disclaimer is a product-mandated EXACT string. This test
 *  locks the wording (and the house copy rules) so it can't silently drift. */
const EXPECTED =
  "Thom is an AI assistant and can make mistakes. Answers, including specs, " +
  "compatibility, and availability, aren't guaranteed. Please confirm anything " +
  "important with WAC Group or your sales rep before you rely on it.";

describe("start-of-chat warning", () => {
  it("matches the exact required copy", () => {
    expect(WARNING_COPY).toBe(EXPECTED);
  });

  it("obeys the house copy rules (no em dash, uses 'WAC Group')", () => {
    expect(WARNING_COPY).not.toContain("—");
    expect(WARNING_COPY).toContain("WAC Group");
    // no bare "WAC" that isn't "WAC Group" / "WAC Lighting" etc.
    expect(/\bWAC\b(?! Group| Lighting)/.test(WARNING_COPY)).toBe(false);
  });
});

describe("feedback disclosure (F4 — static line with the thumbs row)", () => {
  it("matches the drafted copy pending Davis sign-off", () => {
    expect(FEEDBACK_DISCLOSURE_COPY).toBe(
      "Sending feedback shares this question and Thom's answer with WAC Group " +
        "so we can improve Thom.",
    );
  });

  it("obeys the house copy rules (no em dash, uses 'WAC Group')", () => {
    expect(FEEDBACK_DISCLOSURE_COPY).not.toContain("—");
    expect(FEEDBACK_DISCLOSURE_COPY).toContain("WAC Group");
    expect(/\bWAC\b(?! Group| Lighting)/.test(FEEDBACK_DISCLOSURE_COPY)).toBe(false);
  });
});

describe("feedback quality label (renders with the thumbs row, below the bubble)", () => {
  it("frames the thumbs as a response-quality rating", () => {
    expect(FEEDBACK_LABEL_COPY).toBe("Was this response helpful?");
  });

  it("obeys the house copy rules (no em dash, no bare 'WAC')", () => {
    expect(FEEDBACK_LABEL_COPY).not.toContain("—");
    expect(/\bWAC\b(?! Group| Lighting)/.test(FEEDBACK_LABEL_COPY)).toBe(false);
  });
});
