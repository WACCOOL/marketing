import { describe, expect, it } from "vitest";
import {
  EXCEL_XLSX,
  getSource,
  getVariant,
  listIngestableSources,
  listSources,
  SOURCES,
} from "./registry.js";

describe("ingest source registry", () => {
  it("keys match their map entry and r2 prefix", () => {
    for (const [key, src] of Object.entries(SOURCES)) {
      expect(src.key).toBe(key);
      expect(src.r2Prefix).toBe(key);
    }
  });

  it("getSource resolves known sources and rejects unknown", () => {
    expect(getSource("open-orders")?.label).toContain("Open Orders");
    expect(getSource("nope")).toBeUndefined();
  });

  it("lists the four initial sources, three of them ingestable", () => {
    expect(listSources()).toHaveLength(4);
    const ingestable = listIngestableSources().map((s) => s.key);
    expect(ingestable).toEqual(["open-orders", "territory", "pricing"]);
    // Sales Layer is cron-driven — present in the destination map, not the inbox.
    expect(getSource("sales-layer")?.ingestable).toBe(false);
  });

  it("ingestable sources accept Excel and carry a real size cap", () => {
    for (const src of listIngestableSources()) {
      expect(src.acceptedContentTypes).toContain(EXCEL_XLSX);
      expect(src.maxBytes).toBeGreaterThan(0);
      expect(src.defaultExt).toBe("xlsx");
    }
  });

  it("pricing is a manual multi-variant source; others are single-file", () => {
    const pricing = getSource("pricing")!;
    expect(pricing.authMode).toBe("manual");
    expect(pricing.variants).toHaveLength(4);
    expect(getVariant(pricing, "price-book-1")?.label).toBe("Price Book 1");
    expect(getVariant(pricing, "bogus")).toBeUndefined();

    expect(getSource("open-orders")?.variants).toBeUndefined();
    expect(getSource("territory")?.authMode).toBe("automated");
  });

  it("every source declares a HubSpot destination for the future push", () => {
    for (const src of listSources()) {
      expect(src.hubspot.object).toBeTruthy();
    }
  });
});
