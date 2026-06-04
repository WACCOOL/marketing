import { z } from "zod";

export const UtmVocabTypeSchema = z.enum(["source", "medium", "content"]);
export type UtmVocabType = z.infer<typeof UtmVocabTypeSchema>;

export const UtmVocabEntrySchema = z.object({
  id: z.string().uuid(),
  type: UtmVocabTypeSchema,
  value: z.string().min(1),
});
export type UtmVocabEntry = z.infer<typeof UtmVocabEntrySchema>;

export const HubspotCampaignSchema = z.object({
  hubspot_id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
});
export type HubspotCampaign = z.infer<typeof HubspotCampaignSchema>;

/**
 * The encoded value stored in utm_campaign. Per the PRD this is the HubSpot
 * id and slug joined with an underscore, e.g. "39174698_hd_expo_2026".
 */
export function encodeCampaignValue(c: HubspotCampaign): string {
  return `${c.hubspot_id}_${c.slug}`;
}

export const AssetVisibilitySchema = z.enum(["internal", "private"]);
export type AssetVisibility = z.infer<typeof AssetVisibilitySchema>;

export const ToolSchema = z.enum(["utm", "qr", "appimage", "ppt", "layout"]);
export type Tool = z.infer<typeof ToolSchema>;

/**
 * The tools that run through the async generation pipeline (Phase 2b). Derived
 * from ToolSchema so it can't drift — utm/qr are synchronous and excluded. For
 * 2b only `appimage` is exercised; ppt/layout arrive in Phase 3.
 */
export const GenerationToolSchema = ToolSchema.extract([
  "appimage",
  "ppt",
  "layout",
]);
export type GenerationTool = z.infer<typeof GenerationToolSchema>;

export const GenerationJobRequestSchema = z.object({
  tool: GenerationToolSchema,
  name: z.string().min(1),
  params: z.record(z.unknown()).default({}),
  /**
   * Extra asset tags to apply on success, e.g. `sku:LED-TO24-CH5` and
   * `room:kitchen` (PRD: app images are tagged by product SKU + room type). The
   * generator merges these onto its base `tool:<tool>` tag.
   */
  tags: z.array(z.string().min(1)).default([]),
});
export type GenerationJobRequest = z.infer<typeof GenerationJobRequestSchema>;

export const GenerationJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);
export type GenerationJobStatus = z.infer<typeof GenerationJobStatusSchema>;

export const SocialChannels = [
  "youtube",
  "tiktok",
  "linkedin",
  "facebook",
  "instagram",
  "x",
] as const;
export type SocialChannel = (typeof SocialChannels)[number];

export const ShortLinkSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  destination_url: z.string().url(),
  owner_id: z.string().uuid(),
  scan_count: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ShortLink = z.infer<typeof ShortLinkSchema>;

/**
 * Physical fixture dimensions, always normalized to millimetres. Every field is
 * optional because Sales Layer products expose different measurements (a round
 * downlight has a diameter, a linear fixture has a length, etc.). The Phase 2
 * scale engine reads from this shape.
 */
export const DimensionsMmSchema = z.object({
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  depth: z.number().positive().optional(),
  diameter: z.number().positive().optional(),
  length: z.number().positive().optional(),
});
export type DimensionsMm = z.infer<typeof DimensionsMmSchema>;

/**
 * One orderable variant of a product (a specific finish / size / configuration).
 * Carries its own SKU, dimensions, and imagery. In WAC's Sales Layer the
 * orderable SKU (matnr) and most fixture dimensions live at this level.
 */
export const ProductVariantSchema = z.object({
  /** Sales Layer variant_id (e.g. "LED-TO24-CH5_G0_B"). */
  variant_id: z.string().min(1),
  /** Orderable SKU / material number (matnr), e.g. "LED-TO24-CH5". */
  sku: z.string().nullable().optional(),
  finish: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  dimensions_mm: DimensionsMmSchema.default({}),
  image_urls: z.array(z.string().url()).default([]),
});
export type ProductVariant = z.infer<typeof ProductVariantSchema>;

/**
 * A product row from the local Sales Layer cache (public.products). Mirrors the
 * DB columns. A product groups many variants; `image_urls` aggregates every
 * image (product + variant) so the user can access all of them. Images live on
 * the Sales Layer CDN — these are URLs, not R2 keys.
 */
export const ProductSchema = z.object({
  id: z.string().uuid(),
  sku: z.string().min(1),
  name: z.string().min(1),
  brand: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  dimensions_mm: DimensionsMmSchema.default({}),
  primary_image_url: z.string().url().nullable().optional(),
  image_urls: z.array(z.string().url()).default([]),
  variants: z.array(ProductVariantSchema).default([]),
  synced_at: z.string(),
});
export type Product = z.infer<typeof ProductSchema>;

