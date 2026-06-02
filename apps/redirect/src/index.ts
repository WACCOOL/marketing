import { createClient } from "@supabase/supabase-js";

interface Env {
  SHORT_LINKS: KVNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

const KV_PREFIX = "slug:";

/**
 * Short-link redirect Worker for `gowac.cc/:slug`.
 *
 * Hot path: KV lookup -> 301 immediately. Anything that touches Postgres
 * (scan counters, KV-miss fallback lookup, warming the KV cache after a miss)
 * runs inside ctx.waitUntil() so scans never pay for analytics latency.
 *
 * KV reads are eventually consistent across regions, but writes from the API
 * Worker propagate quickly enough that this is fine for our use case. The
 * miss-fallback to Postgres covers the cold-cache case.
 */
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const slug = url.pathname.replace(/^\//, "").split("/")[0] ?? "";

    if (!slug) return landingPage();
    if (slug === "_health") return new Response("ok", { status: 200 });
    if (slug === "favicon.ico" || slug === "robots.txt") {
      return new Response(null, { status: 404 });
    }

    // 1) Fast path: KV.
    let destination = await env.SHORT_LINKS.get(KV_PREFIX + slug);

    // 2) Slow path: Postgres fallback. We do this synchronously *only* on
    //    cache miss, then warm KV inside waitUntil so future scans are fast.
    if (!destination) {
      destination = await postgresLookup(env, slug);
      if (destination) {
        const finalDest = destination; // capture for the closure
        ctx.waitUntil(env.SHORT_LINKS.put(KV_PREFIX + slug, finalDest));
      }
    }

    if (!destination) return notFound(slug);

    // 3) Fire the scan-count write AFTER the redirect response is sent. The
    //    waitUntil call lets the Worker keep the request open long enough to
    //    finish the Postgres write without blocking the redirect.
    ctx.waitUntil(recordScan(env, slug, req));

    return Response.redirect(destination, 301);
  },
} satisfies ExportedHandler<Env>;

async function postgresLookup(env: Env, slug: string): Promise<string | null> {
  try {
    const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await sb
      .from("short_links")
      .select("destination_url")
      .eq("slug", slug)
      .maybeSingle();
    if (error || !data) return null;
    return (data as { destination_url: string }).destination_url;
  } catch {
    return null;
  }
}

async function recordScan(env: Env, slug: string, req: Request): Promise<void> {
  try {
    const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Postgres-side: increment scan_count and update last_scanned_at via the
    // increment_scan SQL function (defined in migrations).
    await sb.rpc("increment_scan", {
      p_slug: slug,
      p_user_agent: req.headers.get("user-agent") ?? "",
      p_referrer: req.headers.get("referer") ?? "",
    });
  } catch {
    // Swallow — scans must never break the redirect.
  }
}

function notFound(slug: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Not found</title>` +
      `<h1>Link not found</h1><p>The short link <code>/${slug}</code> doesn't exist (yet).</p>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function landingPage(): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>gowac.cc</title>` +
      `<h1>gowac.cc</h1><p>WAC Group short-link service.</p>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
