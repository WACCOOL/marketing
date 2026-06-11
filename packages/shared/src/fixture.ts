import type { FixtureMount } from "./types.js";

/**
 * Shared fixture metadata helpers (Scalable Fixture Pipeline, Phase 1).
 *
 * `deriveFixtureKind` infers a fixture's mount surface + a human-readable type
 * from its Sales Layer category/name. It used to live in the web app only;
 * moving it here lets the generator's registry-backed resolver and the API's
 * fixtures picker derive the same kind from the products catalog. Keyword-based
 * and best-effort — the user (or a per-SKU override) can always correct it.
 *
 * `POSE_DEFAULTS` / `COVERAGE_DEFAULTS` are mount-based camera presets so any
 * mirrored fixture has a sensible starting pose without hand-authoring
 * thousands of entries (seeded from the original 2-SKU FIXTURE_MAP).
 */
export interface FixtureKind {
  mount: FixtureMount;
  fixtureType: string;
}

interface Rule {
  match: RegExp;
  mount: FixtureMount;
  type: string;
}

// Ordered most-specific first; the first match wins.
const RULES: Rule[] = [
  { match: /ceiling fan|\bfan\b/, mount: "ceiling", type: "ceiling fan" },
  { match: /chandelier/, mount: "ceiling", type: "chandelier" },
  { match: /linear|island|billiard/, mount: "ceiling", type: "linear pendant" },
  { match: /pendant/, mount: "ceiling", type: "pendant light" },
  { match: /flush|semi.?flush/, mount: "ceiling", type: "flush mount light" },
  { match: /recess|downlight|down light|can light/, mount: "recessed", type: "recessed downlight" },
  { match: /track|monorail/, mount: "ceiling", type: "track light" },
  { match: /vanity|bath bar/, mount: "wall", type: "vanity light" },
  { match: /sconce/, mount: "wall", type: "wall sconce" },
  { match: /under.?cabinet|tape|strip|cove/, mount: "wall", type: "under-cabinet light" },
  { match: /wall/, mount: "wall", type: "wall light" },
  { match: /landscape|path|bollard|in.?grade|step|deck|outdoor/, mount: "floor", type: "landscape light" },
  { match: /floor lamp/, mount: "floor", type: "floor lamp" },
  { match: /table lamp|desk lamp/, mount: "floor", type: "table lamp" },
];

export function deriveFixtureKind(
  category?: string | null,
  name?: string | null,
): FixtureKind {
  const text = `${category ?? ""} ${name ?? ""}`.toLowerCase();
  for (const rule of RULES) {
    if (rule.match.test(text)) {
      return { mount: rule.mount, fixtureType: rule.type };
    }
  }
  // Default: most WAC product imagery is ceiling-mounted lighting.
  return { mount: "ceiling", fixtureType: "light fixture" };
}

export const MOUNT_LABELS: Record<FixtureMount, string> = {
  ceiling: "Ceiling",
  wall: "Wall",
  floor: "Floor",
  recessed: "Recessed (ceiling)",
};

/**
 * A starting orbit-camera pose for a fixture, by mount. A ceiling fixture is
 * shot from BELOW (look up into it), a wall fixture roughly head-on, a floor
 * fixture from slightly above. These feed the 3D app-shot's default pose so any
 * mirrored SKU renders believably before the user fine-tunes it.
 */
export interface PosePreset {
  azimuthDeg: number;
  elevationDeg: number;
  fovDeg: number;
}

export const POSE_DEFAULTS: Record<FixtureMount, PosePreset> = {
  // Seeded from the original chandelier entry: look up into the fixture.
  ceiling: { azimuthDeg: 0, elevationDeg: -18, fovDeg: 36 },
  // Recessed reads flatter and wider than a hanging ceiling piece.
  recessed: { azimuthDeg: 0, elevationDeg: -25, fovDeg: 40 },
  // Seeded from the original wall-sconce entry: near head-on, slight up-tilt.
  wall: { azimuthDeg: -8, elevationDeg: 2, fovDeg: 30 },
  // Floor / landscape pieces are seen from standing height, looking down a bit.
  floor: { azimuthDeg: 0, elevationDeg: 8, fovDeg: 32 },
};

/** Default fixture height as a fraction of the frame, by mount. */
export const COVERAGE_DEFAULTS: Record<FixtureMount, number> = {
  ceiling: 0.34,
  recessed: 0.34,
  wall: 0.34,
  floor: 0.34,
};

/**
 * Canonical R2/URL form of a fixture_key, shared by every producer and consumer
 * of the picker thumbnail cache (`appshot/thumb/{key}.png`). Lowercased and
 * stripped to `[a-z0-9_-]` so the key the API *writes* always equals the key the
 * web app *reads* and the bake CLI *uploads* — and so it's URL-safe with no
 * percent-encoding (the thumb-file route requires `^[a-z0-9_-]+$`).
 */
export function normalizeFixtureKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

/**
 * Catalog-lookup candidates for a fixture SKU, most specific first.
 *
 * Studio .blend stems are VARIANT-level SKUs with dash-joined suffix tokens the
 * catalog's base product rows often don't carry (finish codes like `-ab`/`-bk`,
 * variant codes like `-wv`): `bl248606-wv-ab` → also try `bl248606-wv`, then
 * `bl248606`. Without this, an exact-SKU miss silently falls through to
 * deriveFixtureKind's "ceiling" default — which is how a wall sconce ends up
 * rendered (and room-matched) as a ceiling fixture.
 */
export function skuLookupCandidates(sku: string): string[] {
  const out: string[] = [];
  let cur = sku.trim().toLowerCase();
  while (cur.length >= 4 && !out.includes(cur)) {
    out.push(cur);
    const cut = cur.lastIndexOf("-");
    if (cut <= 0) break;
    cur = cur.slice(0, cut);
  }
  return out.length ? out : [sku.trim().toLowerCase()];
}
