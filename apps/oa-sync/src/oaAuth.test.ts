import { describe, expect, it } from "vitest";

import { oaDateString, oaHeaders, oaToken } from "./oaAuth.js";

describe("oaDateString", () => {
  it("formats the UTC day with zero padding", () => {
    expect(oaDateString(Date.UTC(2026, 6, 8, 3, 4, 5))).toBe("20260708");
    expect(oaDateString(Date.UTC(2026, 0, 1))).toBe("20260101");
  });

  it("shifts by whole days for the date-boundary fallback", () => {
    expect(oaDateString(Date.UTC(2026, 6, 8, 23, 0, 0), 1)).toBe("20260709");
    expect(oaDateString(Date.UTC(2026, 0, 1), -1)).toBe("20251231");
  });
});

describe("oaToken", () => {
  it("matches a known HMAC-SHA256 vector (key = secret + nonce)", () => {
    // Independently computed: HMAC-SHA256("20260708", key "secretnonce").
    expect(oaToken("secret", "nonce", "20260708")).toBe(
      "49e7664893171bf7470ec4728db7424979b7b74bbb600e20c9434e42e613bdb3",
    );
  });

  it("changes with each input", () => {
    const base = oaToken("s", "n", "20260708");
    expect(oaToken("s2", "n", "20260708")).not.toBe(base);
    expect(oaToken("s", "n2", "20260708")).not.toBe(base);
    expect(oaToken("s", "n", "20260709")).not.toBe(base);
  });
});

describe("oaHeaders", () => {
  it("produces a fresh UUIDv4 nonce and a consistent signature per call", () => {
    const now = Date.UTC(2026, 6, 8, 12, 0, 0);
    const a = oaHeaders("secret", now);
    const b = oaHeaders("secret", now);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.timestamp).toBe(String(now));
    expect(a.token).toBe(oaToken("secret", a.nonce!, "20260708"));
  });
});
