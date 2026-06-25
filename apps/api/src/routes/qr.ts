import { Hono } from "hono";
import { z } from "zod";
import {
  UtmFieldsSchema,
  buildTaggedUrl,
  type UtmFields,
} from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { requireAuth, requireFeature } from "../auth.js";
import { userSupabase } from "../supabase.js";
import { createShortLink, shortLinkUrl } from "../shortlinks.js";
import { renderQr } from "../qr.js";
import { autoTags, createAsset } from "../assets.js";

export const qrRoutes = new Hono<AppBindings>();

// QR generation is part of the UTM & QR tab — gate by the `utm` feature.
qrRoutes.use("*", requireAuth, requireFeature("utm"));

const SingleQrSchema = z.object({
  name: z.string().min(1),
  destination: z.string().url(),
  fields: UtmFieldsSchema,
  vanitySlug: z.string().optional(),
  /** If the SPA pre-rendered an SVG/PNG client-side, accept it base64-encoded. */
  precomputed: z
    .object({
      svg: z.string().optional(),
      pngBase64: z.string().optional(),
    })
    .optional(),
  brand: z.string().optional(),
  project: z.string().optional(),
});

/**
 * One-shot: tagged URL + short link + QR + saved asset.
 *
 * The interactive single-link UI may render the QR client-side with
 * qr-code-styling (so it gets brand styling/logo). It can hand us those bytes
 * in `precomputed`. If not provided, we render server-side with the DOM-free
 * `qrcode` library.
 */
qrRoutes.post("/single", requireAuth, async (c) => {
  const parsed = SingleQrSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const user = c.get("user");
  const sb = userSupabase(c.env, c.get("jwt"));

  const taggedUrl = safeBuild(parsed.data.destination, parsed.data.fields, c);
  if (taggedUrl instanceof Response) return taggedUrl;

  const slRes = await createShortLink(c.env, sb, {
    destinationUrl: taggedUrl,
    ownerId: user.id,
    vanitySlug: parsed.data.vanitySlug,
  });
  if (!slRes.ok) {
    if ("conflict" in slRes) {
      return c.json({ error: "vanity slug already taken" }, 409);
    }
    return c.json({ error: slRes.error }, 500);
  }
  const shortUrl = shortLinkUrl(c.env, slRes.row.slug);

  // Render or accept precomputed QR for the short link.
  let svg: string;
  let png: Uint8Array;
  if (parsed.data.precomputed?.svg && parsed.data.precomputed?.pngBase64) {
    svg = parsed.data.precomputed.svg;
    png = base64ToBytes(parsed.data.precomputed.pngBase64);
  } else {
    const rendered = await renderQr(shortUrl);
    svg = rendered.svg;
    png = rendered.png;
  }

  const asset = await createAsset(
    c.env,
    sb,
    {
      ownerId: user.id,
      tool: "qr",
      name: parsed.data.name,
      tags: autoTags({
        tool: "qr",
        campaign: parsed.data.fields.campaign,
        source: parsed.data.fields.source,
        medium: parsed.data.fields.medium,
        content: parsed.data.fields.content,
        brand: parsed.data.brand,
        project: parsed.data.project,
      }),
      metadata: {
        destination: parsed.data.destination,
        taggedUrl,
        shortUrl,
        slug: slRes.row.slug,
        fields: parsed.data.fields,
      },
    },
    [
      { format: "svg", body: svg, contentType: "image/svg+xml" },
      { format: "png", body: png, contentType: "image/png" },
      { format: "url", body: taggedUrl },
    ],
  );

  return c.json({
    assetId: asset.assetId,
    slug: slRes.row.slug,
    shortUrl,
    taggedUrl,
    files: asset.files,
  });
});

function safeBuild(
  destination: string,
  fields: UtmFields,
  c: { json: (body: unknown, status?: number) => Response },
): string | Response {
  try {
    return buildTaggedUrl(destination, fields);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "build failed" },
      400,
    );
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
