import { Hono } from "hono";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { publicOrigin } from "../publicUrl.js";

export const uploadRoutes = new Hono<AppBindings>();

/**
 * User uploads (Phase 2e). Scenes and concept-mode reference images are
 * uploaded here and stored in R2, then fetched by the generation Container at
 * generation time; PPT video-slide movies (mp4/webm) ride the same route. The
 * container fetches over plain HTTPS with no auth (see
 * apps/generator/src/fetchImage.ts), so the GET below is intentionally public —
 * keys use crypto.randomUUID() so they're unguessable.
 */

const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MB, mirrors the container's fetch cap.
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB — PPT video slides embed these.

const UPLOAD_TYPES: Record<string, { ext: string; kind: string; maxBytes: number }> = {
  "image/png": { ext: "png", kind: "image", maxBytes: MAX_IMAGE_BYTES },
  "image/jpeg": { ext: "jpg", kind: "image", maxBytes: MAX_IMAGE_BYTES },
  "image/webp": { ext: "webp", kind: "image", maxBytes: MAX_IMAGE_BYTES },
  "video/mp4": { ext: "mp4", kind: "video", maxBytes: MAX_VIDEO_BYTES },
  "video/webm": { ext: "webm", kind: "video", maxBytes: MAX_VIDEO_BYTES },
};

/** Upload an image or video. Body is the raw bytes; content-type drives the ext. */
uploadRoutes.post("/", requireAuth, async (c) => {
  const user = c.get("user");

  const contentType = (c.req.header("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const type = UPLOAD_TYPES[contentType];
  if (!type) {
    return c.json(
      {
        error:
          "unsupported content-type; use image/png, image/jpeg, image/webp, video/mp4, or video/webm",
      },
      415,
    );
  }
  const { ext, kind, maxBytes } = type;

  const lenHeader = c.req.header("content-length");
  if (lenHeader && Number(lenHeader) > maxBytes) {
    return c.json({ error: `${kind} exceeds max size (${maxBytes} bytes)` }, 413);
  }

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0) {
    return c.json({ error: "empty body" }, 400);
  }
  if (body.byteLength > maxBytes) {
    return c.json({ error: `${kind} exceeds max size (${maxBytes} bytes)` }, 413);
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
 * Public read for an uploaded file. No auth: the generation Container needs to
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
    obj.httpMetadata?.contentType ?? guessContentType(file);
  return new Response(obj.body, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=86400",
    },
  });
});

function guessContentType(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}