// ---------------------------------------------------------------------------
// Application Image generation params (Phase 2c).
//
// This is the SINGLE canonical contract for the deterministic scale + compositing
// engine. The generator container imports these schemas directly (its Docker image
// is a pnpm-workspace build of this package), so there is no second copy to drift.
// The AI scene-generation and AI scale-inference steps are siblings that produce
// `sceneUrl` / `scale.pxPerMm` and feed this engine.
// ---------------------------------------------------------------------------

/**
 * Version tag for the App Image params contract. Stamped into the generated
 * asset's metadata_json and asserted by the generator, so a versioned contract
 * is unambiguous and old assets remain interpretable.
 *
 * `appimage-v2` (current) adds the hybrid AI pipeline: a `mode`
 * (composite | hybrid | concept), a scene/lighting `prompt`, a `harmonize`
 * block, and concept-mode `referenceImages`. `appimage-v1` payloads (pure
 * deterministic compositing) remain valid and resolve to `mode: "composite"`.
 */
export const APPIMAGE_PARAMS_VERSION = "appimage-v2";

/** Every params-contract version the generator still accepts. */
export const APPIMAGE_PARAMS_VERSIONS = ["appimage-v1", "appimage-v2"] as const;
export type AppImageParamsVersion = (typeof APPIMAGE_PARAMS_VERSIONS)[number];

/** Which point of the cutout is pinned to the placement coordinate. */
export const AppImageAnchorSchema = z.enum([
  "center",
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
]);
export type AppImageAnchor = z.infer<typeof AppImageAnchorSchema>;

/**
 * Which real-world dimension governs the cutout's on-screen size. `auto` lets
 * the engine pick; explicit values force a specific axis. See the scale engine
 * for the `auto` priority rationale.
 */
export const AppImageWidthBasisSchema = z.enum([
  "auto",
  "width",
  "height",
  "diameter",
  "length",
]);
export type AppImageWidthBasis = z.infer<typeof AppImageWidthBasisSchema>;

/**
 * Scene scale: `pxPerMm` is the link between real millimetres and scene pixels
 * (from AI inference or a user value). `scaleAdjust` is the user's "scale looks
 * off" correction multiplier applied on top.
 */
export const AppImageScaleSchema = z.object({
  pxPerMm: z.number().positive(),
  scaleAdjust: z.number().positive().default(1),
});
export type AppImageScale = z.infer<typeof AppImageScaleSchema>;

export const AppImageFixtureSchema = z.object({
  /**
   * Sales Layer CDN URL of the product image. Ideally an RGBA PNG with a real
   * transparent background, but opaque images (JPEG / white-background PNG) are
   * accepted too: the generator runs background removal (Gemini segmentation
   * mask -> alpha, cached in R2) to produce a transparent cutout before
   * compositing. Without GEMINI_API_KEY, opaque cutouts are rejected.
   */
  cutoutUrl: z.string().url(),
  /** Real fixture dimensions in millimetres; at least one is required. */
  dimensionsMm: DimensionsMmSchema.refine(
    (d) => Boolean(d.width || d.height || d.depth || d.diameter || d.length),
    {
      message:
        "at least one dimension (width/height/depth/diameter/length) is required",
    },
  ),
  anchor: AppImageAnchorSchema.default("bottom-center"),
  /** Anchor placement as a fraction of scene width/height (0..1). */
  xPct: z.number().min(0).max(1),
  yPct: z.number().min(0).max(1),
  widthBasis: AppImageWidthBasisSchema.default("auto"),
});
export type AppImageFixture = z.infer<typeof AppImageFixtureSchema>;

export const AppImageOutputSchema = z.object({
  format: z.enum(["png", "jpeg"]).default("png"),
  quality: z.number().int().min(1).max(100).optional(),
});
export type AppImageOutput = z.infer<typeof AppImageOutputSchema>;

/**
 * How the App Image is produced:
 * - `composite`: deterministic scale + sharp compositing only (Phase 2c). No AI.
 * - `hybrid`: Option C — composite the real cutouts, then let an AI inpainter
 *   (FLUX.1 Fill) paint integrated lighting/shadow/glow in a masked halo around
 *   each fixture (the fixture core is preserved), with an optional Gemini global
 *   harmonization pass. Highest fidelity + realistic light.
 * - `concept`: Option B — pure generative scene from a prompt (+ optional
 *   reference images). Fast, but NOT product-accurate; flagged as such.
 */
