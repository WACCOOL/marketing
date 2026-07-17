import { describe, expect, it } from "vitest";
import {
  articleContentHash,
  articleScope,
  buildArticleDocPayload,
  mapArticleBrand,
  parseBrandMap,
  type ZendeskArticle,
} from "./articles.js";

function makeArticle(over: Partial<ZendeskArticle> = {}): ZendeskArticle {
  return {
    id: 123,
    title: "How to pair your fan",
    body: "<p>Steps here</p>",
    html_url: "https://support.wac.com/hc/en-us/articles/123-how-to-pair",
    draft: false,
    section_id: 555,
    category_id: 900,
    label_names: [],
    user_segment_id: null,
    updated_at: "2026-07-01T00:00:00Z",
    locale: "en-us",
    ...over,
  };
}

describe("parseBrandMap", () => {
  it("parses a flat id -> brand object", () => {
    const m = parseBrandMap('{"555":"WAC Lighting","900":"Schonbek"}');
    expect(m.get("555")).toBe("WAC Lighting");
    expect(m.get("900")).toBe("Schonbek");
  });

  it("returns an empty map for undefined or invalid JSON", () => {
    expect(parseBrandMap(undefined).size).toBe(0);
    expect(parseBrandMap("not json").size).toBe(0);
    expect(parseBrandMap('["array"]').size).toBe(0);
  });

  it("ignores non-string / empty values", () => {
    const m = parseBrandMap('{"1":123,"2":"","3":"Modern Forms"}');
    expect(m.has("1")).toBe(false);
    expect(m.has("2")).toBe(false);
    expect(m.get("3")).toBe("Modern Forms");
  });
});

describe("mapArticleBrand", () => {
  it("maps by section_id first", () => {
    const map = new Map([["555", "WAC Lighting"]]);
    expect(mapArticleBrand(makeArticle(), map)).toBe("WAC Lighting");
  });

  it("falls back to category_id when the section is unmapped", () => {
    const map = new Map([["900", "Schonbek"]]);
    expect(mapArticleBrand(makeArticle(), map)).toBe("Schonbek");
  });

  it("falls back to a label matching a known brand (case-insensitive)", () => {
    const article = makeArticle({ section_id: 1, category_id: 2, label_names: ["modern forms"] });
    expect(mapArticleBrand(article, new Map())).toBe("Modern Forms");
  });

  it("returns null when nothing matches", () => {
    const article = makeArticle({ section_id: 1, category_id: 2, label_names: ["misc"] });
    expect(mapArticleBrand(article, new Map())).toBeNull();
  });
});

describe("articleScope", () => {
  it("is public when user_segment_id is null", () => {
    expect(articleScope(makeArticle({ user_segment_id: null }))).toBe("public");
  });
  it("is internal when a user segment restricts it", () => {
    expect(articleScope(makeArticle({ user_segment_id: 42 }))).toBe("internal");
  });
});

describe("articleContentHash", () => {
  it("is stable for the same body + updated_at", () => {
    const a = makeArticle();
    expect(articleContentHash(a)).toBe(articleContentHash(makeArticle()));
  });

  it("changes when the body changes", () => {
    const before = articleContentHash(makeArticle({ body: "<p>old</p>" }));
    const after = articleContentHash(makeArticle({ body: "<p>new</p>" }));
    expect(before).not.toBe(after);
  });

  it("changes when updated_at changes (republish)", () => {
    const before = articleContentHash(makeArticle({ updated_at: "2026-07-01T00:00:00Z" }));
    const after = articleContentHash(makeArticle({ updated_at: "2026-07-02T00:00:00Z" }));
    expect(before).not.toBe(after);
  });
});

describe("buildArticleDocPayload", () => {
  it("keys the row and OMITS status (so upsert defaults/keeps it)", () => {
    const a = makeArticle();
    const payload = buildArticleDocPayload(a, "WAC Lighting", "hash123");
    expect(payload).toMatchObject({
      source_system: "zendesk",
      external_id: "123",
      doc_type: "zendesk_article",
      scope: "public",
      brand: "WAC Lighting",
      title: "How to pair your fan",
      url: a.html_url,
      content_hash: "hash123",
    });
    expect("status" in payload).toBe(false);
  });

  it("carries internal scope through", () => {
    const payload = buildArticleDocPayload(makeArticle({ user_segment_id: 7 }), null, "h");
    expect(payload.scope).toBe("internal");
    expect(payload.brand).toBeNull();
  });
});
