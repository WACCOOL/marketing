import { Hono } from "hono";
import { z } from "zod";
import * as XLSX from "xlsx";
import { parseTaggedUrl } from "@wac/shared";
import type { AppBindings } from "../auth.js";
import { requireAuth } from "../auth.js";
import { userSupabase } from "../supabase.js";
import {
  applyShortLinkPatch,
  createShortLink,
  deleteShortLinkAndAsset,
  shortLinkUrl,
  type ShortLinkPatch,
} from "../shortlinks.js";

export const shortLinkRoutes = new Hono<AppBindings>();

const CreateSchema = z.object({
  destinationUrl: z.string().url(),
  vanitySlug: z.string().optional(),
});

shortLinkRoutes.post("/", requireAuth, async (c) => {
  const parsed = CreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const result = await createShortLink(c.env, sb, {
    destinationUrl: parsed.data.destinationUrl,
    ownerId: c.get("user").id,
    vanitySlug: parsed.data.vanitySlug,
  });
  if (!result.ok) {
    if ("conflict" in result) {
      return c.json({ error: "vanity slug already taken" }, 409);
    }
    return c.json({ error: result.error }, 500);
  }
  return c.json({
    ...result.row,
    shortUrl: shortLinkUrl(c.env, result.row.slug),
  });
});

