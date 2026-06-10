import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env.js";

/**
 * Build a Supabase client scoped to the calling user's JWT. RLS policies
 * defined in supabase/migrations enforce visibility — we never bypass them on
 * the user-data path.
 */
export function userSupabase(env: Env, jwt: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Service-role Supabase client. RLS is bypassed — use ONLY for:
 *   - reading approved_domains on signup
 *   - provisioning the users row on first login
 *   - the redirect Worker's scan-count fallback
 */
export function serviceSupabase(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Resolve user ids -> emails via the service client (the users table is
 * self/admin-read under RLS, but creator attribution on shared items is not
 * sensitive — §2 requires showing who created each asset).
 */
export async function emailsForUserIds(
  env: Env,
  ids: Iterable<string>,
): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter(Boolean))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const { data } = await serviceSupabase(env)
    .from("users")
    .select("id, email")
    .in("id", unique);
  for (const u of (data ?? []) as { id: string; email: string }[]) {
    out.set(u.id, u.email);
  }
  return out;
}
