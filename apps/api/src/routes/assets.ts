import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { userSupabase } from "../supabase.js";

export const assetRoutes = new Hono<AppBindings>();

const ListSchema = z.object({
  q: z.string().optional(),
  tool: z.enum(["utm", "qr", "appimage", "ppt", "layout"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

assetRoutes.get("/", requireAuth, async (c) => {
  const parsed = ListSchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) {
    return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));

  let query = sb
    .from("assets")
    .select(
      "id, owner_id, tool, name, org_visibility, tags, metadata_json, parent_asset_id, version, created_at, asset_files(format, r2_key, bytes)",
    )
    .order("created_at", { ascending: false })
    .range(parsed.data.offset, parsed.data.offset + parsed.data.limit - 1);

  if (parsed.data.tool) query = query.eq("tool", parsed.data.tool);
  if (parsed.data.q && parsed.data.q.length > 0) {
    // Full-text over the tsvector column populated by trigger (see migrations).
    query = query.textSearch("search_tsv", parsed.data.q, {
      type: "websearch",
      config: "english",
    });
  }

  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ assets: data ?? [] });
});

assetRoutes.get("/:id/files/:format", requireAuth, async (c) => {
  const assetId = c.req.param("id");
  const format = c.req.param("format");
  const sb = userSupabase(c.env, c.get("jwt"));

  // RLS will refuse the asset_files lookup if the user can't see the asset,
  // so we never serve bytes someone is not authorised to see.
  const { data: row, error } = await sb
    .from("asset_files")
    .select("r2_key, asset_id")
    .eq("asset_id", assetId)
    .eq("format", format)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!row) return c.json({ error: "not found" }, 404);

  const obj = await c.env.ASSETS_BUCKET.get((row as { r2_key: string }).r2_key);
  if (!obj) return c.json({ error: "object missing" }, 404);

  const contentType = guessContentType(format);
  return new Response(obj.body, {
    headers: {
      "content-type": contentType,
      "cache-control": "private, max-age=300",
    },
  });
});

/**
 * Overwrite an asset's stored image with new bytes (used by the "crop before
 * save" step: the client crops the generated image on a canvas and uploads the
 * result). Only the owner may overwrite, and only raster image formats. The R2
 * object is replaced in place at the existing key so links/format stay stable.
 */
const REPLACEABLE_FORMATS = new Set(["png", "jpeg", "jpg", "webp"]);
const MAX_REPLACE_BYTES = 25_000_000;

assetRoutes.post("/:id/files/:format", requireAuth, async (c) => {
  const assetId = c.req.param("id");
  const format = c.req.param("format");
  if (!REPLACEABLE_FORMATS.has(format)) {
    return c.json({ error: "format is not replaceable" }, 400);
  }
  const user = c.get("user");
  const sb = userSupabase(c.env, c.get("jwt"));

  // Only the owner may overwrite the stored image (visibility != ownership).
  const { data: asset, error: aerr } = await sb
    .from("assets")
    .select("id, owner_id")
    .eq("id", assetId)
    .maybeSingle();
  if (aerr) return c.json({ error: aerr.message }, 500);
  if (!asset) return c.json({ error: "not found" }, 404);
  if ((asset as { owner_id: string }).owner_id !== user.id) {
    return c.json({ error: "forbidden" }, 403);
  }

  const { data: row, error } = await sb
    .from("asset_files")
    .select("r2_key")
    .eq("asset_id", assetId)
    .eq("format", format)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!row) return c.json({ error: "not found" }, 404);

  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return c.json({ error: "empty body" }, 400);
  if (bytes.byteLength > MAX_REPLACE_BYTES) {
    return c.json({ error: "image too large" }, 413);
  }

  const key = (row as { r2_key: string }).r2_key;
  await c.env.ASSETS_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: guessContentType(format) },
  });
  // Best-effort byte-count update (RLS may restrict; the image is already saved).
  await sb
    .from("asset_files")
    .update({ bytes: bytes.byteLength })
    .eq("asset_id", assetId)
    .eq("format", format);

  return c.json({ ok: true });
});

function guessContentType(format: string): string {
  switch (format) {
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "psd":
      return "image/vnd.adobe.photoshop";
    case "url":
    case "txt":
      return "text/plain";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "csv":
      return "text/csv";
    default:
      return "application/octet-stream";
  }
}
