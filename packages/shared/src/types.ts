import { z } from "zod";

export const UtmVocabTypeSchema = z.enum(["source", "medium", "content"]);
export type UtmVocabType = z.infer<typeof UtmVocabTypeSchema>;

export const UtmVocabEntrySchema = z.object({
  id: z.string().uuid(),
  type: UtmVocabTypeSchema,
  value: z.string().min(1),
});
export type UtmVocabEntry = z.infer<typeof UtmVocabEntrySchema>;

export const HubspotCampaignSchema = z.object({
  hubspot_id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
});
export type HubspotCampaign = z.infer<typeof HubspotCampaignSchema>;

/**
 * The encoded value stored in utm_campaign. Per the PRD this is the HubSpot
 * id and slug joined with an underscore, e.g. "39174698_hd_expo_2026".
 */
export function encodeCampaignValue(c: HubspotCampaign): string {
  return `${c.hubspot_id}_${c.slug}`;
}

export const AssetVisibilitySchema = z.enum(["internal", "private"]);
export type AssetVisibility = z.infer<typeof AssetVisibilitySchema>;

export const ToolSchema = z.enum(["utm", "qr", "appimage", "ppt", "layout"]);
export type Tool = z.infer<typeof ToolSchema>;

/**
 * The tools that run through the async generation pipeline (Phase 2b). Derived
 * from ToolSchema so it can't drift — utm/qr are synchronous and excluded. For
 * 2b only `appimage` is exercised; ppt/layout arrive in Phase 3.
 */
export const GenerationToolSchema = ToolSchema.extract([
  "appimage",
  "ppt",
  "layout",
]);
export type GenerationTool = z.infer<typeof GenerationToolSchema>;

export const GenerationJobRequestSchema = z.object({
  tool: GenerationToolSchema,
  name: z.string().min(1),
  params: z.record(z.unknown()).default({}),
});
export type GenerationJobRequest = z.infer<typeof GenerationJobRequestSchema>;

export const GenerationJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);
export type GenerationJobStatus = z.infer<typeof GenerationJobStatusSchema>;

export const SocialChannels = [
  "youtube",
  "tiktok",
  "linkedin",
  "facebook",
  "instagram",
  "x",
] as const;
export type SocialChannel = (typeof SocialChannels)[number];

export const ShortLinkSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  destination_url: z.string().url(),
  owner_id: z.string().uuid(),
  scan_count: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ShortLink = z.infer<typeof ShortLinkSchema>;

/**
 * Physical fixture dimensions, always normalized to millimetres. Every field is
 * optional because Sales Layer products expose different measurements (a round
 * downlight has a diameter, a linear fixture has a length, etc.). The Phase 2
 * scale engine reads from this shape.
 */
export const DimensionsMmSchema = z.object({
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  depth: z.number().positive().optional(),
  diameter: z.number().positive().optional(),
  length: z.number().positive().optional(),
});
export type DimensionsMm = z.infer<typeof DimensionsMmSchema>;

/**
 * One orderable variant of a product (a specific finish / size / configuration).
 * Carries its own SKU, dimensions, and imagery. In WAC's Sales Layer the
 * orderable SKU (matnr) and most fixture dimensions live at this level.
 */
export const ProductVariantSchema = z.object({
  /** Sales Layer variant_id (e.g. "LED-TO24-CH5_G0_B"). */
  variant_id: z.string().min(1),
  /** Orderable SKU / material number (matnr), e.g. "LED-TO24-CH5". */
  sku: z.string().nullable().optional(),
  finish: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  dimensions_mm: DimensionsMmSchema.default({}),
  image_urls: z.array(z.string().url()).default([]),
});
export type ProductVariant = z.infer<typeof ProductVariantSchema>;

/**
 * A product row from the local Sales Layer cache (public.products). Mirrors the
 * DB columns. A product groups many variants; `image_urls` aggregates every
 * image (product + variant) so the user can access all of them. Images live on
 * the Sales Layer CDN — these are URLs, not R2 keys.
 */
export const ProductSchema = z.object({
  id: z.string().uuid(),
  sku: z.string().min(1),
  name: z.string().min(1),
  category: z.string().nullable().optional(),
  dimensions_mm: DimensionsMmSchema.default({}),
  primary_image_url: z.string().url().nullable().optional(),
  image_urls: z.array(z.string().url()).default([]),
  variants: z.array(ProductVariantSchema).default([]),
  synced_at: z.string(),
});
export type Product = z.infer<typeof ProductSchema>;
