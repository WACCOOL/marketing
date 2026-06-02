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
