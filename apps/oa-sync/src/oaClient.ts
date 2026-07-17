import type { OaOrderDetail, OaOrderSummary } from "@wac/shared";

import { oaHeaders } from "./oaAuth.js";

/**
 * OA REST client. Five endpoints, identical auth (HMAC per request, ±5 min
 * timestamp window, single-use nonce):
 *   GET /orders (paginated list)      GET /order/{id} (full detail)
 *   GET /quotes  GET /projects  GET /customers   (added 2026-07-14; response
 *   schemas undocumented — `--sample` prints them verbatim for introspection)
 *
 * Envelope: { code: 1 | 0, msg, data }. code 0 with HTTP 200 happens, so both
 * are checked. Headers are rebuilt INSIDE the retry loop — the server caches
 * nonces, so replaying an attempt's headers guarantees a 403.
 */

const DEFAULT_BASE = "https://oa.waclighting.com.cn/api2/international";

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const PAGE_SIZE = 100;
const MAX_PAGES = 100; // runaway guard — ~10k records is far beyond OA volume

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface OaPage<T> {
  pageNo?: number;
  count?: number;
  pageSize?: number;
  list?: T[];
}

interface Envelope<T> {
  code?: 0 | 1;
  msg?: string;
  data?: T;
}

export class OaClient {
  constructor(
    private readonly secret: string,
    private readonly base = process.env.OA_BASE_URL || DEFAULT_BASE,
  ) {}

  private async get<T>(path: string): Promise<T> {
    // The docs sign the UTC date; if OA actually signs China-local dates the
    // two diverge from 16:00 UTC onward. On an auth reject we retry once with
    // the +8h day before giving up (dayOffsets), then fail loud.
    const dayOffsets = [0, 1];
    let lastErr: unknown;
    for (const dayOffset of dayOffsets) {
      for (let attempt = 1; ; attempt++) {
        let res: Response;
        try {
          res = await fetch(`${this.base}${path}`, {
            headers: oaHeaders(this.secret, Date.now(), dayOffset),
          });
        } catch (e) {
          if (attempt >= MAX_ATTEMPTS) throw e;
          const wait = Math.min(30_000, 1000 * 2 ** (attempt - 1));
          console.warn(`[oa-sync] OA ${path} network error (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${wait}ms: ${String(e).slice(0, 120)}`);
          await sleep(wait);
          continue;
        }
        const text = await res.text();
        let body: Envelope<T> = {};
        try {
          body = JSON.parse(text) as Envelope<T>;
        } catch {
          /* non-JSON error body — handled below */
        }
        if (res.ok && body.code === 1) return body.data as T;

        const summary = `OA GET ${path} -> HTTP ${res.status} code=${body.code ?? "?"} msg=${(body.msg ?? text).slice(0, 200)}`;
        lastErr = new Error(summary);
        // 401/403 = auth (bad signature / expired timestamp / reused nonce):
        // no point hammering — break to the date-fallback pass instead.
        if (res.status === 401 || res.status === 403) break;
        if (attempt >= MAX_ATTEMPTS || !(RETRY_STATUSES.has(res.status) || body.code === 0)) {
          throw lastErr;
        }
        const wait = Math.min(30_000, 1000 * 2 ** (attempt - 1));
        console.warn(`[oa-sync] ${summary} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${wait}ms`);
        await sleep(wait);
      }
      console.warn(`[oa-sync] OA ${path} auth-rejected with UTC+${dayOffset * 24}h date — ${dayOffset === 0 ? "trying the China-local day" : "giving up"}`);
    }
    throw lastErr;
  }

  /** Fetch every page of a list endpoint. */
  private async listAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      const sep = path.includes("?") ? "&" : "?";
      const page = await this.get<OaPage<T> | T[]>(`${path}${sep}pageNo=${pageNo}&pageSize=${PAGE_SIZE}`);
      // Tolerate both {list, count} pagination and a bare array (schema of the
      // new endpoints is unconfirmed).
      const list = Array.isArray(page) ? page : (page.list ?? []);
      out.push(...list);
      const count = Array.isArray(page) ? list.length : (page.count ?? out.length);
      if (list.length === 0 || out.length >= count) return out;
    }
    throw new Error(`OA ${path}: pagination did not terminate within ${MAX_PAGES} pages`);
  }

  listOrders(): Promise<OaOrderSummary[]> {
    return this.listAll<OaOrderSummary>("/orders");
  }

  getOrder(id: string | number): Promise<OaOrderDetail> {
    return this.get<OaOrderDetail>(`/order/${encodeURIComponent(String(id))}`);
  }

  listQuotes(): Promise<Record<string, unknown>[]> {
    return this.listAll<Record<string, unknown>>("/quotes");
  }

  listProjects(): Promise<Record<string, unknown>[]> {
    return this.listAll<Record<string, unknown>>("/projects");
  }

  listCustomers(): Promise<Record<string, unknown>[]> {
    return this.listAll<Record<string, unknown>>("/customers");
  }

  /** First page of a list endpoint, raw envelope data — for `--sample`. */
  samplePage(path: "/orders" | "/quotes" | "/projects" | "/customers"): Promise<unknown> {
    return this.get<unknown>(`${path}?pageNo=1&pageSize=${PAGE_SIZE}`);
  }
}
