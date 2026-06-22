interface Env {
  SHORT_LINKS: KVNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

const KV_PREFIX = "slug:";

/**
 * Short-link redirect Worker for `gowac.cc/:slug`.
 *
 * Hot path: KV lookup -> 302 immediately. Anything that touches Postgres
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

    // 302 + no-store, NOT 301: a short link's destination is editable, so the
    // redirect must never be cached. Browsers cache 301s indefinitely and stop
    // re-requesting the Worker, which would pin a client to a stale destination
    // even after the owner edits it. 302 keeps every click re-resolving here,
    // and Cache-Control: no-store prevents any intermediary from caching it.
    return new Response(null, {
      status: 302,
      headers: {
        Location: destination,
        "Cache-Control": "no-store",
      },
    });
  },
} satisfies ExportedHandler<Env>;

/**
 * Direct PostgREST calls. We intentionally do NOT use @supabase/supabase-js
 * here — the SDK is ~100 KB of code that pulls in auth/realtime/etc that this
 * Worker doesn't need, and noticeably slows the cold Postgres fallback path.
 * These are one-liners over HTTPS; the Worker fetch() is already pooled.
 */

function supabaseHeaders(env: Env, extra?: Record<string, string>): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function postgresLookup(env: Env, slug: string): Promise<string | null> {
  try {
    const url =
      `${env.SUPABASE_URL}/rest/v1/short_links` +
      `?slug=eq.${encodeURIComponent(slug)}` +
      `&select=destination_url&limit=1`;
    const res = await fetch(url, {
      headers: supabaseHeaders(env, { accept: "application/json" }),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ destination_url: string }>;
    return rows[0]?.destination_url ?? null;
  } catch {
    return null;
  }
}

async function recordScan(env: Env, slug: string, req: Request): Promise<void> {
  try {
    // Calls the increment_scan(slug, user_agent, referrer) SQL function
    // defined in supabase/migrations/0002_schema.sql.
    await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/increment_scan`, {
      method: "POST",
      headers: supabaseHeaders(env, { "content-type": "application/json" }),
      body: JSON.stringify({
        p_slug: slug,
        p_user_agent: req.headers.get("user-agent") ?? "",
        p_referrer: req.headers.get("referer") ?? "",
      }),
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
