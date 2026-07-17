import { describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { shouldEscalate, tieringEnabled, type EscalationState } from "./agent.js";

const state = (over: Partial<EscalationState> = {}): EscalationState => ({
  toolCallCount: 0,
  docPassageCount: 0,
  productCount: 0,
  userMessage: "",
  ...over,
});

describe("shouldEscalate", () => {
  it("stays on the router for a greeting with no tool activity", () => {
    expect(shouldEscalate(state({ userMessage: "hey there" }))).toBe(false);
  });

  it("stays on the router for a single simple lookup", () => {
    expect(
      shouldEscalate(
        state({ toolCallCount: 1, productCount: 1, userMessage: "specs for the 3011?" }),
      ),
    ).toBe(false);
  });

  it("escalates on multi-doc synthesis (2+ passages)", () => {
    expect(shouldEscalate(state({ docPassageCount: 2 }))).toBe(true);
  });

  it("escalates on multi-product work (2+ cards)", () => {
    expect(shouldEscalate(state({ productCount: 2 }))).toBe(true);
  });

  it("escalates on a long tool chain (3+ calls)", () => {
    expect(shouldEscalate(state({ toolCallCount: 3 }))).toBe(true);
  });

  it("escalates a comparison once there is a tool result to compare", () => {
    expect(
      shouldEscalate(
        state({ toolCallCount: 1, userMessage: "compare the 3011 vs 3021" }),
      ),
    ).toBe(true);
  });

  it("does NOT escalate comparison intent before any tool has run (gated)", () => {
    expect(
      shouldEscalate(state({ toolCallCount: 0, userMessage: "compare the 3011 vs 3021" })),
    ).toBe(false);
  });

  it("does NOT over-match a plain 'X or Y?' question", () => {
    expect(
      shouldEscalate(
        state({ toolCallCount: 1, userMessage: "Do you have downlights or track heads?" }),
      ),
    ).toBe(false);
  });
});

describe("tieringEnabled", () => {
  it("is on when unset (default)", () => {
    expect(tieringEnabled({} as Env)).toBe(true);
  });
  it("is on when explicitly \"1\"", () => {
    expect(tieringEnabled({ THOM_TIERING: "1" } as Env)).toBe(true);
  });
  it("is off when explicitly \"0\" (safe rollback)", () => {
    expect(tieringEnabled({ THOM_TIERING: "0" } as Env)).toBe(false);
  });
});
