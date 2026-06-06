import { getContainer } from "@cloudflare/containers";
import { containerPoolKey } from "./containerPool.js";
import type { Env } from "./env.js";

/**
 * Single entry point for calling the generation service.
 *
 * - Production: routes to the GENERATION_CONTAINER Durable Object (a warm pool
 *   keyed by `routingKey`), exactly as the queue/scenes paths did before.
 * - Local dev: when `env.GENERATOR_URL` is set, calls that host-run generator
 *   over plain HTTP instead. The local Cloudflare container runtime's proxy
 *   sidecar fails to start under some Docker/kernel setups (workers-sdk#12965),
 *   so this lets the full UI be exercised locally without Docker in the loop.
 *
 * `routingKey` is only used for container pool affinity; it's ignored in the
 * GENERATOR_URL path.
 */
export async function generatorFetch(
  env: Env,
  routingKey: string,
  path: string,
  init: {
    method?: string;
    body?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers = { "content-type": "application/json", ...(init.headers ?? {}) };

  if (env.GENERATOR_URL) {
    const base = env.GENERATOR_URL.replace(/\/+$/, "");
    return fetch(`${base}${path}`, {
      method: init.method ?? "POST",
      body: init.body,
      headers,
      signal: init.signal,
    });
  }

  const container = getContainer(
    env.GENERATION_CONTAINER,
    containerPoolKey(routingKey),
  );
  return container.fetch(
    new Request(`http://generation-container${path}`, {
      method: init.method ?? "POST",
      body: init.body,
      headers,
      signal: init.signal,
    }),
  );
}
