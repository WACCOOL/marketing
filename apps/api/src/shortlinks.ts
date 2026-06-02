import { generateSlug, isValidVanitySlug } from "@wac/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env.js";

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

export { KV_PREFIX as SHORT_LINK_KV_PREFIX };
