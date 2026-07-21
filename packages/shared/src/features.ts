/**
 * Per-user feature (menu-tab) access control.
 *
 * Access to the app's tabs is governed by a small catalog of FEATURES. A user's
 * ROLE sets the default set of features they get; an admin can then grant or
 * revoke individual features per-user as OVERRIDES on top of that default.
 * `admin` always has every feature (it bypasses the catalog entirely).
 *
 * This module is the single source of truth shared by the API (provisioning +
 * `requireFeature` enforcement) and the web app (sidebar + route guards).
 */

export type UserRole = "internal" | "rep" | "admin";

export interface FeatureDef {
  key: string;
  label: string;
}

/**
 * The controllable features. The first five are the top-level menu tabs; the
 * last four are pages that used to be admin-only and are now individually
 * grantable. The Admin page itself is intentionally NOT here — managing access
 * is inherently an admin-only function.
 */
export const FEATURES = [
  { key: "utm", label: "UTM & QR" },
  { key: "image", label: "Image Generation" },
  { key: "ppt", label: "PPT Generator" },
  { key: "product", label: "Product Info" },
  { key: "thom", label: "Thom Bot" },
  { key: "thom-content", label: "Thom Knowledge" },
  { key: "data", label: "Data" },
  { key: "utm-vocab", label: "Sources & Mediums" },
  { key: "ppt-templates", label: "PPT Templates" },
  { key: "pricing", label: "Pricing Upload" },
  { key: "library", label: "Asset Library" },
] as const satisfies readonly FeatureDef[];

export type FeatureKey = (typeof FEATURES)[number]["key"];

export const ALL_FEATURE_KEYS: FeatureKey[] = FEATURES.map((f) => f.key);

const FEATURE_KEY_SET = new Set<string>(ALL_FEATURE_KEYS);

/** Type guard: is this string one of the known feature keys? */
export function isFeatureKey(value: string): value is FeatureKey {
  return FEATURE_KEY_SET.has(value);
}

/**
 * Role-derived defaults. `admin` is omitted because it always gets everything.
 * A user with no per-user override inherits exactly this set, so changing a
 * default here re-bases every un-overridden user automatically.
 */
export const DEFAULT_FEATURES: Record<"rep" | "internal", FeatureKey[]> = {
  rep: ["image", "ppt"],
  // Thom is internal+admin only by decision: its CRM tools read HubSpot deals/
  // companies/orders, data reps are deliberately walled off from (no territory
  // scoping exists). Rep access is a future schema+RLS project, not a toggle.
  internal: ["utm", "image", "ppt", "product", "thom", "thom-content"],
};

/** One per-user override row (presence overrides the role default). */
export interface FeatureOverride {
  feature: string;
  allowed: boolean;
}

/**
 * Compute a user's effective feature set: admins get everything; everyone else
 * starts from their role default and then applies overrides (allowed=true adds,
 * allowed=false removes). Unknown roles get no features.
 */
export function computeFeatures(
  role: UserRole,
  overrides: FeatureOverride[] = [],
): FeatureKey[] {
  if (role === "admin") return [...ALL_FEATURE_KEYS];
  const set = new Set<FeatureKey>(DEFAULT_FEATURES[role] ?? []);
  for (const o of overrides) {
    if (!isFeatureKey(o.feature)) continue;
    if (o.allowed) set.add(o.feature);
    else set.delete(o.feature);
  }
  // Return in catalog order for stable output.
  return ALL_FEATURE_KEYS.filter((k) => set.has(k));
}

/** Whether a user (by role + effective features) may use a feature. */
export function hasFeature(
  user: { role: UserRole; features: string[] },
  key: FeatureKey,
): boolean {
  return user.role === "admin" || user.features.includes(key);
}

/**
 * Maps an app route to the feature that gates it. Routes not listed here are
 * unrestricted (any active user can reach them). Used by the web route guards.
 */
export const ROUTE_FEATURE: Record<string, FeatureKey> = {
  "/builder": "utm",
  "/social": "utm",
  "/bulk": "utm",
  "/utm-qr": "utm",
  "/utm-vocab": "utm-vocab",
  "/app-image": "image",
  "/app-shot": "image",
  "/cam-solve": "image",
  "/render-queue": "image",
  "/final-images": "image",
  "/ppt/builder": "ppt",
  "/ppt/decks": "ppt",
  "/ppt/images": "ppt",
  "/ppt/templates": "ppt-templates",
  "/products": "product",
  "/thom": "thom",
  "/thom-content": "thom-content",
  "/thom-dictionary": "thom-content",
  "/product-info/romance": "product",
  "/product-info/seo": "product",
  "/product-info/normalization": "product",
  "/data/ingestions": "data",
  "/data/hubspot": "data",
  "/data/pricing": "pricing",
  "/library": "library",
};

/** The feature gating a route, or null if the route is unrestricted. */
export function featureForPath(pathname: string): FeatureKey | null {
  return ROUTE_FEATURE[pathname] ?? null;
}

/** The primary landing route for each feature (where its tab opens). */
export const FEATURE_LANDING: Record<FeatureKey, string> = {
  utm: "/builder",
  image: "/app-image",
  ppt: "/ppt/builder",
  product: "/products",
  thom: "/thom",
  "thom-content": "/thom-content",
  data: "/data/ingestions",
  "utm-vocab": "/utm-vocab",
  "ppt-templates": "/ppt/templates",
  pricing: "/data/pricing",
  library: "/library",
};

/** Priority order for picking a user's home/fallback landing page. */
const LANDING_ORDER: FeatureKey[] = [
  "utm",
  "image",
  "ppt",
  "product",
  "thom",
  "thom-content",
  "data",
  "library",
  "utm-vocab",
  "ppt-templates",
  "pricing",
];

/**
 * The route to send a user to as their home / when they're redirected off a
 * page they can't access. Admins land on the UTM builder (unchanged); everyone
 * else lands on the first feature they actually have. Returns null only when a
 * non-admin has zero features (the caller should show a "no access" state).
 */
export function firstAccessiblePath(
  features: string[],
  isAdmin: boolean,
): string | null {
  if (isAdmin) return "/builder";
  for (const key of LANDING_ORDER) {
    if (features.includes(key)) return FEATURE_LANDING[key];
  }
  return null;
}
