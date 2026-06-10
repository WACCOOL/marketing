import { describe, expect, it } from "vitest";
import {
  PPT_DECK_LIMITS,
  PPT_LAYOUTS,
  PptDeckSchema,
  countDeckImages,
} from "./ppt.js";

const TEMPLATE_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

function slide(overrides: Partial<{ id: string; layout: string; fields: object }> = {}) {
  return {
    id: overrides.id ?? "s1",
    layout: (overrides.layout ?? "title") as (typeof PPT_LAYOUTS)[number],
    fields: overrides.fields ?? { title: "Hello" },
  };
}

describe("PptDeckSchema", () => {
  it("accepts a minimal valid deck", () => {
    const deck = PptDeckSchema.parse({
      templateId: TEMPLATE_ID,
      slides: [slide()],
    });
    expect(deck.slides).toHaveLength(1);
    expect(deck.slides[0]!.layout).toBe("title");
  });

  it("accepts every canonical layout", () => {
    const slides = PPT_LAYOUTS.map((layout, i) =>
      slide({ id: `s${i}`, layout }),
    );
    expect(() =>
      PptDeckSchema.parse({ templateId: TEMPLATE_ID, slides }),
    ).not.toThrow();
  });

  it("rejects unknown layouts", () => {
    const res = PptDeckSchema.safeParse({
      templateId: TEMPLATE_ID,
      slides: [slide({ layout: "freeform" })],
    });
    expect(res.success).toBe(false);
  });

  it("rejects a non-uuid templateId", () => {
    const res = PptDeckSchema.safeParse({
      templateId: "not-a-uuid",
      slides: [slide()],
    });
    expect(res.success).toBe(false);
  });

  it("rejects empty decks and decks over the slide cap", () => {
    expect(
      PptDeckSchema.safeParse({ templateId: TEMPLATE_ID, slides: [] }).success,
    ).toBe(false);
    const slides = Array.from({ length: PPT_DECK_LIMITS.maxSlides + 1 }, (_, i) =>
      slide({ id: `s${i}` }),
    );
    expect(
      PptDeckSchema.safeParse({ templateId: TEMPLATE_ID, slides }).success,
    ).toBe(false);
  });

  it("enforces the deck-wide image cap", () => {
    const images = Array.from({ length: 10 }, (_, i) => ({
      url: `https://example.com/${i}.png`,
    }));
    const slides = Array.from({ length: 4 }, (_, i) =>
      slide({ id: `s${i}`, layout: "image_caption", fields: { images } }),
    );
    const deck = { templateId: TEMPLATE_ID, slides };
    expect(countDeckImages(deck)).toBe(40);
    const res = PptDeckSchema.safeParse(deck);
    expect(res.success).toBe(false);
  });

  it("rejects table rows that do not match the header count", () => {
    const res = PptDeckSchema.safeParse({
      templateId: TEMPLATE_ID,
      slides: [
        slide({
          layout: "table",
          fields: {
            title: "Specs",
            table: { headers: ["A", "B"], rows: [["1", "2"], ["only-one"]] },
          },
        }),
      ],
    });
    expect(res.success).toBe(false);
  });

  it("rejects decks whose JSON exceeds the byte cap", () => {
    const big = "x".repeat(7900);
    const slides = Array.from({ length: 100 }, (_, i) =>
      slide({
        id: `s${i}`,
        layout: "two_column",
        fields: { body: big, body2: big },
      }),
    );
    const res = PptDeckSchema.safeParse({ templateId: TEMPLATE_ID, slides });
    expect(res.success).toBe(false);
  });

  it("rejects non-url images", () => {
    const res = PptDeckSchema.safeParse({
      templateId: TEMPLATE_ID,
      slides: [
        slide({
          layout: "image_full",
          fields: { images: [{ url: "not a url" }] },
        }),
      ],
    });
    expect(res.success).toBe(false);
  });
});
