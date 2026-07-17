import { describe, expect, it } from "vitest";
import { parseCursorPage, parseIncrementalPage, zendeskCredsFromEnv } from "./zendesk.js";

describe("parseCursorPage", () => {
  it("returns articles + next url when has_more is true", () => {
    const page = parseCursorPage({
      articles: [{ id: 1 }, { id: 2 }],
      links: { next: "https://x.zendesk.com/next" },
      meta: { has_more: true },
    });
    expect(page.articles).toHaveLength(2);
    expect(page.nextUrl).toBe("https://x.zendesk.com/next");
  });

  it("stops paging when has_more is false even if a next link is present", () => {
    const page = parseCursorPage({
      articles: [{ id: 1 }],
      links: { next: "https://x.zendesk.com/next" },
      meta: { has_more: false },
    });
    expect(page.nextUrl).toBeNull();
  });

  it("tolerates a missing/empty body", () => {
    expect(parseCursorPage(undefined)).toEqual({ articles: [], nextUrl: null });
    expect(parseCursorPage({})).toEqual({ articles: [], nextUrl: null });
  });
});

describe("parseIncrementalPage", () => {
  it("follows next_page while a full window is returned", () => {
    const page = parseIncrementalPage({
      articles: new Array(1000).fill({ id: 1 }),
      next_page: "https://x.zendesk.com/inc?start=2",
      count: 1000,
    });
    expect(page.nextPage).toBe("https://x.zendesk.com/inc?start=2");
  });

  it("terminates when the page is under the 1000 window", () => {
    const page = parseIncrementalPage({
      articles: [{ id: 1 }],
      next_page: "https://x.zendesk.com/inc?start=2",
      count: 1,
    });
    expect(page.nextPage).toBeNull();
  });

  it("terminates when next_page is null", () => {
    const page = parseIncrementalPage({ articles: [], next_page: null, count: 1000 });
    expect(page.nextPage).toBeNull();
  });
});

describe("zendeskCredsFromEnv", () => {
  it("returns creds when all three vars are set", () => {
    expect(
      zendeskCredsFromEnv({
        ZENDESK_SUBDOMAIN: "wac",
        ZENDESK_EMAIL: "a@b.com",
        ZENDESK_API_TOKEN: "tok",
      } as NodeJS.ProcessEnv),
    ).toEqual({ subdomain: "wac", email: "a@b.com", token: "tok" });
  });

  it("returns null when any var is missing", () => {
    expect(
      zendeskCredsFromEnv({ ZENDESK_SUBDOMAIN: "wac", ZENDESK_EMAIL: "a@b.com" } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(zendeskCredsFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });
});
