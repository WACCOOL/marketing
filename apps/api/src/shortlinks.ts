import {
  buildTaggedUrl,
  generateSlug,
  isValidVanitySlug,
  parseTaggedUrl,
  type UtmFields,
} from "@wac/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env.js";
import { autoTags } from "./assets.js";

const KV_PREFIX = "slug:";

export interface ShortLinkRow {
  id: string;
  slug: string;
  destination_url: string;
  owner_id: string;
  scan_count: number;
}

/**
 * Create a short link in Postgres and write-through to KV so the redirect
 * Worker's hot path is a single KV read.
 *
 * On vanity slug collision returns { conflict: true } instead of throwing —
 * the caller picks the UX (error vs. auto-fallback).
 */
export async function createShortLink(
  env: Env,
  sb: SupabaseClient,
  args: {
    destinationUrl: string;
    ownerId: string;
    vanitySlug?: string;
  },
): Promise<
  | { ok: true; row: ShortLinkRow }
  | { ok: false; conflict: true }
  | { ok: false; error: string }
> {
  if (args.vanitySlug && !isValidVanitySlug(args.vanitySlug)) {
    return { ok: false, error: "Invalid vanity slug" };
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = args.vanitySlug ?? generateSlug();
    const { data, error } = await sb
      .from("short_links")
      .insert({
        slug,
        destination_url: args.destinationUrl,
        owner_id: args.ownerId,
      })
      .select("id, slug, destination_url, owner_id, scan_count")
      .single();

    if (!error && data) {
      const row = data as ShortLinkRow;
      await env.SHORT_LINKS.put(KV_PREFIX + slug, args.destinationUrl);
      return { ok: true, row };
    }

    // 23505 = unique_violation. If a vanity slug clashes, surface as conflict.
    // For auto-generated slugs, retry with a fresh one.
    if (
      error &&
      ((error as { code?: string }).code === "23505" ||
        /duplicate key/i.test(error.message))
    ) {
      if (args.vanitySlug) return { ok: false, conflict: true };
      continue;
    }

    return { ok: false, error: error?.message ?? "Unknown error" };
  }

  return { ok: false, error: "Could not allocate slug after 5 attempts" };
}

/**
 * Update a short link's destination. The KV cache is updated in lockstep so
 * the printed QR keeps working AND immediately starts pointing at the new
 * destination on the next scan.
 */
export async function updateShortLinkDestination(
  env: Env,
  sb: SupabaseClient,
  args: { slug: string; destinationUrl: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await sb
    .from("short_links")
    .update({
      destination_url: args.destinationUrl,
      updated_at: new Date().toISOString(),
    })
    .eq("slug", args.slug)
    .select("slug")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "not found" };
  }
  await env.SHORT_LINKS.put(KV_PREFIX + args.slug, args.destinationUrl);
  return { ok: true };
}

export function shortLinkUrl(env: Env, slug: string): string {
  return `${env.SHORT_LINK_HOST.replace(/\/$/, "")}/${slug}`;
}

/**
 * Structured patch applied to a short link AND its linked QR asset (if any).
 *
 * - `destination` is the un-tagged base URL. `fields` is a partial UTM patch.
 *   Either or both may be supplied; the tagged URL is rebuilt from the existing
 *   tagged URL with the patch overlaid, so a caller can change just one of
 *   campaign/source/medium/content without resending the others.
 * - `name`/`project` are pushed onto the linked qr asset and into its tags +
 *   metadata. `project: null` clears it.
 * - The QR image is intentionally NOT re-rendered: it encodes the short URL,
 *   which never changes here.
 */
export interface ShortLinkPatch {
  name?: string;
  project?: string | null;
  destination?: string;
  fields?: {
    source?: string;
    medium?: string;
    campaign?: string;
    content?: string | null;
  };
}

