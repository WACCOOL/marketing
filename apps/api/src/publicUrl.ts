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

/**
 * Re-stamp one of OUR asset URLs (a `/api/...` path, e.g. an uploaded scene)
 * onto the current `publicOrigin`. Scene URLs are minted at upload time and then
 * stored client-side, so a URL created before `PUBLIC_BASE_URL` was set (or under
 * a different dev tunnel) can carry a stale `localhost`/old-tunnel origin that the
 * render-worker cannot fetch. We normalize the origin right before handing the
 * URL to the generator/worker. External URLs (e.g. Sales Layer CDN) are left
 * untouched — only same-namespace `/api/` paths are re-stamped.
 */
export function normalizeAssetUrl(
  c: Context<AppBindings>,
  url: string | undefined,
): string | undefined {
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.pathname.startsWith("/api/")) return url;
  return `${publicOrigin(c)}${parsed.pathname}${parsed.search}`;
}