export const AppImageModeSchema = z.enum(["composite", "hybrid", "concept"]);
export type AppImageMode = z.infer<typeof AppImageModeSchema>;

/**
 * AI harmonization controls for `hybrid` mode. The inpaint step (FLUX.1 Fill) is
 * always run for hybrid; there is no provider switch because Fill is the only
 * masked inpainter wired in 2d. `globalPass` gates the optional Gemini
 * full-image lighting pass that runs after inpainting.
 */
export const AppImageHarmonizeSchema = z.object({
  /** Run the Gemini full-image lighting pass after FLUX.1 Fill. */
  globalPass: z.boolean().default(false),
  /** Pixels to dilate each fixture box by when building the inpaint mask. */
  maskDilationPx: z.number().int().min(0).max(512).default(48),
  /** FLUX.1 Fill sampling controls (passed through to BFL). */
  steps: z.number().int().min(1).max(50).optional(),
  guidance: z.number().min(1).max(100).optional(),
  seed: z.number().int().optional(),
});
export type AppImageHarmonize = z.infer<typeof AppImageHarmonizeSchema>;

/**
 * The SINGLE canonical App Image contract. `mode` selects the pipeline; the
 * deterministic fields (`sceneUrl`, `scale`, `fixtures`) are required for
 * `composite`/`hybrid` and unused by `concept`, which generates from `prompt`.
 * Per-mode requirements are enforced in the superRefine below so a malformed
 * request 400s at the API instead of dying as a dead generation job.
 */
// ---------------------------------------------------------------------------
// Scene generation (text-to-room). A sibling of the App Image engine: it asks
// Gemini for an empty room from a prompt and returns an image URL the user then
// composites real fixtures into. Exposed sizes go up to 4K because some scenes
// need very large output (4K requires a Gemini 3 image model upstream).
// ---------------------------------------------------------------------------

/** Gemini imageConfig.aspectRatio values we surface for room scenes. */
export const GeminiAspectRatioSchema = z.enum([
  "16:9",
  "4:3",
  "3:2",
  "1:1",
  "21:9",
  "9:16",
  "3:4",
  "2:3",
]);
export type GeminiAspectRatio = z.infer<typeof GeminiAspectRatioSchema>;

/** Gemini imageConfig.imageSize values (uppercase K is required upstream). */
export const GeminiImageSizeSchema = z.enum(["1K", "2K", "4K"]);
export type GeminiImageSize = z.infer<typeof GeminiImageSizeSchema>;

export const SceneGenRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  aspectRatio: GeminiAspectRatioSchema.default("16:9"),
  imageSize: GeminiImageSizeSchema.default("2K"),
});
export type SceneGenRequest = z.infer<typeof SceneGenRequestSchema>;

export const AppImageParamsSchema = z
  .object({
    version: z.enum(APPIMAGE_PARAMS_VERSIONS).default(APPIMAGE_PARAMS_VERSION),
    mode: AppImageModeSchema.default("composite"),
    /** Background scene (uploaded, stock, or a future AI-generated room). */
    sceneUrl: z.string().url().optional(),
    scale: AppImageScaleSchema.optional(),
    /** Fixtures to place; covers multi-fixture scenes. Empty for `concept`. */
    fixtures: z.array(AppImageFixtureSchema).default([]),
    /**
     * Room / lighting description. Required for `hybrid` (drives the Fill
     * lighting paint) and `concept` (drives generation); ignored for
     * `composite`.
     */
    prompt: z.string().trim().min(1).optional(),
    harmonize: AppImageHarmonizeSchema.default({}),
    /** Reference images for `concept` generation only (hybrid uses none). */
    referenceImages: z.array(z.string().url()).default([]),
    output: AppImageOutputSchema.default({}),
  })
  .superRefine((val, ctx) => {
    if (val.mode === "concept") {
      if (!val.prompt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["prompt"],
          message: "concept mode requires a prompt",
        });
      }
      return;
    }

    // composite | hybrid: need a scene, a scale, and at least one fixture.
    if (!val.sceneUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sceneUrl"],
        message: `${val.mode} mode requires sceneUrl`,
      });
    }
    if (!val.scale) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scale"],
        message: `${val.mode} mode requires scale`,
      });
    }
    if (val.fixtures.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fixtures"],
        message: `${val.mode} mode requires at least one fixture`,
      });
    }
    if (val.mode === "hybrid" && !val.prompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: "hybrid mode requires a prompt",
      });
    }
  });
export type AppImageParams = z.infer<typeof AppImageParamsSchema>;
