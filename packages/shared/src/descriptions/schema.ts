import { z } from "zod";

/**
 * Descriptions — shared zod schemas. The browser does all binary parsing
 * (xlsx cells via SheetJS) and sends the Worker a plain-JSON ImportPayload;
 * the Worker re-validates it against this exact schema before any write, so
 * the client blob is never trusted (plan §2).
 */

/** The three master-list slots (xlsx). Supplemental slots land in Stage 2. */
export const DESC_MASTER_SLOTS = [
  "dweled_master",
  "mf_master",
  "schonbek_master",
] as const;

/** All six file slots (masters + supplemental pptx/pdf enrichment). */
export const DESC_SLOTS = [
  ...DESC_MASTER_SLOTS,
  "dweled_pptx",
  "mf_pdf",
  "schonbek_pdf",
] as const;

export type DescSlot = (typeof DESC_SLOTS)[number];
export type DescMasterSlot = (typeof DESC_MASTER_SLOTS)[number];

export const DescMasterSlotSchema = z.enum(DESC_MASTER_SLOTS);
export const DescSlotSchema = z.enum(DESC_SLOTS);

export function isDescSlot(v: string): v is DescSlot {
  return (DESC_SLOTS as readonly string[]).includes(v);
}
export function isDescMasterSlot(v: string): v is DescMasterSlot {
  return (DESC_MASTER_SLOTS as readonly string[]).includes(v);
}

/**
 * One distinct (L, W, H) tuple. Source strings are preserved verbatim (the
 * sheets mix `26`, `26.5`, `2-6`, `48"` …) — numeric range rendering happens
 * at display time and never destroys the original value.
 */
export const SizeTupleSchema = z.object({
  length: z.string().max(60).nullable(),
  width: z.string().max(60).nullable(),
  height: z.string().max(60).nullable(),
});
export type SizeTuple = z.infer<typeof SizeTupleSchema>;

/** One aggregated model-row variant, kept for prompt fact sheets + export. */
export const DescVariantSchema = z.object({
  model: z.string().max(80),
  finish: z.string().max(120).nullable(),
  cct: z.string().max(120).nullable(),
  size: z.string().max(120).nullable(),
});
export type DescVariant = z.infer<typeof DescVariantSchema>;

export const DescAttributesSchema = z
  .object({
    /** Sheet `Romance` column (first non-empty in the group). */
    romance: z.string().max(4000).optional(),
    /** Sheet `Product Hierarchy` (drives the MF Fans/Luminaires split). */
    hierarchy: z.string().max(300).optional(),
    /** Per-model variant rows (model, finish, cct, size). */
    variants: z.array(DescVariantSchema).max(300).default([]),
    /**
     * First non-empty value per remaining recognized sheet column (lumens,
     * wattage, dimming …) — prompt fact-sheet context in later stages.
     */
    sheet: z.record(z.string().max(500)).default({}),
  })
  .passthrough();
export type DescAttributes = z.infer<typeof DescAttributesSchema>;

/** One PPID group (one table row / one desc_products row). */
export const ParsedProductSchema = z.object({
  /** Stable content-derived identity — description ownership hangs on this. */
  content_key: z.string().min(1).max(200),
  brand: z.string().min(1).max(60),
  collection: z.string().min(1).max(60),
  year: z.number().int().min(2020).max(2100),
  name: z.string().max(200).nullable(),
  family: z.string().max(200).nullable(),
  product_type: z.string().max(200).nullable(),
  diffuser_type: z.string().max(200).nullable(),
  finishes: z.array(z.string().max(120)).max(120),
  sizes: z.array(SizeTupleSchema).max(200),
  cct: z.array(z.string().max(120)).max(60),
  model_numbers: z.array(z.string().max(80)).max(500),
  model_bases: z.array(z.string().max(80)).max(200),
  features: z.array(z.string().max(500)).max(8),
  attributes: DescAttributesSchema,
  source_rows: z.number().int().min(1).max(5000),
  sort_order: z.number().int().min(0),
});
export type ParsedProduct = z.infer<typeof ParsedProductSchema>;

/** Per-sheet parse stats recorded into desc_imports.parse_report. */
export const SheetReportSchema = z.object({
  sheet: z.string().max(100),
  rows: z.number().int().min(0),
  groups: z.number().int().min(0),
});
export type SheetReport = z.infer<typeof SheetReportSchema>;

/**
 * The commit payload for a master slot. Caps are sanity rails (~150 real
 * groups exist) so a hostile/buggy client can't flood the table.
 */
export const ImportPayloadSchema = z
  .object({
    slot: DescMasterSlotSchema,
    products: z.array(ParsedProductSchema).min(1).max(400),
    warnings: z.array(z.string().max(500)).max(300).default([]),
    sheets: z.array(SheetReportSchema).max(10).default([]),
  })
  .superRefine((payload, ctx) => {
    const seen = new Set<string>();
    for (const p of payload.products) {
      if (seen.has(p.content_key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate content_key "${p.content_key}"`,
        });
      }
      seen.add(p.content_key);
      if (JSON.stringify(p.attributes).length > 24_000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `attributes too large for "${p.content_key}"`,
        });
      }
    }
  });
export type ImportPayload = z.infer<typeof ImportPayloadSchema>;

/** Review statuses reuse the product_content_status enum (migration 0015). */
export type DescContentStatus = "none" | "generated" | "in_review" | "approved";

/** UI labels for the status filter ("Description" filter in the spec). */
export const DESC_STATUS_LABELS: Record<DescContentStatus, string> = {
  none: "not written",
  generated: "generated",
  in_review: "edited",
  approved: "approved",
};
