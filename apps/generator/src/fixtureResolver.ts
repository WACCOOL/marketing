import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  COVERAGE_DEFAULTS,
  POSE_DEFAULTS,
  deriveFixtureKind,
  skuLookupCandidates,
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
 * IES photometry comes from the Sales Layer products record (PIM): the daily
 * sync extracts each product's `.ies` URL into `products.ies_url`, and we read
 * it here so the worker downloads it and Blender's add_ies_light throws the
 * fixture's true distribution into the room. Fixtures without an IES fall back to
 * their own lamps + a synthetic fill (handled in composite.py).
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
  ies_url: string | null;
}

/** Escape LIKE/ILIKE wildcards so a SKU is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Separator-stripped uppercase form for catalog-vs-stem SKU comparison. */
function normSku(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Best-effort catalog lookup for a fixture SKU.
 *
 * Fixture .blend stems are variant-level SKUs whose separators don't match the
 * catalog's (a variant filed as `BL248606-WV/AB` becomes the stem
 * `bl248606-wv-ab`), and they carry finish/variant suffixes the base product
 * row lacks. So: try the product SKU directly at every `skuLookupCandidates`
 * truncation, then fetch the SKU family by its alphanumeric stem and match
 * `variant_search` tokens separator-insensitively (mirrors the API picker's
 * resolveProducts). Returns null when nothing matches — the resolver then uses
 * default mount/type so the fixture still renders, but a miss here is what
 * turns a wall sconce into a "ceiling" fixture, so match aggressively.
 */
async function findProduct(
  sb: SupabaseClient,
  sku: string,
): Promise<ProductRow | null> {
  const candidates = skuLookupCandidates(sku);
  for (const candidate of candidates) {
    const direct = await sb
      .from("products")
      .select("sku, name, category, ies_url")
      .ilike("sku", escapeLike(candidate))
      .limit(1)
      .maybeSingle();
    if (direct.data) return direct.data as ProductRow;
  }

  // Variant fallback: the leading alphanumeric run (e.g. `bl248606`) has no
  // separators, so it survives the catalog's `/` vs the stem's `-`.
  const stem = sku.match(/^[a-z0-9]+/i)?.[0] ?? sku;
  const { data } = await sb
    .from("products")
    .select("sku, name, category, ies_url, variant_search")
    .ilike("variant_search", `%${escapeLike(stem)}%`)
    .limit(20);
  const rows = (data ?? []) as Array<ProductRow & { variant_search?: string | null }>;
  if (rows.length === 0) return null;
  for (const target of candidates.map(normSku)) {
    for (const row of rows) {
      const tokens = (row.variant_search ?? "").split(/\s+/).map(normSku);
      if (tokens.includes(target)) return row;
    }
  }
  // Same numeric family — close enough for mount/type derivation.
  return rows[0] ?? null;
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
      // Manufacturer photometry when the catalog has it; absent → composite.py
      // uses the fixture's own lamps + a synthetic fill.
      iesUrl: product?.ies_url ?? undefined,
      fixtureType,
      mount,
      pose,
      coverage,
    };
  };
}
