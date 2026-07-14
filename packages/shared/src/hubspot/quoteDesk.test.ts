import { describe, expect, it } from "vitest";
import {
  decideTicketAction,
  isFakeZendeskEmail,
  missingQuoteRequestFields,
  type ZendeskStatus,
} from "./quoteDesk.js";

const t = (id: number, status: ZendeskStatus) => ({ id, status });

describe("decideTicketAction", () => {
  it("creates when there is no prior ticket", () => {
    expect(decideTicketAction([], "new")).toEqual({ kind: "create" });
    expect(decideTicketAction([], "revision")).toEqual({ kind: "create" });
  });

  it("comments on the newest active ticket regardless of type", () => {
    const existing = [t(10, "closed"), t(20, "open"), t(30, "pending")];
    expect(decideTicketAction(existing, "new")).toEqual({ kind: "comment", ticketId: 30 });
    expect(decideTicketAction(existing, "followup_change")).toEqual({ kind: "comment", ticketId: 30 });
  });

  it("treats new/hold as active", () => {
    expect(decideTicketAction([t(5, "new")], "revision")).toEqual({ kind: "comment", ticketId: 5 });
    expect(decideTicketAction([t(5, "hold")], "new")).toEqual({ kind: "comment", ticketId: 5 });
  });

  it("solved + continuation → comment (reopens the same task)", () => {
    expect(decideTicketAction([t(7, "solved")], "revision")).toEqual({ kind: "comment", ticketId: 7 });
    expect(decideTicketAction([t(7, "solved")], "followup_change")).toEqual({
      kind: "comment",
      ticketId: 7,
    });
  });

  it("solved + new quote → fresh ticket (solved means done)", () => {
    expect(decideTicketAction([t(7, "solved")], "new")).toEqual({ kind: "create" });
    expect(decideTicketAction([t(7, "solved")], "custom")).toEqual({ kind: "create" });
  });

  it("closed + continuation → linked follow-up ticket", () => {
    expect(decideTicketAction([t(9, "closed")], "revision")).toEqual({ kind: "followup", sourceId: 9 });
    expect(decideTicketAction([t(9, "closed")], "followup_change")).toEqual({
      kind: "followup",
      sourceId: 9,
    });
  });

  it("closed + new quote → fresh unlinked ticket", () => {
    expect(decideTicketAction([t(9, "closed")], "new")).toEqual({ kind: "create" });
  });

  it("picks the NEWEST terminal ticket when several exist", () => {
    const existing = [t(1, "closed"), t(2, "solved")];
    // newest (2) is solved → comment path for continuations
    expect(decideTicketAction(existing, "revision")).toEqual({ kind: "comment", ticketId: 2 });
    const existing2 = [t(2, "solved"), t(3, "closed")];
    expect(decideTicketAction(existing2, "revision")).toEqual({ kind: "followup", sourceId: 3 });
  });
});

describe("missingQuoteRequestFields", () => {
  it("flags missing required fields per type", () => {
    expect(missingQuoteRequestFields("followup_change", {})).toEqual([
      "account_number",
      "sap_quote_number",
      "quote_request_notes",
    ]);
  });

  it("passes a complete follow-up change", () => {
    expect(
      missingQuoteRequestFields("followup_change", {
        account_number: "2013231",
        sap_quote_number: "25102316",
        quote_request_notes: "Please extend the expiration date to end of month.",
      }),
    ).toEqual([]);
  });

  it("treats blank/whitespace values as missing", () => {
    expect(
      missingQuoteRequestFields("revision", {
        subject: "  ",
        account_number: "2013231",
        sap_quote_number: null,
        quote_request_notes: "reprice",
      }),
    ).toEqual(["subject", "sap_quote_number"]);
  });

  it("requires sap_quote_number for revisions but not new quotes", () => {
    const values = {
      subject: "s",
      account_number: "a",
      how_can_we_help: "New Quote",
      quote_request_notes: "n",
      quote_needed_by: "2026-08-01",
    };
    expect(missingQuoteRequestFields("new", values)).toEqual([]);
    expect(missingQuoteRequestFields("revision", values)).toContain("sap_quote_number");
  });
});

describe("isFakeZendeskEmail", () => {
  it("flags missing / malformed emails", () => {
    expect(isFakeZendeskEmail(undefined)).toBe(true);
    expect(isFakeZendeskEmail(null)).toBe(true);
    expect(isFakeZendeskEmail("")).toBe(true);
    expect(isFakeZendeskEmail("not-an-email")).toBe(true);
  });

  it("flags Zendesk placeholder domains", () => {
    expect(isFakeZendeskEmail("user123@waclighting.zendesk.com")).toBe(true);
    expect(isFakeZendeskEmail("abc@anything.ZENDESK.com")).toBe(true);
    expect(isFakeZendeskEmail("someone@example.com")).toBe(true);
    expect(isFakeZendeskEmail("x@domain.invalid")).toBe(true);
    expect(isFakeZendeskEmail("noemail@customer.com")).toBe(true);
    expect(isFakeZendeskEmail("bob@noemail.local")).toBe(true);
  });

  it("passes real emails", () => {
    expect(isFakeZendeskEmail("eisaacson@texaslighting.com")).toBe(false);
    expect(isFakeZendeskEmail("davis.rothenberg@waclighting.com")).toBe(false);
    // real domains that merely contain 'zendesk' before the TLD are fine
    expect(isFakeZendeskEmail("support@zendeskfans.io")).toBe(false);
  });
});
