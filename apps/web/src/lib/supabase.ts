import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anon) {
  // Fail loud, in dev only — production builds should always have these set.
  console.error(
    "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing. " +
      "Copy apps/web/.env.local.example to .env.local and fill them in.",
  );
}

export const supabase = createClient(url ?? "", anon ?? "", {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
