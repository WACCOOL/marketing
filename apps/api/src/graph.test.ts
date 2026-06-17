import { describe, expect, it } from "vitest";
import { driveItemMarker, encodeShareUrl } from "./graph.js";

describe("graph helpers", () => {
  it("encodeShareUrl produces a Graph base64url share id", () => {
    // Per the Shares API: "u!" + base64url(url), padding stripped.
    const id = encodeShareUrl("https://contoso.sharepoint.com/:x:/s/Team/AbC+/d?e=1");
    expect(id.startsWith("u!")).toBe(true);
    expect(id).not.toContain("=");
    expect(id).not.toContain("/");
    expect(id).not.toContain("+");
  });

  it("encodeShareUrl round-trips back to the original URL", () => {
    const url = "https://waclightingus.sharepoint.com/:x:/s/InsideSales-WACShowroom/IQDS9hL4";
    const id = encodeShareUrl(url).slice(2); // drop "u!"
    const b64 = id.replace(/-/g, "+").replace(/_/g, "/");
    expect(atob(b64)).toBe(url);
  });

  it("driveItemMarker prefers eTag, falls back to modified time then id", () => {
    expect(driveItemMarker({ id: "1", name: "f", eTag: "etag-1" })).toBe("etag-1");
    expect(
      driveItemMarker({ id: "1", name: "f", lastModifiedDateTime: "2026-06-17T00:00:00Z" }),
    ).toBe("2026-06-17T00:00:00Z");
    expect(driveItemMarker({ id: "only-id", name: "f" })).toBe("only-id");
  });
});
