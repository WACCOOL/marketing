import { describe, expect, it } from "vitest";
import {
  decideTicketAction,
  isFakeZendeskEmail,
  missingQuoteRequestFields,
  taskTypeSpec,
  WAC_TASK_TYPES,
  QUOTE_REQUEST_FIELDS,
  type ZendeskStatus,
} from "./quoteDesk.js";

const t = (id: number, status: ZendeskStatus) => ({ id, status });

describe("decideTicketAction", () => {
  it("creates when there is no prior ticket", () => {
    expect(decideTicketAction([], false)).toEqual({ kind: "create" });
    expect(decideTicketAction([], true)).toEqual({ kind: "create" });
  });

  it("comments on the newest active ticket regardless of continuation", () => {
    const existing = [t(10, "closed"), t(20, "open"), t(30, "pending")];
    expect(decideTicketAction(existing, false)).toEqual({ kind: "comment", ticketId: 30 });
    expect(decideTicketAction(existing, true)).toEqual({ kind: "comment", ticketId: 30 });
  });

  it("treats new/hold as active", () => {
    expect(decideTicketAction([t(5, "new")], true)).toEqual({ kind: "comment", ticketId: 5 });
    expect(decideTicketAction([t(5, "hold")], false)).toEqual({ kind: "comment", ticketId: 5 });
  });

  it("solved + continuation → comment (reopens the same task)", () => {
    expect(decideTicketAction([t(7, "solved")], true)).toEqual({ kind: "comment", ticketId: 7 });
  });

  it("solved + new quote → fresh ticket (solved means done)", () => {
    expect(decideTicketAction([t(7, "solved")], false)).toEqual({ kind: "create" });
  });

  it("closed + continuation → linked follow-up ticket", () => {
    expect(decideTicketAction([t(9, "closed")], true)).toEqual({ kind: "followup", sourceId: 9 });
  });

  it("closed + new quote → fresh unlinked ticket", () => {
    expect(decideTicketAction([t(9, "closed")], false)).toEqual({ kind: "create" });
  });

  it("picks the NEWEST terminal ticket when several exist", () => {
    expect(decideTicketAction([t(1, "closed"), t(2, "solved")], true)).toEqual({
      kind: "comment",
      ticketId: 2,
    });
    expect(decideTicketAction([t(2, "solved"), t(3, "closed")], true)).toEqual({
      kind: "followup",
      sourceId: 3,
    });
  });
});

describe("task types", () => {
  it("revisions are continuations; new quotes are not", () => {
    expect(taskTypeSpec("quote_revision")?.continuation).toBe(true);
    expect(taskTypeSpec("custom_quote_revision")?.continuation).toBe(true);
    expect(taskTypeSpec("new_quote")?.continuation).toBe(false);
    expect(taskTypeSpec("custom_quotation_review")?.continuation).toBe(false);
    expect(taskTypeSpec("color_chip_request")?.continuation).toBe(false);
  });

  it("every referenced field exists in QUOTE_REQUEST_FIELDS", () => {
    for (const tt of WAC_TASK_TYPES) {
      for (const name of [...tt.required, ...tt.optional]) {
        expect(QUOTE_REQUEST_FIELDS[name], `${tt.value} references ${name}`).toBeDefined();
      }
    }
  });

  it("continuation types require the SAP quote number; new types don't", () => {
    for (const tt of WAC_TASK_TYPES) {
      expect(tt.required.includes("sap_quote_number")).toBe(tt.continuation);
    }
  });
});

describe("missingQuoteRequestFields", () => {
  it("flags missing required fields per task type", () => {
    expect(missingQuoteRequestFields("quote_revision", {})).toEqual([
      "account_number",
      "sap_quote_number",
      "quote_request_notes",
    ]);
  });

  it("passes a complete revision", () => {
    expect(
      missingQuoteRequestFields("quote_revision", {
        account_number: "2013231",
        sap_quote_number: "25102316",
        quote_request_notes: "Please extend the expiration date to end of month.",
      }),
    ).toEqual([]);
  });

  it("treats blank/whitespace values as missing", () => {
    expect(
      missingQuoteRequestFields("new_quote", {
        subject: "  ",
        account_number: "2013231",
        quote_request_notes: "quote please",
        quote_needed_by: null,
      }),
    ).toEqual(["subject", "quote_needed_by"]);
  });

  it("rejects unknown task types", () => {
    expect(missingQuoteRequestFields("nonsense", {})).toEqual(["request_type"]);
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
    expect(isFakeZendeskEmail("user123@wgroupsupport.zendesk.com")).toBe(true);
    expect(isFakeZendeskEmail("abc@anything.ZENDESK.com")).toBe(true);
    expect(isFakeZendeskEmail("someone@example.com")).toBe(true);
    expect(isFakeZendeskEmail("x@domain.invalid")).toBe(true);
    expect(isFakeZendeskEmail("noemail@customer.com")).toBe(true);
    expect(isFakeZendeskEmail("bob@noemail.local")).toBe(true);
  });

  it("passes real emails", () => {
    expect(isFakeZendeskEmail("eisaacson@texaslighting.com")).toBe(false);
    expect(isFakeZendeskEmail("davis.rothenberg@waclighting.com")).toBe(false);
    expect(isFakeZendeskEmail("support@zendeskfans.io")).toBe(false);
  });
});
