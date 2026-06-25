import { Hono } from "hono";
import { z } from "zod";
import { computeFeatures, isFeatureKey } from "@wac/shared";
import type { AppBindings, AuthedUser } from "../auth.js";
import { requireAuth } from "../auth.js";
import { serviceSupabase, userSupabase } from "../supabase.js";

/** Fetch a user's overrides via the given client and fold to effective set. */
async function readEffectiveFeatures(
  sb: ReturnType<typeof userSupabase>,
  userId: string,
  role: AuthedUser["role"],
): Promise<string[]> {
  const { data, error } = await sb
    .from("user_features")
    .select("feature, allowed")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  return computeFeatures(role, (data ?? []) as { feature: string; allowed: boolean }[]);
}

/**
 * §2 admin surface: approve pending reps, manage roles, and maintain the
 * approved_domains list that auto-provisions internal accounts. Everything
 * goes through the user-scoped client so the users_admin_update /
 * approved_domains_admin RLS policies stay the actual enforcement layer — the
 * role check here just gives non-admins a clean 403.
 */
export const adminRoutes = new Hono<AppBindings>();

adminRoutes.use("*", requireAuth, async (c, next) => {
  if (c.get("user").role !== "admin") {
    return c.json({ error: "admin only" }, 403);
  }
  await next();
});

adminRoutes.get("/users", async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("users")
    .select("id, email, role, status, created_at")
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  const users = (data ?? []) as {
    id: string;
    email: string;
    role: AuthedUser["role"];
    status: string;
    created_at: string;
  }[];

  // Attach each user's effective feature set so the Admin UI can render the
  // grant grid. One query for all overrides, grouped in memory.
  const { data: ovr, error: ovrErr } = await sb
    .from("user_features")
    .select("user_id, feature, allowed");
  if (ovrErr) return c.json({ error: ovrErr.message }, 500);
  const byUser = new Map<string, { feature: string; allowed: boolean }[]>();
  for (const row of (ovr ?? []) as {
    user_id: string;
    feature: string;
    allowed: boolean;
  }[]) {
    const list = byUser.get(row.user_id) ?? [];
    list.push({ feature: row.feature, allowed: row.allowed });
    byUser.set(row.user_id, list);
  }

  return c.json({
    users: users.map((u) => ({
      ...u,
      features: computeFeatures(u.role, byUser.get(u.id) ?? []),
    })),
  });
});

// Create an account ahead of first sign-in: invite via Supabase Auth (falls
// back to a confirmed user if invite email isn't configured), then provision
// the public.users row with the chosen role so the §2 domain rule is skipped.
const UserCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["internal", "rep", "admin"]).default("rep"),
});

adminRoutes.post("/users", async (c) => {
  const parsed = UserCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const { email, role } = parsed.data;
  const admin = serviceSupabase(c.env);

  const { data: existing } = await admin
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (existing) return c.json({ error: "an account with that email already exists" }, 409);

  // Invite sends a magic-link email; createUser is the fallback when the
  // project has no invite email configured (the user then signs in via
  // Google OAuth or requests their own magic link).
  let authUserId: string | null = null;
  let invited = true;
  const invite = await admin.auth.admin.inviteUserByEmail(email);
  if (invite.error || !invite.data.user) {
    invited = false;
    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (created.error || !created.data.user) {
      return c.json(
        { error: `could not create auth user: ${created.error?.message ?? invite.error?.message}` },
        500,
      );
    }
    authUserId = created.data.user.id;
  } else {
    authUserId = invite.data.user.id;
  }

  const { data: profile, error: insErr } = await admin
    .from("users")
    .insert({ id: authUserId, email, role, status: "active" })
    .select("id, email, role, status, created_at")
    .single();
  if (insErr) return c.json({ error: insErr.message }, 500);
  // A fresh account has no overrides yet, so features are the role default.
  return c.json(
    { user: { ...profile, features: computeFeatures(role, []) }, invited },
  );
});

const UserPatchSchema = z
  .object({
    role: z.enum(["internal", "rep", "admin"]).optional(),
    status: z.enum(["active", "pending"]).optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: "nothing to update",
  });

adminRoutes.patch("/users/:id", async (c) => {
  const id = c.req.param("id");
  const parsed = UserPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  // Self-demotion guard: an admin can't strip their own admin role or
  // deactivate themselves — prevents accidentally locking everyone out.
  if (id === c.get("user").id) {
    return c.json({ error: "you cannot change your own role or status" }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("users")
    .update(parsed.data)
    .eq("id", id)
    .select("id, email, role, status, created_at")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "not found" }, 404);
  // Include the (possibly re-based) effective features so the UI stays in sync
  // when a role change shifts the defaults.
  const role = (data as { role: AuthedUser["role"] }).role;
  return c.json({
    user: { ...data, features: await readEffectiveFeatures(sb, id, role) },
  });
});

// Per-user feature (menu-tab) overrides. A row pins a feature on/off for one
// user, overriding their role default; absence inherits the default. Admins are
// not editable here — they always have every feature.
const FeaturePatchSchema = z.object({
  feature: z.string().refine(isFeatureKey, "unknown feature"),
  allowed: z.boolean(),
});

adminRoutes.patch("/users/:id/features", async (c) => {
  const id = c.req.param("id");
  const parsed = FeaturePatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data: target, error: tErr } = await sb
    .from("users")
    .select("id, role")
    .eq("id", id)
    .maybeSingle();
  if (tErr) return c.json({ error: tErr.message }, 500);
  if (!target) return c.json({ error: "not found" }, 404);
  const role = (target as { role: AuthedUser["role"] }).role;
  if (role === "admin") {
    return c.json({ error: "admins already have every feature" }, 400);
  }

  const { error } = await sb.from("user_features").upsert(
    {
      user_id: id,
      feature: parsed.data.feature,
      allowed: parsed.data.allowed,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,feature" },
  );
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ id, features: await readEffectiveFeatures(sb, id, role) });
});

// Reset a user back to their role's default features (clears all overrides).
adminRoutes.delete("/users/:id/features", async (c) => {
  const id = c.req.param("id");
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data: target, error: tErr } = await sb
    .from("users")
    .select("id, role")
    .eq("id", id)
    .maybeSingle();
  if (tErr) return c.json({ error: tErr.message }, 500);
  if (!target) return c.json({ error: "not found" }, 404);
  const role = (target as { role: AuthedUser["role"] }).role;
  const { error } = await sb.from("user_features").delete().eq("user_id", id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ id, features: computeFeatures(role, []) });
});

adminRoutes.get("/domains", async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("approved_domains")
    .select("domain")
    .order("domain", { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({
    domains: ((data ?? []) as { domain: string }[]).map((d) => d.domain),
  });
});

const DomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "must be a bare domain like example.com"),
});

adminRoutes.post("/domains", async (c) => {
  const parsed = DomainSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const { error } = await sb
    .from("approved_domains")
    .upsert({ domain: parsed.data.domain });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true, domain: parsed.data.domain });
});

adminRoutes.delete("/domains/:domain", async (c) => {
  const domain = c.req.param("domain").toLowerCase();
  const sb = userSupabase(c.env, c.get("jwt"));
  const { error } = await sb
    .from("approved_domains")
    .delete()
    .eq("domain", domain);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});
