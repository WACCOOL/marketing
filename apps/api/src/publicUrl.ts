import type { Context } from "hono";
import type { AppBindings } from "./auth.js";

/**
 * The origin to use when building public URLs (uploads, generated scenes, shot
 * previews) that the render-worker / generator must fetch back over HTTP.
 *
 * Production: the request origin (the custom domain) is correct. Local dev:
 * wrangler reports the configured custom-domain host on `request.url` even though
 * it's served on localhost, which makes those URLs unfetchable by a local
 * render-worker — so `PUBLIC_BASE_URL` (e.g. http://localhost:8787) overrides it.
 */
export function publicOrigin(c: Context<AppBindings>): string {
  const override = c.env.PUBLIC_BASE_URL;
  if (override) return override.replace(/\/+$/, "");
  return new URL(c.req.url).origin;
}
