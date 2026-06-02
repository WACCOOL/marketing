import { describe, expect, it } from "vitest";
import { normalizeHeaderRow, processBulkRow } from "./bulk.js";

describe("normalizeHeaderRow", () => {
  it("maps the existing UTM Generator.xlsx headers", () => {
    const map = normalizeHeaderRow([
      "PROJECT",
      "QR CODE NAME",
      "LINK",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
    ]);
    expect(map).toEqual({
      PROJECT: "project",
      "QR CODE NAME": "qrName",
      LINK: "link",
      utm_source: "source",
      utm_medium: "medium",
      utm_campaign: "campaign",
      utm_content: "content",
    });
  });

  it("ignores unrelated columns", () => {
    const map = normalizeHeaderRow(["PROJECT", "Random Notes"]);
    expect(map).toEqual({ PROJECT: "project" });
  });
});

describe("processBulkRow", () => {
  it("builds a tagged URL for a good row", () => {
    const result = processBulkRow(
      {
        project: "Lightovation",
        qrName: "lightovation_postcard",
        link: "https://waclighting.com/lightovation",
        source: "print",
        medium: "postcard",
        campaign: "39174698_lightovation_2026",
        content: "aia",
      },
      0,
    );

    expect(result.ok).toBe(true);
    expect(result.taggedUrl).toContain(
      "utm_campaign=39174698_lightovation_2026",
    );
  });

  it("returns errors for an invalid row", () => {
    const result = processBulkRow(
      {
        qrName: "",
        link: "not a url",
        source: "",
        medium: "",
        campaign: "",
      },
      3,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.rowIndex).toBe(3);
  });
});
