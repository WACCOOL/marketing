import type { ThomEnv } from "@wac/shared/thom";

/**
 * The PUBLIC Thom Bot Worker environment.
 *
 * SECURITY LAYER 1 — the absence of service-role / HubSpot credentials.
 * This interface deliberately DOES NOT declare `SUPABASE_SERVICE_ROLE_KEY` or
 * any `HUBSPOT_*` binding. The public bot runs the shared Thom brain with
 * surface:'public', which never composes the CRM tool extension (see
 * @wac/shared/thom composeTools) — but even if a bug tried to, there is no
 * service-role key to bypass RLS and no HubSpot token to reach the CRM. The
 * public Worker simply cannot hold those secrets: they are not in its env, not
 * in its wrangler.jsonc, and not in `.dev.vars`. Security is enforced by
 * absence, not just by policy.
 *
 * PublicEnv structurally satisfies ThomEnv (it carries `AI`, `ANTHROPIC_API_KEY`,
 * and the THOM_* flags the brain reads), so it can be passed straight into
 * runThomStream.
 */
export interface PublicEnv extends ThomEnv {
  // --- Supabase (ANON only — never service role) ---
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;

  // --- Workers AI (bge-m3 embeddings for KB + product hybrid search) ---
  AI: Ai;

  // --- KV: rate/token counters (day/min) + minted-session bookkeeping ---
  THOM_KV: KVNamespace;

  // --- Claude brain ---
  ANTHROPIC_API_KEY: string;

  // --- Turnstile (bot gate) + session signing ---
  TURNSTILE_SECRET: string;
  SESSION_SECRET: string;

  // --- Embed allowlist (comma-separated origins). Drives the widget embed
  //     check AND the CSP frame-ancestors header. Unset = none in prod
  //     (localhost still allowed for dev). ---
  ALLOWED_ORIGINS?: string;

  // --- Public tool flags (Davis wants these ON for the public surface). All
  //     read structurally via ThomEnv; re-declared here for documentation. ---
  THOM_PHOTOMETRICS?: string;
  THOM_LAYOUT?: string;
  THOM_TIERING?: string;
  // Per-turn native web_search cap on the public surface (default 2, clamp 1..3).
  THOM_PUBLIC_WEB_SEARCH_MAX_USES?: string;

  // --- Optional cap overrides (see src/limits.ts for the defaults these
  //     override). All parsed as ints; a bad/unset value falls back to the
  //     default so a typo can never uncork spend. ---
  THOM_RATE_PER_MIN?: string; // per-IP+siteKey requests / minute (default 20)
  THOM_RATE_PER_DAY?: string; // per-IP+siteKey requests / day    (default 300)
  THOM_TOKENS_PER_IP_DAY?: string; // per-IP tokens / day          (default 200000)
  THOM_TOKENS_GLOBAL_DAY?: string; // GLOBAL tokens / day          (default 5000000)
}

// A compile-time assertion that PublicEnv is assignable to ThomEnv (i.e. the
// public Worker env can drive the shared brain). If someone widens ThomEnv in a
// way PublicEnv no longer satisfies, this line fails to typecheck.
const _assertThomEnv: (e: PublicEnv) => ThomEnv = (e) => e;
void _assertThomEnv;
