import { describe, expect, it } from "vitest";
import { codeFromAssetUrl, deriveModelCodes } from "./pdpcode.js";

const IMG = "https://aispire.s3.amazonaws.com/files";

describe("codeFromAssetUrl", () => {
  const cases: [string, string | null][] = [
    [`${IMG}/A1RD-D571F-CCBK_IMRO_1.png`, "A1RD-D571F-CCBK"],
    [`${IMG}/A1RD-D571-V0_IESF.zip`, "A1RD-D571-V0"],
    [`${IMG}/1/MT-LED118_IES.zip`, "MT-LED118"],
    // decodeURIComponent before splitting on the underscore.
    [`${IMG}/HR-LED418-N_%281%29.zip`, "HR-LED418-N"],
    // query string is dropped.
    [`${IMG}/A2L30-CL_IMRO_1.png?v=3`, "A2L30-CL"],
    ["", null],
    ["https://x/", null],
  ];
  for (const [url, want] of cases) {
    it(`${url || "<empty>"} -> ${want}`, () => {
      expect(codeFromAssetUrl(url)).toBe(want);
    });
  }
  it("handles null/undefined", () => {
    expect(codeFromAssetUrl(null)).toBeNull();
    expect(codeFromAssetUrl(undefined)).toBeNull();
  });
});

describe("deriveModelCodes", () => {
  it("full code + gated finish truncation from an image", () => {
    expect(deriveModelCodes({ primary_image_url: `${IMG}/A1RD-D571F-CCBK_IMRO_1.png` })).toEqual([
      "A1RD-D571F-CCBK",
      "A1RD-D571F",
    ]);
  });

  it("IES: strips the -V<n> variant marker", () => {
    expect(deriveModelCodes({ ies_url: `${IMG}/A1RD-D571-V0_IESF.zip` })).toEqual(["A1RD-D571"]);
  });

  it("does not strip a numeric trailing segment (-072), only the finish", () => {
    expect(deriveModelCodes({ primary_image_url: `${IMG}/A2L33-072-WT_IMRO_1.png` })).toEqual([
      "A2L33-072-WT",
      "A2L33-072",
    ]);
  });

  it("guards short stems: A2L30-CL does NOT yield A2L30 (len 5)", () => {
    expect(deriveModelCodes({ primary_image_url: `${IMG}/A2L30-CL_IMRO_1.png` })).toEqual([
      "A2L30-CL",
    ]);
  });

  it("dual finish suffix truncates (HHT-8145LED-BNWT -> HHT-8145LED)", () => {
    const out = deriveModelCodes({ primary_image_url: `${IMG}/HHT-8145LED-BNWT_IMRO_1.jpg` });
    expect(out).toContain("HHT-8145LED");
    expect(out[0]).toBe("HHT-8145LED-BNWT");
  });

  it("3-letter / odd suffix is not a finish token (LENS-11-HLD stays whole)", () => {
    expect(deriveModelCodes({ primary_image_url: `${IMG}/LENS-11-HLD_LINDR.jpg` })).toEqual([
      "LENS-11-HLD",
    ]);
  });

  it("MT-LED118 from an IES asset (no finish, no variant marker)", () => {
    expect(deriveModelCodes({ ies_url: `${IMG}/1/MT-LED118_IES.zip` })).toEqual(["MT-LED118"]);
  });

  it("decodes %28%29 in an IES basename (HR-LED418-N)", () => {
    expect(deriveModelCodes({ ies_url: `${IMG}/HR-LED418-N_%281%29.zip` })).toEqual([
      "HR-LED418-N",
    ]);
  });

  it("null / empty input yields []", () => {
    expect(deriveModelCodes({})).toEqual([]);
    expect(deriveModelCodes({ primary_image_url: null, image_urls: null, ies_url: null })).toEqual(
      [],
    );
    expect(deriveModelCodes({ image_urls: [null, ""] })).toEqual([]);
  });

  it("orders image-derived codes before ies-derived", () => {
    expect(
      deriveModelCodes({
        primary_image_url: `${IMG}/A2L33-072-WT_IMRO_1.png`,
        ies_url: `${IMG}/MT-LED118-V0_IESF.zip`,
      }),
    ).toEqual(["A2L33-072-WT", "A2L33-072", "MT-LED118"]);
  });

  it("de-dupes across primary_image_url, image_urls and ies_url", () => {
    expect(
      deriveModelCodes({
        primary_image_url: `${IMG}/A1RD-D571-V0_IMRO_1.png`,
        image_urls: [`${IMG}/A1RD-D571-V0_IMRO_2.png`],
        ies_url: `${IMG}/A1RD-D571-V0_IESF.zip`,
      }),
    ).toEqual(["A1RD-D571-V0", "A1RD-D571"]);
  });

  it("caps candidates at 4", () => {
    const out = deriveModelCodes({
      primary_image_url: `${IMG}/A1RD-D571F-CCBK_IMRO_1.png`, // -> 2
      image_urls: [
        `${IMG}/A2L33-072-WT_IMRO_1.png`, // -> 2 more (4 total, then cut)
        `${IMG}/HHT-8145LED-BNWT_IMRO_1.jpg`, // dropped by cap
      ],
      ies_url: `${IMG}/MT-LED118_IESF.zip`, // dropped by cap
    });
    expect(out).toHaveLength(4);
    expect(out).toEqual(["A1RD-D571F-CCBK", "A1RD-D571F", "A2L33-072-WT", "A2L33-072"]);
  });
});
