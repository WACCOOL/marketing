import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import {
  ALL_FEATURE_KEYS,
  computeFeatures,
  type FeatureKey,
} from "@wac/shared";
import type { Env } from "./env.js";
import { serviceSupabase, userSupabase } from "./supabase.js";

export interface AuthedUser {
  id: string;
  email: string;
  role: "internal" | "rep" | "admin";
  status: "active" | "pending";
  /**
   * Effective feature (menu-tab) access — role default adjusted by per-user
   * overrides; admins always get every feature. See @wac/shared features +
   * `requireFeature`. Drives the web sidebar/route guards and API gating.
   */
  features: string[];
}

export interface AppBindings {
  Bindings: Env;
  Variables: {
    user: AuthedUser;
    jwt: string;
  };
}

/**
 * Verifies the Authorization: Bearer <jwt> header against Supabase Auth,
 * provisions/loads the matching public.users row, and stashes both on the
 * Hono context. Pending reps may authenticate but are blocked from writes
 * by RLS.
 */
export const requireAuth = createMiddleware<AppBindings>(verifySession);

/**
 * Like `requireAuth`, but also accepts a shared admin token (the
 * `ADMIN_API_TOKEN` Worker secret) presented as `Authorization: Bearer <token>`.
 * A match authenticates as a synthetic `admin` user with no Supabase session —
 * for server-to-server callers like the fixture-sync CLI triggering a GLB
 * export to bake picker thumbnails. Falls back to normal session verification
 * for everyone else.
 */
export const requireAuthOrAdmin = createMiddleware<AppBindings>(
  async (c, next) => {
    const token = bearerToken(c);
    const adminToken = c.env.ADMIN_API_TOKEN;
    if (token && adminToken && timingSafeEqual(token, adminToken)) {
      c.set("jwt", token);
      c.set("user", {
        id: "admin-token",
        email: "admin@token",
        role: "admin",
        status: "active",
        features: [...ALL_FEATURE_KEYS],
      });
      await next();
      return;
    }
    return verifySession(c, next);
  },
);

/** Synthetic user id for the shared-ingest-token (Power Automate) path. */
export const INGEST_TOKEN_USER_ID = "ingest-token";

/**
 * Auth for the marketing data ingest endpoint. Accepts EITHER:
 *   - the shared `INGEST_API_TOKEN` Worker secret (Power Automate pushes) →
 *     authenticates as a synthetic active `internal` user, or
 *   - a normal Supabase session (the manual GUI upload path).
 * A DEDICATED token (separate from `ADMIN_API_TOKEN`) so a leaked ingest token
 * can never reach admin/GLB routes. Per-source authorization (e.g. pricing is
 * admin-only) is enforced in the route, not here.
 */
export const requireIngestAuth = createMiddleware<AppBindings>(
  async (c, next) => {
    const token = bearerToken(c);
    const ingestToken = c.env.INGEST_API_TOKEN;
    if (token && ingestToken && timingSafeEqual(token, ingestToken)) {
      c.set("jwt", token);
      c.set("user", {
        id: INGEST_TOKEN_USER_ID,
        email: "ingest@token",
        role: "internal",
        status: "active",
        features: [...ALL_FEATURE_KEYS],
      });
      await next();
      return;
    }
    return verifySession(c, next);
  },
);

/** Synthetic user id for the SAP -> HubSpot sync capture token path. */
export const SAP_SYNC_TOKEN_USER_ID = "sap-sync-token";

/**
 * Auth for the SAP -> HubSpot sync capture endpoints (POST /api/hubspot-sync/...).
 * Accepts EITHER the shared `SAP_SYNC_TOKEN` Worker secret (the AWS Lambdas
 * forwarding payloads) → a synthetic active `internal` user, OR a normal Supabase
 * session (so the dashboard's authenticated admin can hit the same routes during
 * testing). A DEDICATED token (separate from INGEST/ADMIN) so a leaked SAP token
 * can never reach the file inbox or admin routes.
 */
export const requireSapSyncAuth = createMiddleware<AppBindings>(
  async (c, next) => {
    const token = bearerToken(c);
    const syncToken = c.env.SAP_SYNC_TOKEN;
    if (token && syncToken && timingSafeEqual(token, syncToken)) {
      c.set("jwt", token);
      c.set("user", {
        id: SAP_SYNC_TOKEN_USER_ID,
        email: "sap-sync@token",
        role: "internal",
        status: "active",
        features: [...ALL_FEATURE_KEYS],
      });
      await next();
      return;
    }
    return verifySession(c, next);
  },
);

