import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AppBindings } from "../auth.js";
import { requireAuth, requireFeature } from "../auth.js";
import { serviceSupabase, userSupabase } from "../supabase.js";
import {
  MARKETING_SOURCE_SYSTEM,
  projectMarketingContent,
  type MarketingContentRow,
} from "../thom/contentProject.js";

/**
 * Marketing custom-content admin — the authoring CRUD behind the "Thom
 * Knowledge" page. Marketing writes curated overviews / positioning / FAQs;
 * each save is projected into the Thom RAG store (kb_documents + kb_chunks) so
 * it becomes a first-class retrieval source (search_docs, doc_type='marketing').
 *
 * Gated to internal/admin (requireFeature("thom-content") + an explicit role
 * guard, same posture as the Thom chat route). Reads go through the user client
 * (RLS); writes to marketing_content + the projected KB rows use the service
 * client (kb_documents/kb_chunks are service-role-write).
 */

export const thomContentRoutes = new Hono<AppBindings>();

/** Internal + admin only — reps are walled off from Thom's knowledge base. */
const requireInternal = createMiddleware<AppBindings>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "internal" && user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
});

thomContentRoutes.use("*", requireAuth, requireFeature("thom-content"), requireInternal);

// List: lightweight columns for the admin table (no body).
thomContentRoutes.get("/", async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("marketing_content")
    .select("id, title, brand, scope, doc_subtype, status, updated_at")
    .order("updated_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ items: data ?? [] });
});

// Full row incl. body for the editor.
thomContentRoutes.get("/:id", async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("marketing_content")
    .select("id, title, brand, scope, doc_subtype, body, status, updated_at")
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "not found" }, 404);
  return c.json({ item: data });
});

// scope is REQUIRED and explicit — 'public' must be a deliberate choice (it
// exposes the content to the anon public bubble), never a silent default.
const ContentSchema = z.object({
  title: z.string().trim().min(1).max(300),
  brand: z.string().trim().max(120).optional().nullable(),
  scope: z.enum(["public", "internal"]),
  doc_subtype: z.string().trim().max(60).optional().nullable(),
  body: z.string().min(1),
  status: z.enum(["draft", "published"]),
});

function nullify(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s ? s : null;
}

thomContentRoutes.post("/", async (c) => {
  const parsed = ContentSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const user = c.get("user");
  const admin = serviceSupabase(c.env);
  const { data, error } = await admin
    .from("marketing_content")
    .insert({
      title: parsed.data.title,
      brand: nullify(parsed.data.brand),
      scope: parsed.data.scope,
      doc_subtype: nullify(parsed.data.doc_subtype),
      body: parsed.data.body,
      status: parsed.data.status,
      updated_by: user.id,
    })
    .select("id, title, brand, scope, body, status")
    .single();
  if (error || !data) {
    return c.json({ error: error?.message ?? "insert failed" }, 500);
  }
  await project(c.env, admin, data as MarketingContentRow);
  return c.json({ id: data.id, ok: true });
});

thomContentRoutes.put("/:id", async (c) => {
  const parsed = ContentSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const user = c.get("user");
  const admin = serviceSupabase(c.env);
  const { data, error } = await admin
    .from("marketing_content")
    .update({
      title: parsed.data.title,
      brand: nullify(parsed.data.brand),
      scope: parsed.data.scope,
      doc_subtype: nullify(parsed.data.doc_subtype),
      body: parsed.data.body,
      status: parsed.data.status,
      updated_by: user.id,
    })
    .eq("id", c.req.param("id"))
    .select("id, title, brand, scope, body, status")
    .single();
  if (error || !data) {
    return c.json({ error: error?.message ?? "not found" }, error ? 500 : 404);
  }
  await project(c.env, admin, data as MarketingContentRow);
  return c.json({ id: data.id, ok: true });
});

// Delete: admin-only (RLS enforces it too). Removes the marketing_content row
// AND its projected kb_documents row — kb_chunks cascade from kb_documents.
thomContentRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "admin only" }, 403);
  const id = c.req.param("id");
  const admin = serviceSupabase(c.env);
  const { error } = await admin.from("marketing_content").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 500);
  const { error: kbErr } = await admin
    .from("kb_documents")
    .delete()
    .eq("source_system", MARKETING_SOURCE_SYSTEM)
    .eq("external_id", id);
  if (kbErr) console.warn(`[thom] kb_documents cleanup failed for ${id}: ${kbErr.message}`);
  return c.json({ ok: true });
});

/** Project a saved row into the KB; a projection failure must not fail the save
 *  (the row is written; the docs-ingest CLI backfills retrieval). */
async function project(
  env: AppBindings["Bindings"],
  admin: ReturnType<typeof serviceSupabase>,
  row: MarketingContentRow,
): Promise<void> {
  try {
    await projectMarketingContent(env, admin, row);
  } catch (e) {
    console.warn(
      `[thom] marketing content projection failed for ${row.id}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
