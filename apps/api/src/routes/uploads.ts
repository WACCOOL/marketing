import { Hono } from "hono";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { publicOrigin } from "../publicUrl.js";

export const uploadRoutes = new Hono<AppBindings>();

/**
 * User image uploads (Phase 2e). Scenes and concept-mode reference images are
 * uploaded here and stored in R2, then fetched by the generation Container at
 * generation time. The container fetches over plain HTTPS with no auth (see
 * apps/generator/src/fetchImage.ts), so the GET below is intentionally public —
 * keys use crypto.randomUUID() so they're unguessable.
 */

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB, mirrors the container's fetch cap.

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Upload an image. Body is the raw image bytes; content-type drives the ext. */
uploadRoutes.post("/", requireAuth, async (c) => {
  const user = c.get("user");

  const contentType = (c.req.header("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const ext = EXT_BY_TYPE[contentType];
  if (!ext) {
    return c.json(
      { error: "unsupported content-type; use image/png, image/jpeg, or image/webp" },
      415,
    );
  }

  const lenHeader = c.req.header("content-length");
  if (lenHeader && Number(lenHeader) > MAX_UPLOAD_BYTES) {
    return c.json({ error: `image exceeds max size (${MAX_UPLOAD_BYTES} bytes)` }, 413);
  }

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) {
    return c.json({ error: "empty body" }, 400);
  }
  if (body.byteLength > MAX_UPLOAD_BYTES) {
    return c.json({ error: `image exceeds max size (${MAX_UPLOAD_BYTES} bytes)` }, 413);
  }

  const file = `${crypto.randomUUID()}.${ext}`;
  const key = `uploads/${user.id}/${file}`;
  await c.env.ASSETS_BUCKET.put(key, body, {
    httpMetadata: { contentType },
  });

  // Absolute URL so the Container (which has no notion of our origin) can fetch
  // it directly over HTTPS.
  const url = `${publicOrigin(c)}/api/uploads/${user.id}/${file}`;
  return c.json({ url }, 201);
});

/**
 * Public read for an uploaded image. No auth: the generation Container needs to
 * fetch scenes/references over plain HTTPS, and the assets route is auth-gated.
 * Unguessable UUID keys keep these effectively private.
 */
uploadRoutes.get("/:userId/:file", async (c) => {
  const userId = c.req.param("userId");
  const file = c.req.param("file");
  const key = `uploads/${userId}/${file}`;

  const obj = await c.env.ASSETS_BUCKET.get(key);
  if (!obj) return c.json({ error: "not found" }, 404);

  const contentType =
    obj.httpMetadata?.contentType ?? guessImageType(file);
  return new Response(obj.body, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=86400",
    },
  });
});

function guessImageType(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
