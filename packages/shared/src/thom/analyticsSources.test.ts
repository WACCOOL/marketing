import { describe, expect, it } from "vitest";
import { bucketSourceUsage } from "./analyticsSources.js";

describe("bucketSourceUsage", () => {
  it("maps doc types and tool names onto the friendly buckets", () => {
    const out = bucketSourceUsage([
      { kind: "doc", key: "spec_sheet", hits: 10 },
      { kind: "doc", key: "manual", hits: 5 },
      { kind: "doc", key: "web_company", hits: 4 },
      { kind: "doc", key: "web_technology", hits: 2 },
      { kind: "doc", key: "zendesk_article", hits: 3 },
      { kind: "tool", key: "search_products", hits: 8 },
      { kind: "tool", key: "crm_search_companies", hits: 6 },
    ]);
    expect(out[0]).toEqual({ source: "Spec sheets & manuals (PIM)", hits: 15 });
    expect(out).toContainEqual({ source: "Website crawl", hits: 6 });
    expect(out).toContainEqual({ source: "HubSpot CRM", hits: 6 });
    expect(out).toContainEqual({ source: "Product catalog (PIM)", hits: 8 });
    expect(out).toContainEqual({ source: "Help Center (Zendesk)", hits: 3 });
  });

  it("skips search_docs plumbing but surfaces unknown keys as Other", () => {
    const out = bucketSourceUsage([
      { kind: "tool", key: "search_docs", hits: 99 },
      { kind: "doc", key: "mystery_type", hits: 2 },
    ]);
    expect(out.some((b) => b.source.includes("search_docs"))).toBe(false);
    expect(out).toContainEqual({ source: "Other (mystery_type)", hits: 2 });
  });
});
