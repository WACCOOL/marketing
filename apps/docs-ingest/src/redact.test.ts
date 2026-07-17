import { describe, expect, it } from "vitest";
import { redactTicketText, stripSignature } from "./redact.js";

describe("redactTicketText — emails", () => {
  const cases: [string, string][] = [
    ["Contact me at john.doe@example.com please", "Contact me at [email] please"],
    ["reply to JANE_SMITH@wac-lighting.co.uk", "reply to [email]"],
    ["a+tag@sub.domain.io and b@x.org", "[email] and [email]"],
  ];
  it.each(cases)("redacts %s", (input, expected) => {
    expect(redactTicketText(input)).toBe(expected);
  });

  it("leaves no raw @-address behind", () => {
    const out = redactTicketText("emails: foo@bar.com, baz.qux@corp.net");
    expect(out).not.toMatch(/@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
  });
});

describe("redactTicketText — phones", () => {
  const cases: string[] = [
    "Call 555-123-4567 today",
    "Reach us at (212) 987-6543",
    "Phone: 800.526.2588",
    "+1 (800) 526-2588 is the line",
    "intl +44 20 7946 0958 office",
    "dial 8005262588 now",
    "call 555-123-4567 ext 12 for support",
  ];
  it.each(cases)("redacts a phone in %s", (input) => {
    const out = redactTicketText(input);
    expect(out).toContain("[phone]");
    // no run of 7+ consecutive digits should survive
    expect(out.replace(/\[phone\]/g, "")).not.toMatch(/\d[\d\s().\-]{6,}\d/);
  });
});

describe("redactTicketText — names (word-boundary, case-insensitive)", () => {
  it("redacts full names and their tokens", () => {
    const out = redactTicketText("Hi John Smith, thanks — John will follow up.", ["John Smith"]);
    expect(out).not.toMatch(/John/i);
    expect(out).not.toMatch(/Smith/i);
    expect(out).toContain("[name]");
  });

  it("is case-insensitive", () => {
    const out = redactTicketText("spoke with maria yesterday", ["Maria"]);
    expect(out).toBe("spoke with [name] yesterday");
  });

  it("skips names shorter than 3 chars (no over-redaction)", () => {
    const out = redactTicketText("Al ordered 3 units", ["Al"]);
    expect(out).toBe("Al ordered 3 units");
  });

  it("only matches whole words, not substrings", () => {
    // "Sam" must not nibble "Sample" or "Samsung".
    const out = redactTicketText("Sample photo from Sam about the fixture", ["Sam"]);
    expect(out).toContain("Sample");
    expect(out).toContain("[name]");
  });
});

describe("redactTicketText — signature blocks", () => {
  it("strips everything after a -- delimiter", () => {
    const input = "The cutout is 3.5 inches.\n--\nJohn Doe\nAcme Corp\n555-123-4567";
    const out = redactTicketText(input, ["John Doe"]);
    expect(out).toBe("The cutout is 3.5 inches.");
  });

  it("strips a Regards, sign-off block in the back half", () => {
    const input = [
      "Question about the HR-3LED-30 downlight.",
      "Does it dim on ELV?",
      "Yes it does.",
      "Regards,",
      "Jane",
      "jane@x.com",
    ].join("\n");
    const out = redactTicketText(input, ["Jane"]);
    expect(out).not.toMatch(/Regards/i);
    expect(out).not.toMatch(/jane/i);
    expect(out).toContain("HR-3LED-30");
  });

  it("does NOT treat a mid-message 'thanks!' as a signature", () => {
    const input = "Thanks! Quick question:\nWhat is the cutout for R3ARDL?\nIt is 3 inches.";
    expect(stripSignature(input)).toBe(input);
  });
});

describe("redactTicketText — product/spec content SURVIVES", () => {
  const survivors: string[] = [
    "SKU HR-3LED-30-BK ships next week",
    "Part number R3ARDL27S is discontinued",
    "Cutout diameter is 3.5 inches",
    "Dimensions: 24 1/2\" x 3-1/2\"",
    "Output 1200 lumens at 3000K, 90 CRI",
    "Model WS-45720-BN, IP65 rated",
    "Torque to 4.5 in-lbs",
  ];
  it.each(survivors)("preserves %s", (input) => {
    const out = redactTicketText(input, ["Test User"]);
    expect(out).toBe(input);
    expect(out).not.toContain("[phone]");
    expect(out).not.toContain("[email]");
    expect(out).not.toContain("[name]");
  });
});

describe("redactTicketText — combined", () => {
  it("removes email, phone, and name together while keeping the SKU", () => {
    const input =
      "John asked about HR-3LED-30. Email john@acme.com or call 555-867-5309.";
    const out = redactTicketText(input, ["John"]);
    expect(out).toContain("HR-3LED-30");
    expect(out).toContain("[name]");
    expect(out).toContain("[email]");
    expect(out).toContain("[phone]");
    expect(out).not.toMatch(/john/i);
    expect(out).not.toMatch(/@acme/i);
    expect(out).not.toMatch(/867-5309/);
  });

  it("returns empty string for empty input", () => {
    expect(redactTicketText("", ["x"])).toBe("");
  });
});
