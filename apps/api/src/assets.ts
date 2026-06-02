import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env.js";

export type AssetTool = "utm" | "qr" | "appimage" | "ppt" | "layout";
export type AssetVisibility = "internal" | "private";

export interface CreateAssetArgs {
  ownerId: string;
  tool: AssetTool;
  name: string;
  visibility?: AssetVisibility;
  tags?: string[];
  metadata?: Record<string, unknown>;
  parentAssetId?: string;
}

export interface AssetFileSpec {
  format: "svg" | "png" | "url" | "txt" | "xlsx" | "csv";
  /** R2 object body OR a literal string (e.g. for "url" assets). */
  body: Uint8Array | string;
  contentType?: string;
}

/**
 * Create an asset row + upload one or more representations to R2.
 * Returns the asset id and the R2 keys.
 */
export async function createAsset(
  env: Env,
  sb: SupabaseClient,
  args: CreateAssetArgs,
  files: AssetFileSpec[],
): Promise<{ assetId: string; files: { format: string; key: string }[] }> {
  const { data: asset, error: assetErr } = await sb
    .from("assets")
    .insert({
      owner_id: args.ownerId,
      tool: args.tool,
      name: args.name,
      org_visibility: args.visibility ?? "internal",
      tags: args.tags ?? [],
      metadata_json: args.metadata ?? {},
      parent_asset_id: args.parentAssetId ?? null,
    })
    .select("id")
    .single();
  if (assetErr || !asset) {
    throw new Error(`assets insert failed: ${assetErr?.message}`);
  }
  const assetId = (asset as { id: string }).id;

  const uploaded: { format: string; key: string }[] = [];
  for (const file of files) {
    const key = `assets/${assetId}/${file.format}`;
    if (typeof file.body === "string" && file.format === "url") {
      // Store URL-style "files" as a tiny text object so they're listable.
      await env.ASSETS_BUCKET.put(key, file.body, {
        httpMetadata: { contentType: "text/plain" },
      });
    } else {
      await env.ASSETS_BUCKET.put(key, file.body, {
        httpMetadata: file.contentType
          ? { contentType: file.contentType }
          : undefined,
      });
    }

    const { error: fileErr } = await sb.from("asset_files").insert({
      asset_id: assetId,
      format: file.format,
      r2_key: key,
      bytes: typeof file.body === "string" ? file.body.length : file.body.byteLength,
    });
    if (fileErr) {
      throw new Error(`asset_files insert failed: ${fileErr.message}`);
    }
    uploaded.push({ format: file.format, key });
  }

  return { assetId, files: uploaded };
}

/** Build a tag set automatically from common inputs. */
export function autoTags(
  inputs: {
    tool: AssetTool;
    campaign?: string;
    source?: string;
    medium?: string;
    content?: string;
    brand?: string;
    project?: string;
    extra?: string[];
  },
): string[] {
  const out = new Set<string>();
  out.add(`tool:${inputs.tool}`);
  if (inputs.campaign) out.add(`campaign:${inputs.campaign}`);
  if (inputs.source) out.add(`source:${inputs.source}`);
  if (inputs.medium) out.add(`medium:${inputs.medium}`);
  if (inputs.content) out.add(`content:${inputs.content}`);
  if (inputs.brand) out.add(`brand:${inputs.brand}`);
  if (inputs.project) out.add(`project:${inputs.project}`);
  for (const e of inputs.extra ?? []) out.add(e);
  return [...out];
}
