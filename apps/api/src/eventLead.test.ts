import { describe, expect, it } from "vitest";
import { FALLBACK_OWNER_ID, ownedContactGate, ownerGateNoteHtml } from "./eventLead.js";

describe("ownedContactGate", () => {
  it("gates an owned contact at a standard event", () => {
    expect(ownedContactGate("12345", false)).toBe(true);
  });

  it("does not gate at a major event (leads_for_all_attendees)", () => {
    expect(ownedContactGate("12345", true)).toBe(false);
  });

  it("does not gate an unowned contact", () => {
    expect(ownedContactGate("", false)).toBe(false);
  });

  it("treats Lana (the fallback bucket) as unowned — her contacts route normally", () => {
    expect(ownedContactGate(FALLBACK_OWNER_ID, false)).toBe(false);
    expect(ownedContactGate(FALLBACK_OWNER_ID, true)).toBe(false);
  });
});

describe("ownerGateNoteHtml", () => {
  const base = {
    campaignName: "Lightovation 2026 Summer",
    contactName: "Jane Doe",
    ownerId: "77005662",
    ownerName: "Kalin Scott",
    atShowNotes: "",
  };

  it("names the event, mentions the owner, and explains why there's no lead", () => {
    const html = ownerGateNoteHtml(base);
    expect(html).toContain("Event attendance — Lightovation 2026 Summer");
    // The portal's UI-created mention markup, verified against note 75912572601.
    expect(html).toContain(
      '<span data-mention-id="77005662" data-mention-name="Kalin Scott" style="color: #425b76;font-weight: 600;">@Kalin Scott</span>',
    );
    expect(html).toContain("Jane Doe attended this event");
    expect(html).toContain("No lead was created");
    expect(html).not.toContain("At-show notes");
  });

  it("includes fresh at-show notes when present", () => {
    const html = ownerGateNoteHtml({ ...base, atShowNotes: "[2026-07-02] Asked about WAC track" });
    expect(html).toContain("<strong>At-show notes</strong> [2026-07-02] Asked about WAC track");
  });

  it("escapes HTML in names, notes, and the campaign", () => {
    const html = ownerGateNoteHtml({
      ...base,
      campaignName: "Show <A&B>",
      contactName: '<img src=x onerror="1">',
      ownerName: "O'Brien & Co",
      atShowNotes: "5 > 4 & 3 < 4",
    });
    expect(html).toContain("Show &lt;A&amp;B&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;1&quot;&gt;");
    expect(html).toContain("@O'Brien &amp; Co");
    expect(html).toContain("5 &gt; 4 &amp; 3 &lt; 4");
    expect(html).not.toContain("<img");
  });

  it("copes without a campaign or owner name", () => {
    const html = ownerGateNoteHtml({ ...base, campaignName: "", ownerName: "" });
    expect(html).toContain("<strong>Event attendance</strong>");
    expect(html).toContain("Owned contact");
    expect(html).not.toContain("data-mention-id");
  });
});
