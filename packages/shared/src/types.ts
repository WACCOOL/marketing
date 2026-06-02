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
