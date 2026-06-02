import { Hono } from "hono";
import { z } from "zod";
import { SocialChannels, buildSocialFanout } from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { userSupabase } from "../supabase.js";
import { createShortLink, shortLinkUrl } from "../shortlinks.js";
import { renderQr } from "../qr.js";
import { autoTags, createAsset } from "../assets.js";

export const socialRoutes = new Hono<AppBindings>();

const SocialSchema = z.object({
  name: z.string().min(1),
  destination: z.string().url(),
  campaign: z.string().min(1),
  medium: z.string().min(1),
  content: z.string().optional(),
  channels: z
    .array(z.enum(SocialChannels))
    .min(1)
    .max(SocialChannels.length)
    .optional(),
  brand: z.string().optional(),
  project: z.string().optional(),
});

/**
 * Generate one tagged URL + short link + QR per social channel (default all
 * six: youtube, tiktok, linkedin, facebook, instagram, x). Saved as one
 * "parent" batch asset with one child per channel.
 */
socialRoutes.post("/fanout", requireAuth, async (c) => {
  const parsed = SocialSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const user = c.get("user");
  const sb = userSupabase(c.env, c.get("jwt"));

  let rows;
  try {
    rows = buildSocialFanout({
      destination: parsed.data.destination,
      campaign: parsed.data.campaign,
      medium: parsed.data.medium,
      ...(parsed.data.content ? { content: parsed.data.content } : {}),
      ...(parsed.data.channels ? { channels: parsed.data.channels } : {}),
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "fanout build failed" },
      400,
    );
  }

  // Parent batch asset, then per-channel child assets.
  const parent = await createAsset(
    c.env,
    sb,
    {
      ownerId: user.id,
      tool: "utm",
      name: `${parsed.data.name} (social fan-out)`,
      tags: autoTags({
        tool: "utm",
        campaign: parsed.data.campaign,
        medium: parsed.data.medium,
        content: parsed.data.content,
        brand: parsed.data.brand,
        project: parsed.data.project,
        extra: ["batch:social-fanout"],
      }),
      metadata: {
        destination: parsed.data.destination,
        channels: rows.map((r) => r.channel),
      },
    },
    [],
  );

  const children: Array<{
    channel: string;
    assetId: string;
    slug: string;
    shortUrl: string;
    taggedUrl: string;
  }> = [];

  for (const row of rows) {
    const slRes = await createShortLink(c.env, sb, {
      destinationUrl: row.taggedUrl,
      ownerId: user.id,
    });
    if (!slRes.ok) {
      return c.json(
        {
          error: `short link create failed for ${row.channel}: ${
            "conflict" in slRes ? "conflict" : slRes.error
          }`,
        },
        500,
      );
    }
    const shortUrl = shortLinkUrl(c.env, slRes.row.slug);
    const { svg, png } = await renderQr(shortUrl);

    const child = await createAsset(
      c.env,
      sb,
      {
        ownerId: user.id,
        tool: "qr",
        name: `${parsed.data.name} - ${row.channel}`,
        parentAssetId: parent.assetId,
        tags: autoTags({
          tool: "qr",
          campaign: parsed.data.campaign,
          source: row.channel,
          medium: parsed.data.medium,
          content: parsed.data.content,
          brand: parsed.data.brand,
          project: parsed.data.project,
          extra: ["batch:social-fanout"],
        }),
        metadata: {
          channel: row.channel,
          taggedUrl: row.taggedUrl,
          shortUrl,
          slug: slRes.row.slug,
          fields: row.fields,
        },
      },
      [
        { format: "svg", body: svg, contentType: "image/svg+xml" },
        { format: "png", body: png, contentType: "image/png" },
        { format: "url", body: row.taggedUrl },
      ],
    );
    children.push({
      channel: row.channel,
      assetId: child.assetId,
      slug: slRes.row.slug,
      shortUrl,
      taggedUrl: row.taggedUrl,
    });
  }

  return c.json({ parentAssetId: parent.assetId, rows: children });
});
