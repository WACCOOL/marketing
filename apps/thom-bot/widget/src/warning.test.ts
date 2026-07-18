import { describe, it, expect } from "vitest";
import { WARNING_COPY } from "./app.js";

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
