import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PublicEnv } from "./env.js";

/**
 * SECURITY LAYER 2 — the anon Supabase client.
 *
 * The public bot reads the catalog / KB through the SAME anon key a browser
 * would use, so every query is subject to the RLS policies in
 * supabase/migrations (public-scope kb_chunks / products only; migration 0052).
 * There is NO service-role client in this Worker and no user JWT — the public
 * surface never authenticates a user. RLS, not application code, is the
 * authority on what the public bot can see.
 */
export function anonSupabase(env: PublicEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