// Structured patch: any subset of name/project/destination/fields.
// Kept lenient on UTM tokens here — final validation lives in `buildTaggedUrl`
// inside `applyShortLinkPatch` so we get one consistent error path.
const PatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    project: z.string().nullable().optional(),
    destination: z.string().url().optional(),
    fields: z
      .object({
        source: z.string().min(1).optional(),
        medium: z.string().min(1).optional(),
        campaign: z.string().min(1).optional(),
        content: z.string().min(1).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

shortLinkRoutes.patch("/:slug", requireAuth, async (c) => {
  const slug = c.req.param("slug");
  const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const result = await applyShortLinkPatch(
    c.env,
    sb,
    slug,
    parsed.data as ShortLinkPatch,
  );
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

const BulkPatchSchema = z.object({
  slugs: z.array(z.string().min(1)).min(1).max(500),
  patch: PatchSchema,
});

shortLinkRoutes.post("/bulk", requireAuth, async (c) => {
  const parsed = BulkPatchSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const results: { slug: string; ok: boolean; error?: string }[] = [];
  for (const slug of parsed.data.slugs) {
    const r = await applyShortLinkPatch(
      c.env,
      sb,
      slug,
      parsed.data.patch as ShortLinkPatch,
    );
    if (r.ok) results.push({ slug, ok: true });
    else results.push({ slug, ok: false, error: r.error });
  }
  return c.json({
    okCount: results.filter((r) => r.ok).length,
    errorCount: results.filter((r) => !r.ok).length,
    results,
  });
});

shortLinkRoutes.delete("/:slug", requireAuth, async (c) => {
  const slug = c.req.param("slug");
  const sb = userSupabase(c.env, c.get("jwt"));
  const r = await deleteShortLinkAndAsset(c.env, sb, slug);
  if (!r.ok) return c.json({ error: r.error }, 400);
  return c.json({ ok: true });
});

const BulkDeleteSchema = z.object({
  slugs: z.array(z.string().min(1)).min(1).max(500),
});

shortLinkRoutes.post("/bulk-delete", requireAuth, async (c) => {
  const parsed = BulkDeleteSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));
  const results: { slug: string; ok: boolean; error?: string }[] = [];
  for (const slug of parsed.data.slugs) {
    const r = await deleteShortLinkAndAsset(c.env, sb, slug);
    if (r.ok) results.push({ slug, ok: true });
    else results.push({ slug, ok: false, error: r.error });
  }
  return c.json({
    okCount: results.filter((r) => r.ok).length,
    errorCount: results.filter((r) => !r.ok).length,
    results,
  });
});

const ExportSchema = z.object({
  slugs: z.array(z.string().min(1)).min(1).max(500),
});

// Single .xlsx with one row per selected link, fully resolved columns.
shortLinkRoutes.post("/export-xlsx", requireAuth, async (c) => {
  const parsed = ExportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid input", issues: parsed.error.issues }, 400);
  }
  const sb = userSupabase(c.env, c.get("jwt"));

  const { data: linkRows, error: linkErr } = await sb
    .from("short_links")
    .select("slug, destination_url, scan_count, created_at, updated_at")
    .in("slug", parsed.data.slugs);
  if (linkErr) return c.json({ error: linkErr.message }, 500);

  const nameProject = await fetchAssetNameProjectBySlug(sb, parsed.data.slugs);
  if (!nameProject.ok) return c.json({ error: nameProject.error }, 500);

  const rows = (linkRows ?? []).map((r) => {
    const row = r as {
      slug: string;
      destination_url: string;
      scan_count: number;
      created_at: string;
      updated_at: string;
    };
    const parsedUrl = parseTaggedUrl(row.destination_url);
    const np = nameProject.bySlug.get(row.slug);
    return {
      Name: np?.name ?? "",
      Project: np?.project ?? "",
      "Destination URL": parsedUrl.destination,
      Campaign: parsedUrl.campaign ?? "",
      Source: parsedUrl.source ?? "",
      Medium: parsedUrl.medium ?? "",
      Content: parsedUrl.content ?? "",
      Slug: row.slug,
      "Short URL": shortLinkUrl(c.env, row.slug),
      "Tagged URL": row.destination_url,
      Scans: row.scan_count,
    };
  });

  const headers = [
    "Name",
    "Project",
    "Destination URL",
    "Campaign",
    "Source",
    "Medium",
    "Content",
    "Slug",
    "Short URL",
    "Tagged URL",
    "Scans",
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  XLSX.utils.book_append_sheet(wb, ws, "UTM & QR");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

  return new Response(buf, {
    status: 200,
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="utm-qr-${Date.now()}.xlsx"`,
    },
  });
});

shortLinkRoutes.get("/", requireAuth, async (c) => {
  const sb = userSupabase(c.env, c.get("jwt"));
  const { data, error } = await sb
    .from("short_links")
    .select(
      "id, slug, destination_url, owner_id, scan_count, created_at, updated_at",
    )
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return c.json({ error: error.message }, 500);

  const rows = (data ?? []) as Array<{
    id: string;
    slug: string;
    destination_url: string;
    owner_id: string;
    scan_count: number;
    created_at: string;
    updated_at: string;
  }>;
  const slugs = rows.map((r) => r.slug);

  // Fan out to the linked qr assets (joined by metadata_json->>slug). RLS keeps
  // this scoped to the caller. We hydrate each row with the asset's name,
  // project, asset id, and the formats available so the UI can render the
  // thumbnail + per-format download links without a second round-trip.
  type AssetEntry = {
    assetId: string | null;
    name: string | null;
    project: string | null;
    formats: string[];
  };
  const assetBySlug = new Map<string, AssetEntry>();
  if (slugs.length > 0) {
    const { data: assetRows, error: aErr } = await sb
      .from("assets")
      .select("id, name, tags, metadata_json, asset_files(format)")
      .eq("tool", "qr")
      .in("metadata_json->>slug", slugs);
    if (aErr) return c.json({ error: aErr.message }, 500);

    for (const a of (assetRows ?? []) as Array<{
      id: string;
      name: string;
      tags: string[] | null;
      metadata_json: Record<string, unknown> | null;
      asset_files: { format: string }[] | null;
    }>) {
      const meta = (a.metadata_json ?? {}) as Record<string, unknown>;
      const slug = typeof meta.slug === "string" ? meta.slug : null;
      if (!slug) continue;
      let project: string | null =
        typeof meta.project === "string" ? meta.project : null;
      if (!project) {
        const projectTag = (a.tags ?? []).find((t) => t.startsWith("project:"));
        if (projectTag) project = projectTag.slice("project:".length);
      }
      assetBySlug.set(slug, {
        assetId: a.id,
        name: a.name,
        project,
        formats: (a.asset_files ?? []).map((f) => f.format),
      });
    }
  }

  return c.json({
    shortLinks: rows.map((r) => {
      const asset = assetBySlug.get(r.slug);
      return {
        ...r,
        shortUrl: shortLinkUrl(c.env, r.slug),
        assetId: asset?.assetId ?? null,
        name: asset?.name ?? null,
        project: asset?.project ?? null,
        formats: asset?.formats ?? [],
      };
    }),
  });
});

/** Resolve name + project for a set of slugs via their linked qr assets. */
async function fetchAssetNameProjectBySlug(
  sb: ReturnType<typeof userSupabase>,
  slugs: string[],
): Promise<
  | {
      ok: true;
      bySlug: Map<string, { name: string | null; project: string | null }>;
    }
  | { ok: false; error: string }
> {
  const bySlug = new Map<
    string,
    { name: string | null; project: string | null }
  >();
  if (slugs.length === 0) return { ok: true, bySlug };
  const { data, error } = await sb
    .from("assets")
    .select("name, tags, metadata_json")
    .eq("tool", "qr")
    .in("metadata_json->>slug", slugs);
  if (error) return { ok: false, error: error.message };
  for (const a of (data ?? []) as Array<{
    name: string;
    tags: string[] | null;
    metadata_json: Record<string, unknown> | null;
  }>) {
    const meta = (a.metadata_json ?? {}) as Record<string, unknown>;
    const slug = typeof meta.slug === "string" ? meta.slug : null;
    if (!slug) continue;
    let project: string | null =
      typeof meta.project === "string" ? meta.project : null;
    if (!project) {
      const projectTag = (a.tags ?? []).find((t) => t.startsWith("project:"));
      if (projectTag) project = projectTag.slice("project:".length);
    }
    bySlug.set(slug, { name: a.name ?? null, project });
  }
  return { ok: true, bySlug };
}