/** Pull the Bearer token from the Authorization header, if present. */
function bearerToken(c: Context<AppBindings>): string | null {
  const match = (c.req.header("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1]! : null;
}

/** Constant-time string compare so the admin token can't be timing-probed. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Require an authenticated user with a specific feature granted. Assumes an
 * auth middleware (requireAuth / requireAuthOrAdmin / ...) already ran and set
 * `user`. Admins always pass; everyone else must have the feature in their
 * effective set. Lets per-user grants actually gate the API, not just the nav.
 */
export function requireFeature(key: FeatureKey) {
  return createMiddleware<AppBindings>(async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "missing bearer token" }, 401);
    if (user.role === "admin" || user.features.includes(key)) {
      await next();
      return;
    }
    return c.json(
      { error: `access to this feature ("${key}") is not enabled for your account` },
      403,
    );
  });
}

/** Verify a Supabase session JWT and stash the user/jwt on the context. */
async function verifySession(c: Context<AppBindings>, next: Next) {
  // Idempotent: if an upstream auth middleware already resolved the user (e.g.
  // a mount-level requireAuth+requireFeature gate in index.ts), don't re-verify
  // the JWT — just continue. This lets routes keep their own requireAuth while
  // a group gate runs first, without paying a double Supabase round-trip.
  if (c.get("user")) {
    await next();
    return;
  }

  const jwt = bearerToken(c);
  if (!jwt) return c.json({ error: "missing bearer token" }, 401);

  const sb = userSupabase(c.env, jwt);
  const { data: userRes, error: userErr } = await sb.auth.getUser(jwt);
  if (userErr || !userRes.user || !userRes.user.email) {
    return c.json({ error: "invalid token" }, 401);
  }

  const profile = await ensureUserProfile(c.env, {
    id: userRes.user.id,
    email: userRes.user.email,
  });

  c.set("jwt", jwt);
  c.set("user", profile);
  await next();
}

/**
 * Look up (or provision) the public.users row for this auth user. Implements
 * the §2 domain rule: an approved corporate domain auto-provisions an
 * `internal` user; otherwise the user is created as a `rep` with
 * status=`pending` until an admin approves.
 */
export async function ensureUserProfile(
  env: Env,
  authUser: { id: string; email: string },
): Promise<AuthedUser> {
  const admin = serviceSupabase(env);

  const { data: existing, error: selErr } = await admin
    .from("users")
    .select("id, email, role, status")
    .eq("id", authUser.id)
    .maybeSingle();
  if (selErr) throw new Error(`users lookup failed: ${selErr.message}`);
  if (existing) {
    const base = existing as Omit<AuthedUser, "features">;
    return { ...base, features: await loadFeatures(env, base.id, base.role) };
  }

  // First login — decide role from email domain.
  const domain = authUser.email.split("@")[1]?.toLowerCase() ?? "";
  const { data: approved, error: domErr } = await admin
    .from("approved_domains")
    .select("domain")
    .eq("domain", domain)
    .maybeSingle();
  if (domErr) {
    throw new Error(`approved_domains lookup failed: ${domErr.message}`);
  }

  const isInternal = !!approved;
  const role: AuthedUser["role"] = isInternal ? "internal" : "rep";
  const status: AuthedUser["status"] = isInternal ? "active" : "pending";

  const { data: inserted, error: insErr } = await admin
    .from("users")
    .insert({
      id: authUser.id,
      email: authUser.email,
      role,
      status,
    })
    .select("id, email, role, status")
    .single();
  if (insErr) throw new Error(`users insert failed: ${insErr.message}`);

  // A brand-new user has no overrides yet, so their features are the pure role
  // default.
  const base = inserted as Omit<AuthedUser, "features">;
  return { ...base, features: computeFeatures(base.role, []) };
}

/**
 * Load a user's per-user feature overrides and fold them onto their role
 * default to produce the effective feature set. Reads via the service client
 * (RLS-exempt) since this runs in the auth path for the user themselves.
 */
async function loadFeatures(
  env: Env,
  userId: string,
  role: AuthedUser["role"],
): Promise<string[]> {
  if (role === "admin") return [...ALL_FEATURE_KEYS];
  const admin = serviceSupabase(env);
  const { data, error } = await admin
    .from("user_features")
    .select("feature, allowed")
    .eq("user_id", userId);
  // Degrade gracefully rather than 500 the whole app: if the overrides table is
  // unavailable (e.g. migration 0031 not yet applied) or the query errors, fall
  // back to the user's role default instead of failing every authed request.
  if (error) {
    console.error(`[auth] user_features lookup failed, using role defaults: ${error.message}`);
    return computeFeatures(role, []);
  }
  return computeFeatures(
    role,
    (data ?? []) as { feature: string; allowed: boolean }[],
  );
}
