import { describe, expect, it } from "vitest";
import {
  UtmAssemblyError,
  auditTaggedUrl,
  buildTaggedUrl,
  validateUtmFields,
} from "./utm.js";

const validCampaign = "39174698_hd_expo_2026";
// The shape the live HubSpot Marketing Campaigns v3 API returns: a UUID id.
const validUuidCampaign = "edb9b6c3-d2e2-4ca8-8396-832262aed0d4_hd_expo_2026";

describe("buildTaggedUrl", () => {
  it("builds a correctly-encoded URL with all four params", () => {
    const url = buildTaggedUrl("https://waclighting.com/products/abc", {
      source: "tradeshow",
      medium: "vignette",
      campaign: validCampaign,
      content: "aia",
    });

    expect(url).toBe(
      "https://waclighting.com/products/abc?utm_source=tradeshow&utm_medium=vignette&utm_campaign=39174698_hd_expo_2026&utm_content=aia",
    );
  });

  it("works when content is omitted", () => {
    const url = buildTaggedUrl("https://waclighting.com/", {
      source: "print",
      medium: "postcard",
      campaign: validCampaign,
    });
    expect(url).toBe(
      "https://waclighting.com/?utm_source=print&utm_medium=postcard&utm_campaign=39174698_hd_expo_2026",
    );
  });

  it("preserves an existing query string and joins with & not ?&", () => {
    const url = buildTaggedUrl(
      "https://schonbek.com/landing?promo=fall",
      {
        source: "social",
        medium: "organic_social",
        campaign: validCampaign,
        content: "ce_pro",
      },
    );

    expect(url).toContain("?promo=fall&utm_source=social");
    // Specifically: NOT the historical "?&utm_source=" bug.
    expect(url).not.toContain("?&");
    // Specifically: NOT the historical glued "2026utm_content=" bug.
    expect(url).not.toMatch(/utm_campaign=[^&]*utm_content=/);
  });

  it("strips and replaces any pre-existing utm_ params (no duplicates)", () => {
    const url = buildTaggedUrl(
      "https://waclighting.com/x?utm_source=OLD&utm_medium=OLD&utm_campaign=OLD&utm_content=OLD&keep=me",
      {
        source: "print",
        medium: "postcard",
        campaign: validCampaign,
        content: "aia",
      },
    );

    const parsed = new URL(url);
    expect(parsed.searchParams.get("utm_source")).toBe("print");
    expect(parsed.searchParams.get("utm_medium")).toBe("postcard");
    expect(parsed.searchParams.get("utm_campaign")).toBe(validCampaign);
    expect(parsed.searchParams.get("utm_content")).toBe("aia");
    expect(parsed.searchParams.get("keep")).toBe("me");
    expect(parsed.searchParams.getAll("utm_source")).toHaveLength(1);
  });

  it("accepts a live HubSpot UUID campaign id", () => {
    const url = buildTaggedUrl("https://waclighting.com/", {
      source: "tradeshow",
      medium: "vignette",
      campaign: validUuidCampaign,
      content: "aia",
    });
    expect(new URL(url).searchParams.get("utm_campaign")).toBe(
      validUuidCampaign,
    );

    const res = validateUtmFields({
      source: "tradeshow",
      medium: "vignette",
      campaign: validUuidCampaign,
    });
    expect(res.ok).toBe(true);
  });

  it("lower-cases every utm value but leaves the destination path/query alone", () => {
    const url = buildTaggedUrl("https://waclighting.com/Products/ABC?Ref=Keep", {
      source: "Email",
      medium: "Paid_Media",
      campaign: validCampaign,
      content: "AIA",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("utm_source")).toBe("email");
    expect(parsed.searchParams.get("utm_medium")).toBe("paid_media");
    expect(parsed.searchParams.get("utm_content")).toBe("aia");
    // Destination casing is preserved — only utm_* values are normalized.
    expect(parsed.pathname).toBe("/Products/ABC");
    expect(parsed.searchParams.get("Ref")).toBe("Keep");
  });

  it("encodes values that contain non-ASCII characters", () => {
    const url = buildTaggedUrl("https://example.com/", {
      source: "caf\u00e9",
      medium: "search",
      campaign: validCampaign,
    });
    // The raw URL is percent-encoded…
    expect(url).toContain("utm_source=caf%C3%A9");
    // …and decodes back round-trip.
    expect(new URL(url).searchParams.get("utm_source")).toBe("caf\u00e9");
  });
});

describe("buildTaggedUrl — explicit guard against current-sheet bugs", () => {
  it("rejects bare-string campaigns (the _2026 / _2027 drift bug)", () => {
    expect(() =>
      buildTaggedUrl("https://waclighting.com/", {
        source: "print",
        medium: "postcard",
        // The current sheet often has just "hd_expo_2026" or "hd_expo_2027".
        campaign: "hd_expo_2026",
      }),
    ).toThrow(UtmAssemblyError);
  });

  it("rejects campaigns with a drifting year suffix that lacks a hubspot id", () => {
    for (const bad of ["hd_expo_2027", "hd_expo_2028", "lightovation_2026"]) {
      const res = validateUtmFields({
        source: "print",
        medium: "postcard",
        campaign: bad,
      });
      expect(res.ok).toBe(false);
    }
  });

  it("rejects a malformed/partial UUID campaign id", () => {
    // Truncated UUID (missing the final segment) must not slip through.
    for (const bad of [
      "edb9b6c3-d2e2-4ca8-8396_hd_expo_2026",
      "edb9b6c3d2e24ca88396832262aed0d4_hd_expo_2026",
    ]) {
      const res = validateUtmFields({
        source: "print",
        medium: "postcard",
        campaign: bad,
      });
      expect(res.ok).toBe(false);
    }
  });

  it("rejects values containing query control characters", () => {
    expect(() =>
      buildTaggedUrl("https://waclighting.com/", {
        source: "print&injected",
        medium: "postcard",
        campaign: validCampaign,
      }),
    ).toThrow(UtmAssemblyError);
  });

  it("rejects internal whitespace in values (e.g. 'paid media' instead of 'paid_media')", () => {
    expect(() =>
      buildTaggedUrl("https://waclighting.com/", {
        source: "paid media",
        medium: "postcard",
        campaign: validCampaign,
      }),
    ).toThrow(UtmAssemblyError);
  });

  it("forgives leading/trailing whitespace (common copy-paste artifact)", () => {
    // Trimmed automatically — should NOT throw.
    const url = buildTaggedUrl("https://waclighting.com/", {
      source: " print",
      medium: "postcard ",
      campaign: validCampaign,
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("utm_source")).toBe("print");
    expect(parsed.searchParams.get("utm_medium")).toBe("postcard");
  });

  it("requires the destination to be an absolute http(s) URL", () => {
    expect(() =>
      buildTaggedUrl("waclighting.com/oops", {
        source: "print",
        medium: "postcard",
        campaign: validCampaign,
      }),
    ).toThrow(/valid absolute URL/);

    expect(() =>
      buildTaggedUrl("ftp://example.com/", {
        source: "print",
        medium: "postcard",
        campaign: validCampaign,
      }),
    ).toThrow(/http\(s\)/);
  });
});

describe("auditTaggedUrl", () => {
  it("returns no problems for a clean URL", () => {
    const ok = buildTaggedUrl("https://waclighting.com/", {
      source: "print",
      medium: "postcard",
      campaign: validCampaign,
      content: "aia",
    });
    expect(auditTaggedUrl(ok)).toEqual([]);
  });

  it("flags the literal current-sheet bug strings", () => {
    // The exact bug from the PRD: stray ampersand after the question mark.
    const bug1 =
      "https://waclighting.com/?&utm_source=print&utm_medium=postcard&utm_campaign=39174698_hd_expo_2026";
    expect(auditTaggedUrl(bug1)).toContain(
      "Found '?&' (stray ampersand after question mark)",
    );

    // The exact bug from the PRD: missing & before utm_content.
    const bug2 =
      "https://waclighting.com/?utm_source=print&utm_medium=postcard&utm_campaign=39174698_hd_expo_2026utm_content=aia";
    const problems2 = auditTaggedUrl(bug2);
    expect(
      problems2.some((p) => /glued onto utm_campaign/.test(p)),
    ).toBe(true);
  });

  it("flags missing required params", () => {
    const problems = auditTaggedUrl(
      "https://waclighting.com/?utm_source=print",
    );
    expect(problems).toContain("Missing utm_medium");
    expect(problems).toContain("Missing utm_campaign");
  });
});
