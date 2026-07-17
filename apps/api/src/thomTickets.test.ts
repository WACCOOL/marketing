import { describe, expect, it } from "vitest";
import {
  buildTicketDocPayload,
  parseTicketGroups,
  ticketContentHash,
  ticketInKbGroups,
  THOM_TICKET_DOC_TYPE,
} from "./thomTickets.js";

describe("parseTicketGroups", () => {
  it("parses a JSON array of numbers", () => {
    const s = parseTicketGroups("[111, 222, 333]");
    expect([...s].sort()).toEqual([111, 222, 333]);
  });

  it("parses a JSON array of numeric strings", () => {
    const s = parseTicketGroups('["111","222"]');
    expect([...s].sort()).toEqual([111, 222]);
  });

  it("parses a plain CSV", () => {
    const s = parseTicketGroups("111, 222 ,333");
    expect([...s].sort()).toEqual([111, 222, 333]);
  });

  it("is empty for undefined / empty / invalid JSON array", () => {
    expect(parseTicketGroups(undefined).size).toBe(0);
    expect(parseTicketGroups("").size).toBe(0);
    expect(parseTicketGroups("   ").size).toBe(0);
    expect(parseTicketGroups("[not valid").size).toBe(0);
  });

  it("drops non-numeric / non-positive tokens", () => {
    const s = parseTicketGroups("111,abc,0,-5,222");
    expect([...s].sort()).toEqual([111, 222]);
  });
});

describe("ticketInKbGroups", () => {
  const groups = new Set([111, 222]);
  it("is true for a group in the allowlist (piggyback enqueues)", () => {
    expect(ticketInKbGroups(111, groups)).toBe(true);
  });
  it("is false for a group outside the allowlist (not enqueued)", () => {
    expect(ticketInKbGroups(999, groups)).toBe(false);
  });
  it("is false for null/undefined group", () => {
    expect(ticketInKbGroups(null, groups)).toBe(false);
    expect(ticketInKbGroups(undefined, groups)).toBe(false);
  });
});

describe("ticketContentHash — change detection", () => {
  it("is stable for the same updated_at + comment ids (order-independent)", () => {
    const a = ticketContentHash("2026-07-17T00:00:00Z", [3, 1, 2]);
    const b = ticketContentHash("2026-07-17T00:00:00Z", [1, 2, 3]);
    expect(a).toBe(b);
  });

  it("changes when a new comment id appears", () => {
    const before = ticketContentHash("2026-07-17T00:00:00Z", [1, 2]);
    const after = ticketContentHash("2026-07-17T00:00:00Z", [1, 2, 3]);
    expect(before).not.toBe(after);
  });

  it("changes when updated_at changes", () => {
    const before = ticketContentHash("2026-07-17T00:00:00Z", [1, 2]);
    const after = ticketContentHash("2026-07-18T00:00:00Z", [1, 2]);
    expect(before).not.toBe(after);
  });
});

describe("buildTicketDocPayload — pointer row, NO body", () => {
  it("has the correct pointer fields and internal scope", () => {
    const row = buildTicketDocPayload(
      45678,
      "https://wac.zendesk.com/agent/tickets/45678",
      "Fixture flickers on ELV dimmer",
      "hashABC",
    );
    expect(row).toMatchObject({
      source_system: "zendesk",
      external_id: "45678",
      doc_type: THOM_TICKET_DOC_TYPE,
      scope: "internal",
      url: "https://wac.zendesk.com/agent/tickets/45678",
      title: "Fixture flickers on ELV dimmer",
      content_hash: "hashABC",
    });
  });

  it("OMITS status (upsert defaults new/changed -> pending_extract)", () => {
    const row = buildTicketDocPayload(1, "u", null, "h");
    expect("status" in row).toBe(false);
  });

  it("stores NO body / content / comment field (only kb_chunks holds redacted text)", () => {
    const row = buildTicketDocPayload(1, "u", "subj", "h");
    for (const forbidden of ["body", "content", "comments", "plain_body", "description"]) {
      expect(forbidden in row).toBe(false);
    }
  });

  it("carries a null title through when the ticket has no subject", () => {
    const row = buildTicketDocPayload(1, "u", null, "h");
    expect(row.title).toBeNull();
  });
});
