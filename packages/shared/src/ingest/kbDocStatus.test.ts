import { describe, expect, it } from "vitest";
import { resolveKbDocStatus } from "./kbDocStatus.js";

describe("resolveKbDocStatus", () => {
  it("is pending_extract for a brand-new document", () => {
    expect(resolveKbDocStatus(undefined, "h1")).toBe("pending_extract");
    expect(resolveKbDocStatus(null, "h1")).toBe("pending_extract");
  });

  it("requeues a changed-hash document (edited upstream)", () => {
    expect(resolveKbDocStatus({ content_hash: "old", status: "active" }, "new")).toBe(
      "pending_extract",
    );
  });

  it("requeues when the existing row has no hash yet", () => {
    expect(resolveKbDocStatus({ content_hash: null, status: "active" }, "h1")).toBe(
      "pending_extract",
    );
  });

  it("requeues a superseded document that reappears (re-published)", () => {
    expect(resolveKbDocStatus({ content_hash: "h1", status: "superseded" }, "h1")).toBe(
      "pending_extract",
    );
  });

  it("keeps the current status when the hash is unchanged", () => {
    expect(resolveKbDocStatus({ content_hash: "h1", status: "active" }, "h1")).toBe("active");
    expect(resolveKbDocStatus({ content_hash: "h1", status: "pending_extract" }, "h1")).toBe(
      "pending_extract",
    );
    // failed stays failed — retrying is --retry-failed's job, not the capture's
    expect(resolveKbDocStatus({ content_hash: "h1", status: "failed" }, "h1")).toBe("failed");
  });
});
