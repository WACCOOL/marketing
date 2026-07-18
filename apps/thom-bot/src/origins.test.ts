import { describe, it, expect } from "vitest";
import { originAllowed, frameAncestors } from "./origins.js";

describe("originAllowed", () => {
  const env = { ALLOWED_ORIGINS: "https://www.waclighting.com, https://www.modernforms.com" };

  it("allows an exact configured origin", () => {
    expect(originAllowed(env, "https://www.waclighting.com")).toBe(true);
    expect(originAllowed(env, "https://www.modernforms.com")).toBe(true);
  });

  it("rejects an origin not on the list", () => {
    expect(originAllowed(env, "https://evil.example.com")).toBe(false);
    // No substring / suffix matching.
    expect(originAllowed(env, "https://www.waclighting.com.evil.com")).toBe(false);
  });

  it("rejects a null origin", () => {
    expect(originAllowed(env, null)).toBe(false);
  });

  it("does NOT allow localhost when an allowlist is configured", () => {
    expect(originAllowed(env, "http://localhost:5173")).toBe(false);
  });

  it("allows localhost / 127.0.0.1 (any port) when the allowlist is empty", () => {
    expect(originAllowed({ ALLOWED_ORIGINS: "" }, "http://localhost:5173")).toBe(true);
    expect(originAllowed({}, "http://127.0.0.1:8788")).toBe(true);
    expect(originAllowed({}, "https://localhost")).toBe(true);
  });

  it("rejects non-localhost when the allowlist is empty (prod-closed)", () => {
    expect(originAllowed({ ALLOWED_ORIGINS: "" }, "https://example.com")).toBe(false);
  });
});

describe("frameAncestors", () => {
  it("joins configured origins", () => {
    expect(frameAncestors({ ALLOWED_ORIGINS: "https://a.com, https://b.com" })).toBe(
      "https://a.com https://b.com",
    );
  });

  it("falls back to localhost sources when unset", () => {
    expect(frameAncestors({})).toBe("http://localhost:* http://127.0.0.1:*");
  });
});
