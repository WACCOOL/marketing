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

/**
 * One corner's displacement for a perspective (keystone) warp, expressed as a
 * fraction of the cutout's own width (`dx`) and height (`dy`). `0,0` leaves the
 * corner where it is, so an all-zero perspective is the identity transform. The
 * warp is applied to the REAL cutout pixels (a projective transform), so it can
 * correct viewing angle without inventing geometry. Range is clamped to keep the
 * warp sane (a corner can move at most one full cutout dimension).
 */
export const AppImageCornerOffsetSchema = z.object({
  dx: z.number().min(-1).max(1).default(0),
  dy: z.number().min(-1).max(1).default(0),
});
export type AppImageCornerOffset = z.infer<typeof AppImageCornerOffsetSchema>;

/**
 * Per-fixture perspective correction: where each corner of the cutout's
 * rectangle should map to. Drives a deterministic projective warp of the real
 * pixels (think Photoshop Free Transform / Perspective Warp), so the fixture's
 * angle can be matched to the room WITHOUT a generative re-render. Omitted or
 * all-zero means "no warp".
 */
export const AppImagePerspectiveSchema = z.object({
  topLeft: AppImageCornerOffsetSchema.default({}),
  topRight: AppImageCornerOffsetSchema.default({}),
  bottomRight: AppImageCornerOffsetSchema.default({}),
  bottomLeft: AppImageCornerOffsetSchema.default({}),
});
export type AppImagePerspective = z.infer<typeof AppImagePerspectiveSchema>;

/**
 * Camera pose for rendering a 3D fixture model (Phase 3). An orbit camera around
 * the fixture: `azimuthDeg` rotates around it (0 = front), `elevationDeg` raises
 * the camera (front-to-back tilt), `rollDeg` rolls the camera about its view axis
 * (side-to-side tilt / lean), `fovDeg` sets the lens, and the framing factors
 * dolly/pad the shot.
 */
export const AppImageModelPoseSchema = z.object({
  azimuthDeg: z.number().default(0),
  elevationDeg: z.number().default(0),
  rollDeg: z.number().default(0),
  fovDeg: z.number().positive().default(35),
  distanceFactor: z.number().positive().default(1),
  marginFactor: z.number().positive().default(1.25),
  /**
   * Optional explicit camera distance in scene meters, carried from the 3D
   * viewer's orbit radius so a Blender render can reproduce the viewer's exact
   * perspective. When absent the renderer auto-frames from the bounding sphere.
   */
  distanceMeters: z.number().positive().optional(),
});
export type AppImageModelPose = z.infer<typeof AppImageModelPoseSchema>;

/**
 * A real 3D fixture model (Blender `.blend` or glTF `.glb`) plus the pose to
 * render it from. When a fixture carries this, the generator renders a
 * product-accurate transparent cutout via the render-worker (Blender) instead of
 * matting a flat catalog photo — true viewpoint/scale, no hallucinated geometry.
 */
export const AppImageModelSchema = z.object({
  /** URL the render-worker can fetch (.blend/.glb). */
  url: z.string().url(),
  /** SKU hint so the worker picks the right fixture collection in the file. */
  sku: z.string().optional(),
  pose: AppImageModelPoseSchema.default({}),
  /** Render engine override; defaults to EEVEE (fast) in the worker. */
  engine: z.enum(["BLENDER_EEVEE_NEXT", "CYCLES"]).optional(),
  samples: z.number().int().positive().max(2048).optional(),
  /** Render the fixture's internal lamps "on" (emissive). */
  lightsOn: z.boolean().optional(),
});
export type AppImageModel = z.infer<typeof AppImageModelSchema>;

