import { Hono } from "hono";
import { getContainer } from "@cloudflare/containers";
import { SceneGenRequestSchema } from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";

export const sceneRoutes = new Hono<AppBindings>();

/**
 * Text-to-room scene generation (Phase 2). The App Image generator needs a way
 * to produce a room when the user has no photo to upload. We forward the prompt
 * + size options to the generation Container's /generate-scene endpoint (Gemini,
 * a Gemini 3 image model so 4K is available), store the returned bytes in R2
 * under the same `uploads/` scheme as user uploads, and hand back a public URL
 * the container can later fetch as the composite/hybrid scene.
 *
 * Unlike the async job path this is synchronous (no library asset is created):
 * a generated room is an intermediate background, not a final deliverable.
 */

// 4K scenes can take well over a minute; give the container generous headroom.
const CONTAINER_TIMEOUT_MS = 150_000;

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

sceneRoutes.post("/", requireAuth, async (c) => {
  if (!c.env.GEMINI_API_KEY) {
    return c.json(
      { error: "scene generation is not configured (set GEMINI_API_KEY)" },
      400,
    );
  }

  const parsed = SceneGenRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }

  const user = c.get("user");
  const container = getContainer(c.env.GENERATION_CONTAINER, `scene:${user.id}`);

  let res: Response;
  try {
    res = await container.fetch(
      new Request("http://generation-container/generate-scene", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(CONTAINER_TIMEOUT_MS),
      }),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `scene generation failed: ${msg}` }, 502);
  }

  if (!res.ok) {
    // The container returns a JSON { error } on failure.
    const detail = await res.text().catch(() => "");
    let message = detail;
    try {
      const j = JSON.parse(detail) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      // keep raw text
    }
    return c.json({ error: message || `scene generation failed (${res.status})` }, 502);
  }

  const contentType = (res.headers.get("content-type") ?? "image/png")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const ext = EXT_BY_TYPE[contentType] ?? "png";
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0) {
    return c.json({ error: "scene generation returned no image" }, 502);
  }

  const file = `${crypto.randomUUID()}.${ext}`;
  const key = `uploads/${user.id}/${file}`;
  await c.env.ASSETS_BUCKET.put(key, bytes, {
    httpMetadata: { contentType },
  });

  // Absolute URL so the Container can later fetch it over HTTPS as the scene.
  const url = `${new URL(c.req.url).origin}/api/uploads/${user.id}/${file}`;
  return c.json({ url }, 201);
});
