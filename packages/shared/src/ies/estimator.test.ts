import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNIFORMITY_RATIO,
  ESTIMATOR_TASKS,
  REFLECTANCE_PRESETS,
  findTask,
  tasksForTarget,
} from "./estimator.js";

describe("findTask", () => {
  it("looks up a task by key", () => {
    const t = findTask("office-general");
    expect(t).toBeDefined();
    expect(t!.fc).toBe(30);
    expect(t!.appliesTo).toContain("horizontal");
  });

  it("returns undefined for an unknown key", () => {
    expect(findTask("does-not-exist")).toBeUndefined();
  });
});

describe("tasksForTarget", () => {
  it("filters by target orientation, defaulting to indoor", () => {
    const horiz = tasksForTarget("horizontal");
    expect(horiz.length).toBeGreaterThan(0);
    expect(horiz.every((t) => t.appliesTo.includes("horizontal"))).toBe(true);
    // Default environment is indoor — no outdoor-only tasks leak in.
    expect(horiz.every((t) => (t.environment ?? "indoor") !== "outdoor")).toBe(true);
  });

  it("surfaces outdoor tasks when the outdoor environment is requested", () => {
    const outdoor = tasksForTarget("horizontal", "outdoor");
    expect(outdoor.some((t) => t.key === "outdoor-pathway")).toBe(true);
    // Indoor-only tasks are excluded.
    expect(outdoor.some((t) => t.key === "office-general")).toBe(false);
  });

  it("filters vertical tasks", () => {
    const vert = tasksForTarget("vertical");
    expect(vert.every((t) => t.appliesTo.includes("vertical"))).toBe(true);
    expect(vert.some((t) => t.key === "wall-wash-general")).toBe(true);
  });
});

describe("REFLECTANCE_PRESETS", () => {
  it("every preset has ceiling/wall/floor reflectances", () => {
    expect(REFLECTANCE_PRESETS.length).toBeGreaterThan(0);
    for (const p of REFLECTANCE_PRESETS) {
      expect(typeof p.key).toBe("string");
      expect(typeof p.label).toBe("string");
      expect(p.values.ceiling).toBeGreaterThan(0);
      expect(p.values.wall).toBeGreaterThan(0);
      expect(p.values.floor).toBeGreaterThan(0);
    }
  });
});

describe("ESTIMATOR_TASKS", () => {
  it("has the full reference table with unique keys", () => {
    expect(ESTIMATOR_TASKS).toHaveLength(29);
    const keys = new Set(ESTIMATOR_TASKS.map((t) => t.key));
    expect(keys.size).toBe(ESTIMATOR_TASKS.length);
  });

  it("exposes a sane default uniformity ratio", () => {
    expect(DEFAULT_UNIFORMITY_RATIO).toBeGreaterThan(1);
  });
});
