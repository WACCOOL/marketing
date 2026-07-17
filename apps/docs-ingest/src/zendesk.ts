import type { ZendeskArticle } from "./articles.js";

/**
 * ZenDesk Help Center reader for the docs-ingest CLI (Node). It cannot import
 * the Worker-bound zd() in apps/api/src/zendesk.ts (that takes the Worker `Env`),
 * so this reuses the same API-token basic-auth scheme against process.env:
 *   base64("{email}/token:{api_token}")  ->  https://{subdomain}.zendesk.com
 *
 * Only the read paths Thom needs: list published articles (cursor-paginated full
 * list, or the incremental endpoint when given a start epoch) and fetch one
 * article's body for re-extraction. 429s are retried with Retry-After backoff.
 */

const MAX_RATE_LIMIT_RETRIES = 6;
const USER_AGENT = "WAC-Marketing-App/1.0 (+thom help-center ingest; contact WAC IT)";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ZendeskCreds {
  subdomain: string;
  email: string;
  token: string;
}

/** Read + validate the three ZENDESK_* vars from the environment, or null. */
export function zendeskCredsFromEnv(e: NodeJS.ProcessEnv): ZendeskCreds | null {
  const subdomain = e.ZENDESK_SUBDOMAIN;
  const email = e.ZENDESK_EMAIL;
  const token = e.ZENDESK_API_TOKEN;
  if (!subdomain || !email || !token) return null;
  return { subdomain, email, token };
}

interface CursorPage {
  articles: ZendeskArticle[];
  /** Absolute URL of the next cursor page, or null when exhausted. */
  nextUrl: string | null;
}

/**
 * Parse one cursor-pagination response body (`/help_center/.../articles.json`).
 * Pure so paging termination is unit-testable. ZenDesk cursor responses carry
 * `links.next` (absolute URL) and `meta.has_more`; when `has_more` is false the
 * next URL is dropped so the loop stops.
 */
export function parseCursorPage(body: unknown): CursorPage {
  const b = (body ?? {}) as {
    articles?: ZendeskArticle[];
    links?: { next?: string | null };
    meta?: { has_more?: boolean };
  };
  const articles = Array.isArray(b.articles) ? b.articles : [];
  const hasMore = b.meta?.has_more === true;
  const nextUrl = hasMore && b.links?.next ? b.links.next : null;
  return { articles, nextUrl };
}

interface IncrementalPage {
  articles: ZendeskArticle[];
  /** Absolute URL of the next incremental page, or null when the last page is reached. */
  nextPage: string | null;
}

/**
 * Parse one incremental-export response body
 * (`/help_center/incremental/articles.json`). The stream ends when `next_page`
 * is null or the page came back under the 1000-record window (`count < 1000`).
 * Pure for testability.
 */
export function parseIncrementalPage(body: unknown): IncrementalPage {
  const b = (body ?? {}) as {
    articles?: ZendeskArticle[];
    next_page?: string | null;
    count?: number;
  };
  const articles = Array.isArray(b.articles) ? b.articles : [];
  const done = !b.next_page || (typeof b.count === "number" && b.count < 1000);
  return { articles, nextPage: done ? null : (b.next_page ?? null) };
}

export interface ListArticlesOpts {
  locale: string;
  /** When set, use the incremental endpoint from this epoch (seconds); else full list. */
  sinceEpoch?: number;
}

export class ZendeskReader {
  private readonly base: string;
  private readonly authHeader: string;

  constructor(creds: ZendeskCreds) {
    this.base = `https://${creds.subdomain}.zendesk.com`;
    this.authHeader = `Basic ${Buffer.from(`${creds.email}/token:${creds.token}`).toString("base64")}`;
  }

  /** One GET with 429 backoff. `pathOrUrl` may be an absolute URL (cursor links) or a path. */
  private async get(pathOrUrl: string): Promise<unknown> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.base}${pathOrUrl}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        headers: {
          authorization: this.authHeader,
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
      });
      if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const ra = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(10_000, 500 * 2 ** attempt);
        await delay(wait);
        continue;
      }
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        throw new Error(`ZenDesk GET ${url} -> ${res.status}: ${text}`);
      }
      return res.json();
    }
  }

  /** Fetch every article (full cursor list, or incremental since an epoch). */
  async listArticles(opts: ListArticlesOpts): Promise<ZendeskArticle[]> {
    const out: ZendeskArticle[] = [];
    if (opts.sinceEpoch !== undefined) {
      let next: string | null =
        `/api/v2/help_center/incremental/articles.json?start_time=${Math.floor(opts.sinceEpoch)}`;
      while (next) {
        const page = parseIncrementalPage(await this.get(next));
        out.push(...page.articles);
        next = page.nextPage;
      }
      return out;
    }
    let next: string | null =
      `/api/v2/help_center/${encodeURIComponent(opts.locale)}/articles.json?page[size]=100`;
    while (next) {
      const page = parseCursorPage(await this.get(next));
      out.push(...page.articles);
      next = page.nextUrl;
    }
    return out;
  }

  /** Fetch a single article (used to re-read the body at extraction time). */
  async getArticle(id: string | number, locale?: string): Promise<ZendeskArticle | null> {
    const path = locale
      ? `/api/v2/help_center/${encodeURIComponent(locale)}/articles/${id}.json`
      : `/api/v2/help_center/articles/${id}.json`;
    const body = (await this.get(path)) as { article?: ZendeskArticle };
    return body?.article ?? null;
  }
}
