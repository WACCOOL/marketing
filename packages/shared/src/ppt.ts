import { z } from "zod";

/**
 * PPT Generator (PRD §8) — the shared deck contract between the web builder,
 * the API (job validation + AI drafting), and the generator container (which
 * fills an admin-uploaded .pptx template via python-pptx).
 *
 * The canonical layout vocabulary below is what decks are authored in; each
 * template maps these names to its own slide layouts (ppt_templates.layout_map,
 * seeded by the introspection heuristic and editable by admins). Slides carry
 * structured fields only — fonts/colors/positions always come from the
 * template, which is what keeps exports on-brand.
 */

export const PPT_LAYOUTS = [
  "title",
  "title_content",
  "title_content_image",
  "two_column",
  "image_full",
  "image_caption",
  "agenda",
  "quote",
  "chart",
  "diagram",
  "process",
  "video",
  "table",
  "section",
] as const;

export type PptLayout = (typeof PPT_LAYOUTS)[number];

/** Caps keep decks renderable in one container job. */
export const PPT_DECK_LIMITS = {
  maxSlides: 100,
  maxImages: 30,
  maxVideos: 5,
  maxJsonBytes: 1_000_000,
} as const;

export const PptImageSchema = z.object({
  url: z.string().url(),
  caption: z.string().max(500).optional(),
  /** The AI prompt that produced this image, kept so Regenerate survives a
   * deck restore. Ignored by the generator. */
  prompt: z.string().max(2000).optional(),
});

export const PptQuoteSchema = z.object({
  text: z.string().min(1).max(1000),
  attribution: z.string().max(200).optional(),
});

export const PPT_CHART_TYPES = ["column", "bar", "line", "pie"] as const;

export const PptChartSchema = z
  .object({
    chartType: z.enum(PPT_CHART_TYPES),
    categories: z.array(z.string().max(100)).min(1).max(24),
    series: z
      .array(
        z.object({
          name: z.string().max(100),
          values: z.array(z.number().finite()).max(24),
        }),
      )
      .min(1)
      .max(6),
  })
  .superRefine((chart, ctx) => {
    for (const [i, s] of chart.series.entries()) {
      if (s.values.length !== chart.categories.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["series", i, "values"],
          message: `series has ${s.values.length} values but the chart has ${chart.categories.length} categories`,
        });
      }
    }
  });

export const PptVideoSchema = z.object({
  url: z.string().url(),
  caption: z.string().max(500).optional(),
});

export const PptTableSchema = z
  .object({
    headers: z.array(z.string().max(200)).min(1).max(12),
    rows: z.array(z.array(z.string().max(1000))).max(50),
  })
  .superRefine((table, ctx) => {
    for (const [i, row] of table.rows.entries()) {
      if (row.length !== table.headers.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rows", i],
          message: `row has ${row.length} cells but the table has ${table.headers.length} headers`,
        });
      }
    }
  });

export const PptSlideFieldsSchema = z.object({
  title: z.string().max(300).optional(),
  subtitle: z.string().max(500).optional(),
  bullets: z.array(z.string().max(1000)).max(20).optional(),
  body: z.string().max(8000).optional(),
  /** Right column for the two_column layout. */
  body2: z.string().max(8000).optional(),
  images: z.array(PptImageSchema).max(10).optional(),
  table: PptTableSchema.optional(),
  /** Pull quote (quote layout). */
  quote: PptQuoteSchema.optional(),
  /** Native chart data (chart layout) — themed by the template. */
  chart: PptChartSchema.optional(),
  /** Labeled steps/boxes for the process and diagram layouts. */
  items: z.array(z.string().max(300)).min(1).max(12).optional(),
  /** Embedded movie (video layout); the generator downloads and embeds it. */
  video: PptVideoSchema.optional(),
  /**
   * A desired-image description (e.g. from doc drafting). The builder turns it
   * into a generated image; the generator itself ignores it.
   */
  imagePrompt: z.string().max(2000).optional(),
});

export const PptSlideSchema = z.object({
  /** Client-generated stable id, used for filmstrip reorder/edit. */
  id: z.string().min(1).max(64),
  layout: z.enum(PPT_LAYOUTS),
  fields: PptSlideFieldsSchema,
});

export const PptDeckSchema = z
  .object({
    templateId: z.string().uuid(),
    /**
     * When set, the export updates this existing deck asset in place (new
     * files, same library entry) instead of creating a new one — the "edit
     * overwrites, clone duplicates" contract. The generator verifies the
     * asset belongs to the job owner.
     */
    replaceAssetId: z.string().uuid().optional(),
    slides: z.array(PptSlideSchema).min(1).max(PPT_DECK_LIMITS.maxSlides),
  })
  .superRefine((deck, ctx) => {
    const images = countDeckImages(deck);
    if (images > PPT_DECK_LIMITS.maxImages) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slides"],
        message: `deck uses ${images} images; the limit is ${PPT_DECK_LIMITS.maxImages}`,
      });
    }
    const videos = deck.slides.filter((s) => s.fields.video).length;
    if (videos > PPT_DECK_LIMITS.maxVideos) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slides"],
        message: `deck embeds ${videos} videos; the limit is ${PPT_DECK_LIMITS.maxVideos}`,
      });
    }
    const bytes = jsonByteLength(deck);
    if (bytes > PPT_DECK_LIMITS.maxJsonBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `deck JSON is ${bytes} bytes; the limit is ${PPT_DECK_LIMITS.maxJsonBytes}`,
      });
    }
  });

export type PptImage = z.infer<typeof PptImageSchema>;
export type PptTable = z.infer<typeof PptTableSchema>;
export type PptQuote = z.infer<typeof PptQuoteSchema>;
export type PptChart = z.infer<typeof PptChartSchema>;
export type PptChartType = (typeof PPT_CHART_TYPES)[number];
export type PptVideo = z.infer<typeof PptVideoSchema>;
export type PptSlideFields = z.infer<typeof PptSlideFieldsSchema>;
export type PptSlide = z.infer<typeof PptSlideSchema>;
export type PptDeck = z.infer<typeof PptDeckSchema>;

export function countDeckImages(deck: {
  slides: { fields: { images?: unknown[] } }[];
}): number {
  return deck.slides.reduce((n, s) => n + (s.fields.images?.length ?? 0), 0);
}

function jsonByteLength(value: unknown): number {
  const json = JSON.stringify(value) ?? "";
  // TextEncoder exists in Workers, browsers, and Node ≥11 alike.
  return new TextEncoder().encode(json).length;
}

/** Asset metadata marker for decks built by this pipeline. */
export const PPT_GENERATED_BY = "ppt-v1";
