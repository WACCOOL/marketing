import { Hono } from "hono";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";

export const meRoutes = new Hono<AppBindings>();

meRoutes.get("/", requireAuth, async (c) => {
  return c.json({ user: c.get("user") });
});
