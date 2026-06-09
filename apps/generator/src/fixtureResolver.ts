import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COVERAGE_DEFAULTS,
  POSE_DEFAULTS,
  deriveFixtureKind,
  type FixtureMount,
} from "@wac/shared";
import type { FixtureMeta, FixtureResolver, Mount } from "./appshot3d.js";

/**
 * Registry-backed fixture resolver (Scalable Fixture Pipeline, Phase 1).
 *
 * Replaces the hardcoded FIXTURE_MAP: reads the SKU's `.blend` location from the
 * Supabase `fixtures` registry, presigns it from R2 as a `modelUrl` the worker
 * downloads, and derives the fixture's mount/type (from the products catalog via
 * deriveFixtureKind) and pose/coverage (from mount presets), unless the registry
 * row carries an explicit override. Any mirrored SKU becomes renderable.
 *
 * IES photometry is intentionally not wired in Phase 1 — decorative fixtures
 * render with their own lamps, exactly as the prior chandelier entry did. (When
 * the Sales Layer products record exposes an IES URL, it gets read here.)
 */

// The worker downloads the .blend at the start of a render (within seconds of
// the request), so an hour of validity is ample even for a long final render.
const PRESIGN_TTL_SECONDS = 3600;

interface FixtureRow {
  fixture_key: string;
  sku: string;
  model_key: string;
  mount: string | null;
  fixture_type: string | null;
  pose: FixtureMeta["pose"] | null;
  coverage: number | null;
}

interface ProductRow {
  sku: string;
  name: string | null;
  category: string | null;
}

/** Escape LIKE/ILIKE wildcards so a SKU is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Best-effort catalog lookup for a fixture SKU. Fixture filenames are often
 * variant SKUs, so try the product SKU first, then fall back to a match against
 * the space-joined variant SKUs (`variant_search`). Returns null when nothing
 * matches — the resolver then uses default mount/type so the fixture still
 * renders.
 */
async function findProduct(
  sb: SupabaseClient,
  sku: string,
): Promise<ProductRow | null> {
  const pattern = escapeLike(sku);
  const direct = await sb
    .from("products")
    .select("sku, name, category")
    .ilike("sku", pattern)
    .maybeSingle();
  if (direct.data) return direct.data as ProductRow;

  const variant = await sb
    .from("products")
    .select("sku, name, category")
    .ilike("variant_search", `%${pattern}%`)
    .limit(1)
    .maybeSingle();
  return (variant.data as ProductRow | null) ?? null;
}

export function makeFixtureResolver(deps: {
  sb: SupabaseClient;
  s3: S3Client;
  bucket: string;
}): FixtureResolver {
  // `rawKey` is the opaque fixture identifier the picker selected (a
  // `fixture_key`: the SKU, or `{sku}_scn{NNN}` for a scene option).
  return async (rawKey: string): Promise<FixtureMeta> => {
    const fixtureKey = rawKey.trim().toLowerCase();

    const { data, error } = await deps.sb
      .from("fixtures")
      .select("fixture_key, sku, model_key, mount, fixture_type, pose, coverage")
      .eq("fixture_key", fixtureKey)
      .maybeSingle();
    if (error) {
      throw new Error(`fixture lookup failed for "${rawKey}": ${error.message}`);
    }
    if (!data) {
      throw new Error(
        `no 3D model for fixture "${rawKey}" (not in the fixtures registry)`,
      );
    }
    const row = data as FixtureRow;

    const product = await findProduct(deps.sb, row.sku);
    const derived = deriveFixtureKind(product?.category, product?.name);
    const mount = (row.mount as Mount | null) ?? derived.mount;
    const fixtureType = row.fixture_type ?? derived.fixtureType;

    const preset = POSE_DEFAULTS[mount as FixtureMount];
    const pose =
      row.pose ?? {
        azimuthDeg: preset.azimuthDeg,
        elevationDeg: preset.elevationDeg,
        fovDeg: preset.fovDeg,
      };
    const coverage = row.coverage ?? COVERAGE_DEFAULTS[mount as FixtureMount];

    const modelUrl = await getSignedUrl(
      deps.s3,
      new GetObjectCommand({ Bucket: deps.bucket, Key: row.model_key }),
      { expiresIn: PRESIGN_TTL_SECONDS },
    );

    return {
      sku: row.sku,
      modelUrl,
      fixtureType,
      mount,
      pose,
      coverage,
    };
  };
}