export const AppImageFixtureSchema = z
  .object({
    /**
     * Sales Layer CDN URL of the product image. Ideally an RGBA PNG with a real
     * transparent background, but opaque images (JPEG / white-background PNG) are
     * accepted too: the generator runs background removal (Gemini segmentation
     * mask -> alpha, cached in R2) to produce a transparent cutout before
     * compositing. Without GEMINI_API_KEY, opaque cutouts are rejected.
     *
     * Optional ONLY when `model` is supplied — then the cutout is rendered from
     * the 3D model instead of fetched.
     */
    cutoutUrl: z.string().url().optional(),
    /**
     * Optional 3D model + pose. When present, the generator renders a
     * product-accurate transparent cutout (Blender) and ignores `cutoutUrl`.
     */
    model: AppImageModelSchema.optional(),
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
    /**
     * Optional deterministic perspective warp applied to the real cutout pixels
     * before placement (corrects viewing angle without re-rendering). Omitted =
     * no warp. Largely unnecessary when `model` is set (the pose handles angle).
     */
    perspective: AppImagePerspectiveSchema.optional(),
  })
  .refine((f) => Boolean(f.cutoutUrl) || Boolean(f.model), {
    message: "fixture needs either a cutoutUrl or a 3D model",
    path: ["cutoutUrl"],
  });
export type AppImageFixture = z.infer<typeof AppImageFixtureSchema>;

export const AppImageOutputSchema = z.object({
  format: z.enum(["png", "jpeg"]).default("png"),
  quality: z.number().int().min(1).max(100).optional(),
});
export type AppImageOutput = z.infer<typeof AppImageOutputSchema>;

/**
 * How the App Image is produced:
 * - `composite`: deterministic scale + sharp compositing only (Phase 2c). No AI,
 *   pixel-exact fixture.
 * - `hybrid`: product-accurate by construction — the REAL cutout is optionally
 *   perspective-warped, composited deterministically, then harmonized (the
 *   fixture region's color/tone/lighting is matched to the scene). The room
 *   pixels stay deterministic and the fixture geometry is never re-rendered, so
 *   shapes can't be invented (cf. Photoshop's "Harmonize"). No FLUX/inpainting.
 * - `concept`: pure generative scene from a prompt (+ optional reference
 *   images). Fast, but NOT product-accurate; flagged as such.
 */
export const AppImageModeSchema = z.enum([
  "composite",
  "hybrid",
  "concept",
  "shot3d",
]);
export type AppImageMode = z.infer<typeof AppImageModeSchema>;

// ---------------------------------------------------------------------------
// 3D app-shot (Phase 3 / Phase C). A real Blender fixture composited into a room
// IN Blender (true light spill, refraction, grounding), then exported as a
// layered PSD + AVIF + PNG. Distinct from the 2D `composite`/`hybrid` engines:
// no flat cutout, no harmonization — the fixture is the actual 3D model. The UI
// drives an auto-place AI loop (preview renders) then a high-quality finalize.
// ---------------------------------------------------------------------------

/**
 * The user-adjustable placement of a 3D fixture in the room. `coverage` is the
 * fixture's on-screen height as a fraction of the frame; `brightness` scales how
 * bright the fixture's OWN diffusers/bulbs glow; `lightOutput` scales the real
 * light it throws into the room (IES power, or its own lamps for decoratives
 * without photometry); `warm` (0..1) shifts color temperature; `pose` is the
 * orbit camera around the fixture. These are exactly the sliders the web UI binds
 * to, and the values the AI critic returns when correcting a placement.
 */
export const AppShotPlacementSchema = z.object({
  xPct: z.number().min(0).max(1).default(0.5),
  yPct: z.number().min(0).max(1).default(0.4),
  coverage: z.number().min(0.05).max(3).default(0.34),
  brightness: z.number().min(0).max(200).default(25),
  lightOutput: z.number().min(0).max(200).default(25),
  warm: z.number().min(0).max(1).default(0.45),
  pose: AppImageModelPoseSchema.default({}),
});
export type AppShotPlacement = z.infer<typeof AppShotPlacementSchema>;

/**
 * How the fixture is rendered onto its background (Cam Solve). `studio` is the
 * existing in-Blender catcher composite (contact shadow + light spill on the
 * backdrop); `clean` is the flat layered cutout (fixture only, alpha preserved);
 * `cleanShadow` adds a soft, alpha-preserving drop shadow under the fixture.
 * Defaults to `studio` so the 3D App-Shot flow is unchanged.
 */
