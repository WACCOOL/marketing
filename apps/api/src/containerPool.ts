/**
 * Shared generation-container routing.
 *
 * Both the queue consumer (image generation) and the scenes routes target the
 * SAME small fixed pool of container ids so instances stay warm and are reused
 * across scene + generate work. Routing by a unique id (e.g. jobId) instead
 * gave every request a brand-new instance and a full cold start (10-30s).
 */
export const CONTAINER_POOL_SIZE = 4;

/** Deterministically map an arbitrary key to one warm container pool slot. */
export function containerPoolKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return `gen-pool-${Math.abs(hash) % CONTAINER_POOL_SIZE}`;
}
