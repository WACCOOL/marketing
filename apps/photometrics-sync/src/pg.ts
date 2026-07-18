/**
 * Postgres-safety helpers for values headed into Supabase.
 */

const NUL = String.fromCharCode(0);

/**
 * Postgres text/jsonb cannot store U+0000 (NUL). It shows up in some
 * gb18030-decoded IES keyword text, warning messages, and zip filenames, and a
 * single occurrence makes PostgREST reject the whole row with "unsupported
 * Unicode escape sequence". Strip it deeply from every string in the value
 * (recursing through arrays and plain objects) before an upsert.
 */
export function stripNul<T>(value: T): T {
  if (typeof value === "string") {
    return (value.includes(NUL) ? value.split(NUL).join("") : value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => stripNul(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripNul(v);
    return out as unknown as T;
  }
  return value;
}

/**
 * Collapse product_photometrics link rows that share a (product_sku,
 * ies_metrics_id) key. Byte-identical inner .ies files in one zip dedupe to a
 * single ies_metrics row, so a SKU can produce two links to the same id — and
 * Postgres `ON CONFLICT DO UPDATE` refuses to touch the same target row twice in
 * one batch ("cannot affect row a second time"). Keep a representative flag if
 * any duplicate had it, and the highest match_confidence.
 */
export function dedupeLinks(
  links: Record<string, unknown>[],
): Record<string, unknown>[] {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const link of links) {
    const key = JSON.stringify([link.product_sku, link.ies_metrics_id]);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...link });
      continue;
    }
    if (link.is_representative) prev.is_representative = true;
    const c = typeof link.match_confidence === "number" ? link.match_confidence : 0;
    const pc = typeof prev.match_confidence === "number" ? prev.match_confidence : 0;
    if (c > pc) prev.match_confidence = link.match_confidence;
  }
  return [...byKey.values()];
}