export async function applyShortLinkPatch(
  env: Env,
  sb: SupabaseClient,
  slug: string,
  patch: ShortLinkPatch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: linkRow, error: linkErr } = await sb
    .from("short_links")
    .select("destination_url")
    .eq("slug", slug)
    .maybeSingle();
  if (linkErr) return { ok: false, error: linkErr.message };
  if (!linkRow) return { ok: false, error: "short link not found" };

  const current = (linkRow as { destination_url: string }).destination_url;
  const parsed = parseTaggedUrl(current);

  const baseDestination =
    patch.destination !== undefined ? patch.destination : parsed.destination;

  // For partial UTM edits we layer the patch on top of what's already on the
  // URL. content === null is an explicit clear; undefined means "no change".
  const patchedContent =
    patch.fields && "content" in patch.fields
      ? patch.fields.content === null
        ? undefined
        : patch.fields.content
      : parsed.content;
  const newFields: UtmFields = {
    source: patch.fields?.source ?? parsed.source ?? "",
    medium: patch.fields?.medium ?? parsed.medium ?? "",
    campaign: patch.fields?.campaign ?? parsed.campaign ?? "",
    content: patchedContent,
  };

  let newTaggedUrl: string;
  try {
    newTaggedUrl = buildTaggedUrl(baseDestination, newFields);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const urlChanged = newTaggedUrl !== current;
  if (urlChanged) {
    const upd = await updateShortLinkDestination(env, sb, {
      slug,
      destinationUrl: newTaggedUrl,
    });
    if (!upd.ok) return upd;
  }

  // Touch updated_at even if just name/project changed so the view reflects it.
  if (!urlChanged && (patch.name !== undefined || patch.project !== undefined)) {
    await sb
      .from("short_links")
      .update({ updated_at: new Date().toISOString() })
      .eq("slug", slug);
  }

  // Find the qr asset linked by metadata_json->>slug. RLS scopes this to the
  // caller automatically.
  const { data: assetRows, error: assetErr } = await sb
    .from("assets")
    .select("id, name, tags, metadata_json")
    .eq("tool", "qr")
    .filter("metadata_json->>slug", "eq", slug)
    .limit(1);
  if (assetErr) return { ok: false, error: assetErr.message };
  const asset = (assetRows ?? [])[0] as
    | {
        id: string;
        name: string;
        tags: string[];
        metadata_json: Record<string, unknown>;
      }
    | undefined;

  if (asset) {
    const meta = { ...(asset.metadata_json ?? {}) } as Record<string, unknown>;
    let nextProject: string | undefined;
    if (patch.project === null) {
      delete meta.project;
      nextProject = undefined;
    } else if (typeof patch.project === "string") {
      meta.project = patch.project;
      nextProject = patch.project;
    } else {
      nextProject =
        typeof meta.project === "string" ? meta.project : undefined;
    }
    meta.destination = baseDestination;
    meta.taggedUrl = newTaggedUrl;
    meta.fields = newFields;

    const newTags = autoTags({
      tool: "qr",
      campaign: newFields.campaign,
      source: newFields.source,
      medium: newFields.medium,
      content: newFields.content,
      project: nextProject,
      // Preserve any non-derived tags (e.g. brand, batch:bulk).
      extra: (asset.tags ?? []).filter(
        (t) =>
          !t.startsWith("tool:") &&
          !t.startsWith("campaign:") &&
          !t.startsWith("source:") &&
          !t.startsWith("medium:") &&
          !t.startsWith("content:") &&
          !t.startsWith("project:"),
      ),
    });

    const updates: Record<string, unknown> = {
      tags: newTags,
      metadata_json: meta,
    };
    if (patch.name !== undefined) updates.name = patch.name;

    const { error: updErr } = await sb
      .from("assets")
      .update(updates)
      .eq("id", asset.id);
    if (updErr) return { ok: false, error: updErr.message };

    // Keep the saved `url` artifact in lockstep with the tagged URL so anyone
    // downloading the asset gets the up-to-date target.
    if (urlChanged) {
      const urlKey = `assets/${asset.id}/url`;
      await env.ASSETS_BUCKET.put(urlKey, newTaggedUrl, {
        httpMetadata: { contentType: "text/plain" },
      });
      await sb
        .from("asset_files")
        .update({ bytes: newTaggedUrl.length })
        .eq("asset_id", asset.id)
        .eq("format", "url");
    }
  }

  return { ok: true };
}

/**
 * Delete a short link and its linked QR asset (R2 files + asset_files rows
 * cascade with the assets row delete; KV key is cleaned up explicitly).
 */
export async function deleteShortLinkAndAsset(
  env: Env,
  sb: SupabaseClient,
  slug: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: assetRows, error: assetErr } = await sb
    .from("assets")
    .select("id, asset_files(format, r2_key)")
    .eq("tool", "qr")
    .filter("metadata_json->>slug", "eq", slug);
  if (assetErr) return { ok: false, error: assetErr.message };

  const { error: linkErr } = await sb
    .from("short_links")
    .delete()
    .eq("slug", slug);
  if (linkErr) return { ok: false, error: linkErr.message };

  await env.SHORT_LINKS.delete(KV_PREFIX + slug);

  for (const row of assetRows ?? []) {
    const a = row as {
      id: string;
      asset_files: { format: string; r2_key: string }[] | null;
    };
    for (const f of a.asset_files ?? []) {
      try {
        await env.ASSETS_BUCKET.delete(f.r2_key);
      } catch {
        // best-effort; row deletion proceeds even if R2 already pruned
      }
    }
    const { error: delErr } = await sb.from("assets").delete().eq("id", a.id);
    if (delErr) return { ok: false, error: delErr.message };
  }

  return { ok: true };
}

export { KV_PREFIX as SHORT_LINK_KV_PREFIX };
