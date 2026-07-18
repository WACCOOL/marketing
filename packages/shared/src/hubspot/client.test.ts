import { describe, expect, it } from "vitest";
import { clamp } from "./client.js";

describe("clamp", () => {
  it("keeps a value already inside the range", () => {
    expect(clamp(10, 1, 200)).toBe(10);
  });
  it("clamps below the floor and above the ceiling", () => {
    expect(clamp(0, 1, 200)).toBe(1);
    expect(clamp(500, 1, 200)).toBe(200);
  });
  it("truncates fractional inputs", () => {
    expect(clamp(10.9, 1, 200)).toBe(10);
  });
  it("falls back to the floor for non-finite inputs", () => {
    expect(clamp(NaN, 1, 200)).toBe(1);
    expect(clamp(Infinity, 1, 200)).toBe(1);
  });
});
