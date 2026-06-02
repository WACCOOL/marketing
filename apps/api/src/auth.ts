import { createMiddleware } from "hono/factory";
import type { Env } from "./env.js";
import { serviceSupabase, userSupabase } from "./supabase.js";

export interface AuthedUser {
  id: string;
  email: string;
  role: "internal" | "rep" | "admin";
  status: "active" | "pending";
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
export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return c.json({ error: "missing bearer token" }, 401);
  const jwt = match[1]!;

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
});

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
  if (existing) return existing as AuthedUser;

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

  return inserted as AuthedUser;
}
