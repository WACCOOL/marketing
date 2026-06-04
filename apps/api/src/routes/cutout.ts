import { Hono } from "hono";
import { getContainer } from "@cloudflare/containers";
import { z } from "zod";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { containerPoolKey } from "../containerPool.js";

export const cutoutRoutes = new Hono<AppBindings>();

const CutoutRequestSchema = z.object({ sourceUrl: z.string().url() });

// Cutout (background removal) is a few Gemini/classical seconds; give generous headroom.
const CUTOUT_TIMEOUT_MS = 90_000;

/**
 * Background-removal proxy (Phase 2e). Takes a product image URL, asks the
 * generation Container to matte it into a transparent PNG (same matting the
 * final composite uses), stores the result in R2 under the user's uploads
 * prefix, and returns its public URL. The web fixture step calls this so the
 * placement preview shows the real, background-removed cutout.
 */
cutoutRoutes.post("/", requireAuth, async (c) => {
  const parsed = CutoutRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }

  const user = c.get("user");
  const container = getContainer(
    c.env.GENERATION_CONTAINER,
    containerPoolKey(`scene:${user.id}`),
  );

  let res: Response;
  try {
    res = await container.fetch(
      new Request("http://generation-container/cutout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceUrl: parsed.data.sourceUrl }),
        signal: AbortSignal.timeout(CUTOUT_TIMEOUT_MS),
      }),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: `cutout request failed: ${message}` }, 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return c.json({ error: `cutout failed: ${detail || res.status}` }, 502);
  }

  const png = Buffer.from(await res.arrayBuffer());
  const file = `${crypto.randomUUID()}.png`;
  const key = `uploads/${user.id}/${file}`;
  await c.env.ASSETS_BUCKET.put(key, png, {
    httpMetadata: { contentType: "image/png" },
  });

  const url = `${new URL(c.req.url).origin}/api/uploads/${user.id}/${file}`;
  return c.json({ url }, 201);
});
