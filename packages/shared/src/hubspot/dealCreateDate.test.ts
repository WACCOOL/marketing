import { describe, expect, it } from "vitest";
import { deriveCreateDate } from "./dealCreateDate.js";

const DAY_MS = 86_400_000;
const NOON_MS = DAY_MS / 2;

const QUOTE_2026_03_10 = Date.UTC(2026, 2, 10); // midnight UTC (date-typed prop)
const NOON_2026_03_10 = QUOTE_2026_03_10 + NOON_MS;
const CREATED_2026_07_02 = Date.UTC(2026, 6, 2, 15, 41, 9); // bulk-import stamp
const NOW = Date.UTC(2026, 6, 6, 14, 0, 0);

describe("deriveCreateDate — update path (existing deal)", () => {
  it("backdates createdate to noon UTC on the quote day when the quote day is earlier", () => {
    const r = deriveCreateDate({
      quoteCreationMs: QUOTE_2026_03_10,
      existingCreateDateMs: CREATED_2026_07_02,
      nowMs: NOW,
    });
    expect(r.properties).toEqual({ createdate: String(NOON_2026_03_10) });
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!).toMatchObject({ property: "createdate", action: "derived" });
    expect(r.actions[0]!.reason).toContain("2026-07-02 → 2026-03-10");
  });

  it("leaves a same-UTC-day createdate alone (different time of day)", () => {
    const r = deriveCreateDate({
      quoteCreationMs: QUOTE_2026_03_10,
      existingCreateDateMs: QUOTE_2026_03_10 + 19 * 3_600_000, // 19:00 UTC same day
      nowMs: NOW,
    });
    expect(r.properties).toEqual({});
    expect(r.actions).toEqual([]);
  });

  it("never moves createdate FORWARD (quote day after createdate)", () => {
    const r = deriveCreateDate({
      quoteCreationMs: QUOTE_2026_03_10,
      existingCreateDateMs: Date.UTC(2026, 0, 15, 9, 0, 0),
      nowMs: NOW,
    });
    expect(r.properties).toEqual({});
  });

  it("is idempotent: feeding the corrected value back yields no write", () => {
    const first = deriveCreateDate({
      quoteCreationMs: QUOTE_2026_03_10,
      existingCreateDateMs: CREATED_2026_07_02,
      nowMs: NOW,
    });
    const second = deriveCreateDate({
      quoteCreationMs: QUOTE_2026_03_10,
      existingCreateDateMs: Number(first.properties.createdate),
      nowMs: NOW,
    });
    expect(second.properties).toEqual({});
  });

  it("corrects across a midnight-UTC boundary (createdate 00:30 UTC = previous evening ET)", () => {
    const r = deriveCreateDate({
      quoteCreationMs: QUOTE_2026_03_10,
      existingCreateDateMs: Date.UTC(2026, 2, 11, 0, 30, 0),
      nowMs: NOW,
    });
    expect(r.properties).toEqual({ createdate: String(NOON_2026_03_10) });
  });
});

describe("deriveCreateDate — create path (existingCreateDateMs null)", () => {
  it("backdates a new deal whose quote day is before today", () => {
    const r = deriveCreateDate({
      quoteCreationMs: QUOTE_2026_03_10,
      existingCreateDateMs: null,
      nowMs: NOW,
    });
    expect(r.properties).toEqual({ createdate: String(NOON_2026_03_10) });
    expect(r.actions[0]!.from).toBeUndefined();
    expect(r.actions[0]!.reason).toContain("new deal");
  });

  it("lets HubSpot stamp same-day quotes (no write, even before noon UTC)", () => {
    const quoteToday = Date.UTC(2026, 6, 6);
    const r = deriveCreateDate({
      quoteCreationMs: quoteToday,
      existingCreateDateMs: null,
      nowMs: Date.UTC(2026, 6, 6, 9, 0, 0), // 09:00 UTC — noon hasn't happened yet
    });
    expect(r.properties).toEqual({});
  });
});

describe("deriveCreateDate — no quote date", () => {
  it("does nothing when quote_creation_date is absent (manual/showroom deals)", () => {
    const r = deriveCreateDate({
      quoteCreationMs: null,
      existingCreateDateMs: CREATED_2026_07_02,
      nowMs: NOW,
    });
    expect(r.properties).toEqual({});
    expect(r.actions).toEqual([]);
  });
});