export const RenderStyleSchema = z.enum(["clean", "cleanShadow", "studio"]);
export type RenderStyle = z.infer<typeof RenderStyleSchema>;

/**
 * Render-quality tier. Bundles the three knobs that trade render time for image
 * quality — Cycles samples, refractive caustics (the crystal/glass sparkle), and
 * output resolution — into one control. `standard` matches the previous fixed
 * defaults, so omitting it is a no-op. `high`/`max` turn caustics on and push
 * samples + resolution way up for catalog-grade output (minutes, not seconds);
 * `draft` is the fast, caustics-off preview tier. The concrete numbers live in
 * the generator's `qualityProfile`.
 */
export const RenderQualitySchema = z.enum(["draft", "standard", "high", "max"]);
export type RenderQuality = z.infer<typeof RenderQualitySchema>;

/**
 * Finalize payload carried inside `AppImageParams.shot` for the `shot3d` mode.
 * It rides the normal async generation job pipeline so a final app-shot becomes
 * a library asset (PNG + AVIF + layered PSD) like any other generation.
 */
export const AppShotInputSchema = z.object({
  /** SKU resolved to a .blend (+ optional IES) by the generator's fixture map. */
  sku: z.string().trim().min(1),
  /** The room plate (uploaded or AI-generated) the fixture is composited into. */
  sceneUrl: z.string().url(),
  placement: AppShotPlacementSchema,
  samples: z.number().int().positive().max(2048).optional(),
  highQuality: z.boolean().optional(),
  /** Cam Solve render style (clean / cleanShadow / studio). Defaults to studio. */
  renderStyle: RenderStyleSchema.optional(),
  /** Quality tier (samples + caustics + resolution). Defaults to standard. */
  renderQuality: RenderQualitySchema.optional(),
});
export type AppShotInput = z.infer<typeof AppShotInputSchema>;

/**
 * Synchronous auto-place request (API → generator `/compose-3d`). The generator
 * places the fixture and runs the hidden AI critic loop, returning an approved
 * preview + the placement the UI binds its sliders to. `placement` is optional
 * starting overrides; omit it to use the fixture's defaults.
 */
export const AppShotComposeRequestSchema = z.object({
  sku: z.string().trim().min(1),
  sceneUrl: z.string().url(),
  placement: AppShotPlacementSchema.partial().optional(),
  /** Max AI correction rounds before handing back to the user (default 3). */
  maxIterations: z.number().int().min(1).max(6).optional(),
});
export type AppShotComposeRequest = z.infer<typeof AppShotComposeRequestSchema>;

/**
 * Synchronous single preview request (API → generator). Renders the user's EXACT
 * placement once with NO AI critic (so slider changes are never overridden). Used
 * for the responsive live-preview loop while the user tweaks sliders.
 */
export const AppShotPreviewRequestSchema = z.object({
  sku: z.string().trim().min(1),
  sceneUrl: z.string().url(),
  placement: AppShotPlacementSchema,
  /** Cam Solve render style (clean / cleanShadow / studio). Defaults to studio. */
  renderStyle: RenderStyleSchema.optional(),
  /** Quality tier (samples + caustics + resolution). Defaults to standard. */
  renderQuality: RenderQualitySchema.optional(),
});
export type AppShotPreviewRequest = z.infer<typeof AppShotPreviewRequestSchema>;

/**
 * Finalize request (API). Enqueues a `shot3d` generation job that produces the
 * full-quality layered export and saves it as a library asset.
 */
export const AppShotFinalizeRequestSchema = z.object({
  sku: z.string().trim().min(1),
  sceneUrl: z.string().url(),
  placement: AppShotPlacementSchema,
  /** Optional asset name; defaults to the SKU. */
  name: z.string().trim().min(1).max(200).optional(),
  /** Cam Solve render style (clean / cleanShadow / studio). Defaults to studio. */
  renderStyle: RenderStyleSchema.optional(),
  /** Quality tier (samples + caustics + resolution). Defaults to standard. */
  renderQuality: RenderQualitySchema.optional(),
});
export type AppShotFinalizeRequest = z.infer<
  typeof AppShotFinalizeRequestSchema
