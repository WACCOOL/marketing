import { SocialChannels, type SocialChannel } from "./types.js";
import { buildTaggedUrl, type UtmFields } from "./utm.js";

export interface SocialFanoutInput {
  destination: string;
  campaign: string;
  /** Shared utm_medium for all six channels — e.g. "social" | "paid_social" */
  medium: string;
  /** Optional shared utm_content */
  content?: string;
  /** Override the default channel set (defaults to all six) */
  channels?: readonly SocialChannel[];
}

export interface SocialFanoutRow {
  channel: SocialChannel;
  fields: UtmFields;
  taggedUrl: string;
}

/**
 * Generate one tagged URL per social channel, sharing campaign/medium/content
 * and setting utm_source = channel. The PRD requires the six channels:
 *   youtube, tiktok, linkedin, facebook, instagram, x
 */
export function buildSocialFanout(input: SocialFanoutInput): SocialFanoutRow[] {
  const channels = input.channels ?? SocialChannels;
  return channels.map((channel) => {
    const fields: UtmFields = {
      source: channel,
      medium: input.medium,
      campaign: input.campaign,
      ...(input.content ? { content: input.content } : {}),
    };
    return {
      channel,
      fields,
      taggedUrl: buildTaggedUrl(input.destination, fields),
    };
  });
}
