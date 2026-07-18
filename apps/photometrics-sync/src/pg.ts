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
