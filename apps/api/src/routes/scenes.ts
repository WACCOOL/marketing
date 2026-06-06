import { Hono } from "hono";
import { z } from "zod";
import { FixtureMountSchema, SceneGenRequestSchema } from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { generatorFetch } from "../generatorClient.js";
import { publicOrigin } from "../publicUrl.js";

export const sceneRoutes = new Hono<AppBindings>();

/** Body for the perspective auto-fit proxy. */
const PerspectiveRequestSchema = z.object({
  sceneUrl: z.string().url(),
  mount: FixtureMountSchema.optional(),
});

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

  let res: Response;
  try {
    res = await generatorFetch(c.env, `scene:${user.id}`, "/generate-scene", {
      method: "POST",
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(CONTAINER_TIMEOUT_MS),
    });
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
  const url = `${publicOrigin(c)}/api/uploads/${user.id}/${file}`;
  return c.json({ url }, 201);
});

/**
 * Vision-based perspective auto-fit. Forwards the scene URL + mount to the
 * container's /suggest-perspective endpoint and returns a keystone hint
 * { vertical, horizontal }. The client falls back to its positional heuristic
 * if this fails, so a 502 here is non-fatal to the UX.
 */
sceneRoutes.post("/perspective", requireAuth, async (c) => {
  if (!c.env.GEMINI_API_KEY) {
    return c.json(
      { error: "perspective auto-fit is not configured (set GEMINI_API_KEY)" },
      400,
    );
  }

  const parsed = PerspectiveRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }

  const user = c.get("user");

  let res: Response;
  try {
    res = await generatorFetch(
      c.env,
      `scene:${user.id}`,
      "/suggest-perspective",
      {
        method: "POST",
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(45_000),
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `perspective estimate failed: ${msg}` }, 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return c.json(
      { error: detail || `perspective estimate failed (${res.status})` },
      502,
    );
  }
  return c.json(await res.json());
});
