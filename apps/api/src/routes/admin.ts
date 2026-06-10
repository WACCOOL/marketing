import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { serviceSupabase, userSupabase } from "../supabase.js";

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
  return c.json({ users: data ?? [] });
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
  return c.json({ user: profile, invited });
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
  return c.json({ user: data });
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
