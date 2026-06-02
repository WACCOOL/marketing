import { describe, expect, it } from "vitest";
import { buildSocialFanout } from "./social.js";
import { SocialChannels } from "./types.js";

describe("buildSocialFanout", () => {
  it("emits one row per channel with utm_source set to the channel", () => {
    const rows = buildSocialFanout({
      destination: "https://waclighting.com/launch",
      campaign: "39174698_hd_expo_2026",
      medium: "organic_social",
      content: "ce_pro",
    });

    expect(rows).toHaveLength(SocialChannels.length);
    for (const row of rows) {
      expect(row.fields.source).toBe(row.channel);
      const parsed = new URL(row.taggedUrl);
      expect(parsed.searchParams.get("utm_source")).toBe(row.channel);
      expect(parsed.searchParams.get("utm_medium")).toBe("organic_social");
      expect(parsed.searchParams.get("utm_campaign")).toBe(
        "39174698_hd_expo_2026",
      );
      expect(parsed.searchParams.get("utm_content")).toBe("ce_pro");
    }
    // Make sure all six channels are present and unique.
    const channels = new Set(rows.map((r) => r.channel));
    expect(channels.size).toBe(SocialChannels.length);
    for (const c of SocialChannels) expect(channels.has(c)).toBe(true);
  });
});