>;

/**
 * Harmonization controls for `hybrid` mode. Harmonization recolors/relights the
 * placed fixture region to match the scene via a classical, shape-preserving
 * color/tone transfer (Lab-space mean/std matching of the fixture's pixels to
 * the surrounding scene). It emits a color transform, never new pixels, so it
 * CANNOT change the fixture's geometry — only its color, exposure, and tone.
 */
export const AppImageHarmonizeSchema = z.object({
  /** Whether to run the harmonization (color/light match) pass. */
  enabled: z.boolean().default(true),
  /**
   * How strongly to pull the fixture toward the scene's color/tone (0 = no
   * change, 1 = full match). A moderate default keeps the product recognizable
   * while making it sit in the room's light.
   */
  strength: z.number().min(0).max(1).default(0.7),
  /**
   * Optional soft contact shadow / glow rendered deterministically around each
   * fixture to ground it in the scene. Pixels, 0 = none.
   */
  shadowPx: z.number().int().min(0).max(256).default(0),
  /**
   * Optional generative relight pass (Gemini) AFTER the classical color
   * transfer. Unlike harmonization this CAN re-render the fixture, so it is
   * off by default; the original cutout is passed back to Gemini as a design
   * reference with a geometry-locked prompt to keep the shape faithful. Use it
   * when the classical match isn't enough (directional light, reflections).
   */
  aiRelight: z.boolean().default(false),
  /**
   * Turn the fixture's lamps "on": the generative pass illuminates the bulbs
   * and casts light onto nearby surfaces. Implies the relight pass. Off by
   * default. Only meaningful with a configured Gemini key.
   */
  lightsOn: z.boolean().default(false),
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

/**
 * Where the hero fixture will be mounted. Used to make a generated scene
 * fixture-aware (leave clear space on that surface) and to drive auto-placement.
 */
export const FixtureMountSchema = z.enum(["ceiling", "wall", "floor", "recessed"]);
export type FixtureMount = z.infer<typeof FixtureMountSchema>;

export const SceneGenRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  aspectRatio: GeminiAspectRatioSchema.default("16:9"),
  imageSize: GeminiImageSizeSchema.default("2K"),
  /**
   * Optional hero-fixture context. When set, the scene is generated to SHOWCASE
   * this fixture: the prompt is augmented to leave clear, uncluttered space on
   * the `mount` surface and to omit any pre-existing fixture there.
   */
  fixtureType: z.string().trim().min(1).max(120).optional(),
  mount: FixtureMountSchema.optional(),
  /**
   * Enforce the AI scene gate: after generating, vision-check that the mount
   * surface is clear (no hallucinated fixture/hardware) and silently regenerate
   * up to a few times if not. Used by the 3D app-shot flow so the real fixture
   * isn't dropped onto a hallucinated one.
   */
  gate: z.boolean().optional(),
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
     * Room / lighting description. Required for `concept` (drives generation);
     * optional context for `hybrid` (harmonization is color-driven, not
     * prompt-driven); ignored for `composite`.
     */
    prompt: z.string().trim().min(1).optional(),
    harmonize: AppImageHarmonizeSchema.default({}),
    /** Reference images for `concept` generation only (hybrid uses none). */
    referenceImages: z.array(z.string().url()).default([]),
    /** 3D app-shot payload; required for (and only used by) `shot3d` mode. */
    shot: AppShotInputSchema.optional(),
    output: AppImageOutputSchema.default({}),
  })
  .superRefine((val, ctx) => {
    if (val.mode === "shot3d") {
      if (!val.shot) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["shot"],
          message: "shot3d mode requires a shot payload",
        });
      }
      return;
    }
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
  });
export type AppImageParams = z.infer<typeof AppImageParamsSchema>;
