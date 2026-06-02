import { Hono } from "hono";
import { z } from "zod";
import { UtmFieldsSchema, buildTaggedUrl, auditTaggedUrl } from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";

export const utmRoutes = new Hono<AppBindings>();

const PreviewSchema = z.object({
  destination: z.string().min(1),
  fields: UtmFieldsSchema,
});

/** Pure preview — server-side mirror of the client-side preview, useful from bulk. */
utmRoutes.post("/preview", requireAuth, async (c) => {
  const parsed = PreviewSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  try {
    const taggedUrl = buildTaggedUrl(parsed.data.destination, parsed.data.fields);
    return c.json({ taggedUrl, audit: auditTaggedUrl(taggedUrl) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "build failed" }, 400);
  }
});
