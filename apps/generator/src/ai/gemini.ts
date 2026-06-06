/**
 * Google Gemini adapter — gemini-2.5-flash-image ("nano-banana"), Phase 2d.
 *
 * Capabilities:
 * - harmonize: send the post-inpaint image + a lighting prompt -> integrated
 *   global lighting/shadows. There is no mask and no separate "edit" mode;
 *   including an image part implicitly makes it an edit. Returns an opaque image
 *   (Gemini cannot output transparency), so it only ever runs AFTER compositing.
 * - generate: prompt (+ optional reference images) -> a new image (concept scene
 *   or text-to-room scene with imageConfig size/aspect controls).
 * - segment: image understanding -> object segmentation masks, used for
 *   background removal. Gemini can't EMIT transparency, but it CAN return a
 *   per-object mask; we apply that mask as an alpha channel ourselves (cutout.ts).
 *
 * Images go up as base64 `inline_data` parts and come back as base64 `inlineData`
 * parts under `candidates[].content.parts[]`.
 */

import {
  fetchWithTimeout,
  type GenerateAdapter,
  type GenerateRequest,
  type HarmonizeAdapter,
  type HarmonizeRequest,
  type PerspectiveAdapter,
  type PerspectiveHint,
  type PerspectiveRequest,
  type PlacementCriticAdapter,
  type PlacementCritique,
  type PlacementCritiqueRequest,
  type RelightAdapter,
  type RelightRequest,
  type RoomAnalysisRequest,
  type RoomPlacement,
  type SceneInspectAdapter,
  type SceneInspectRequest,
  type SegmentAdapter,
  type SegmentationMask,
} from "./adapter.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-2.5-flash-image";
// Segmentation is an image-understanding task; use a vision text model, not the
// image-output model. gemini-2.5-flash supports segmentation masks.
const DEFAULT_SEGMENT_MODEL = "gemini-2.5-flash";
const REQUEST_TIMEOUT_MS = 30_000;
// Shorter than before (was 60s): when segmentation is slow/stuck we'd rather
// bail quickly and let cutout.ts's classical flood-fill fallback take over than
// make the user wait a full minute (×retries) before any result.
const SEGMENT_TIMEOUT_MS = 40_000;
// Relight is a multi-image edit (composite + reference cutouts); allow headroom.
const RELIGHT_TIMEOUT_MS = 90_000;
const PERSPECTIVE_TIMEOUT_MS = 30_000;
const INSPECT_TIMEOUT_MS = 30_000;
const CRITIQUE_TIMEOUT_MS = 30_000;

const SEGMENT_PROMPT =
  "Give the segmentation mask for the main foreground product in this image " +
  "(the light fixture, lamp, or hardware item) — exclude the background, the " +
  "surface/floor, and any cast shadow. Output a JSON list of segmentation masks " +
  'where each entry contains the 2D bounding box in the key "box_2d", the ' +
  'segmentation mask in the key "mask", and a text label in the key "label".';

/** Gemini imageConfig — aspectRatio (e.g. "16:9") and imageSize ("1K"/"2K"/"4K"). */
interface ImageConfig {
  aspectRatio?: string;
  imageSize?: string;
}

export interface GeminiConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Model used for segmentation (background removal). */
  segmentModel?: string;
}

interface InlinePart {
  inline_data: { mime_type: string; data: string };
}
interface TextPart {
  text: string;
}
type Part = InlinePart | TextPart;

interface GenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: { mimeType?: string; data?: string };
        inline_data?: { mime_type?: string; data?: string };
        text?: string;
      }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

/** Sniff a content type from magic bytes; default to PNG. */
function sniffMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46
  ) {
    return "image/webp";
  }
  return "image/png";
}

function imagePart(buf: Buffer): InlinePart {
  return {
    inline_data: { mime_type: sniffMime(buf), data: buf.toString("base64") },
  };
}

interface CallOpts {
  /** Per-call model override (e.g. a Gemini 3 image model for 4K scenes). */
  model?: string;
  /** Gemini imageConfig (aspectRatio + imageSize). */
  imageConfig?: ImageConfig;
  /** Per-call timeout override; defaults to REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

interface RawMask {
  box_2d?: number[];
  mask?: string;
  label?: string;
}

/** Parse Gemini's JSON segmentation response (tolerant of code fences). */
function parseMasks(text: string): SegmentationMask[] {
  let body = text.trim();
  if (body.startsWith("```")) {
    body = body.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [];
  const masks: SegmentationMask[] = [];
  for (const item of list as RawMask[]) {
    const box = item.box_2d;
    const mask = item.mask;
    if (
      !Array.isArray(box) ||
      box.length !== 4 ||
      !box.every((n) => typeof n === "number") ||
      typeof mask !== "string" ||
      mask.length === 0
    ) {
      continue;
    }
    const b64 = mask.replace(/^data:image\/[a-z]+;base64,/i, "").trim();
    // Only keep masks whose payload is actually a base64 PNG; Gemini sometimes
    // returns prose or a truncated/empty string, which would crash sharp later
    // with "unsupported image format". The PNG magic header base64-encodes to
    // "iVBORw0KGgo".
    if (!b64.startsWith("iVBORw0KGgo")) continue;
    masks.push({
      box2d: [box[0]!, box[1]!, box[2]!, box[3]!],
      maskPngBase64: b64,
      label: typeof item.label === "string" ? item.label : undefined,
    });
  }
  return masks;
}

export function makeGeminiAdapter(
  config: GeminiConfig,
): HarmonizeAdapter &
  GenerateAdapter &
  SegmentAdapter &
  RelightAdapter &
  PerspectiveAdapter &
  SceneInspectAdapter &
  PlacementCriticAdapter {
  // imageConfig (aspectRatio / imageSize) is only honored on the v1beta endpoint.
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const defaultModel = config.model ?? DEFAULT_MODEL;
  const segmentModel = config.segmentModel ?? DEFAULT_SEGMENT_MODEL;

  async function call(parts: Part[], opts: CallOpts = {}): Promise<Buffer> {
    const model = opts.model ?? defaultModel;
    const url = `${baseUrl}/v1beta/models/${model}:generateContent`;

    const generationConfig: Record<string, unknown> = {
      responseModalities: ["TEXT", "IMAGE"],
    };
    if (opts.imageConfig) {
      // Drop empty keys so we never send `{}` or null values upstream.
      const imageConfig: ImageConfig = {};
      if (opts.imageConfig.aspectRatio) {
        imageConfig.aspectRatio = opts.imageConfig.aspectRatio;
      }
      if (opts.imageConfig.imageSize) {
        imageConfig.imageSize = opts.imageConfig.imageSize;
      }
      if (Object.keys(imageConfig).length > 0) {
        generationConfig.imageConfig = imageConfig;
      }
    }

    const res = await fetchWithTimeout(
      "Gemini generateContent",
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify({ contents: [{ parts }], generationConfig }),
      },
      opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new Error(
        `Gemini generateContent failed ${res.status}: ${await res.text().catch(() => "")}`,
      );
    }

    const data = (await res.json()) as GenerateContentResponse;
    if (data.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked the request: ${data.promptFeedback.blockReason}`);
    }

    const candidateParts = data.candidates?.[0]?.content?.parts ?? [];
    for (const part of candidateParts) {
      const inline = part.inlineData ?? part.inline_data;
      const b64 = inline?.data;
      if (b64) return Buffer.from(b64, "base64");
    }
    throw new Error("Gemini response contained no image part");
  }

  /** Run a segmentation request and return the parsed masks. */
  async function segment(image: Buffer): Promise<SegmentationMask[]> {
    const url = `${baseUrl}/v1beta/models/${segmentModel}:generateContent`;
    const res = await fetchWithTimeout(
      "Gemini segment",
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [imagePart(image), { text: SEGMENT_PROMPT }] }],
          generationConfig: {
            responseMimeType: "application/json",
            // Segmentation is more reliable with thinking disabled (per Google).
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
      SEGMENT_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new Error(
        `Gemini segment failed ${res.status}: ${await res.text().catch(() => "")}`,
      );
    }

    const data = (await res.json()) as GenerateContentResponse;
    if (data.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked the request: ${data.promptFeedback.blockReason}`);
    }
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
    return parseMasks(text);
  }

  return {
    provider: "gemini-2.5-flash-image",
    harmonize(req: HarmonizeRequest): Promise<Buffer> {
      return call([imagePart(req.image), { text: req.prompt }]);
    },
    generate(req: GenerateRequest): Promise<Buffer> {
      const parts: Part[] = [{ text: req.prompt }];
      for (const ref of req.referenceImages ?? []) parts.push(imagePart(ref));
      return call(parts, {
        model: req.model,
        imageConfig:
          req.aspectRatio || req.imageSize
            ? { aspectRatio: req.aspectRatio, imageSize: req.imageSize }
            : undefined,
        timeoutMs: req.timeoutMs,
      });
    },
    relight(req: RelightRequest): Promise<Buffer> {
      // First part is the composited scene to edit; the rest are the fixture
      // cutout(s) as a design reference; the text part carries the geometry lock.
      const parts: Part[] = [imagePart(req.image)];
      for (const ref of req.references ?? []) parts.push(imagePart(ref));
      parts.push({ text: req.prompt });
      return call(parts, { timeoutMs: req.timeoutMs ?? RELIGHT_TIMEOUT_MS });
    },
    estimatePerspective,
    hasMountedFixture,
    critiquePlacement,
    analyzeRoom,
    segment,
  };

  /**
   * Read a BARE room and choose where the fixture should be mounted, BEFORE any
   * render — so it starts in the natural spot (a chandelier centered over the
   * dining/seating area on the ceiling; a sconce on a clear, prominent wall at a
   * believable height) instead of dead-center. Fails open (returns null) so a
   * flaky vision call just falls back to the default placement.
   */
  async function analyzeRoom(
    req: RoomAnalysisRequest,
  ): Promise<RoomPlacement | null> {
    const type = req.fixtureType ?? "light fixture";
    const mount = req.mount ?? "ceiling";
    const guidance =
      mount === "ceiling" || mount === "recessed"
        ? `Find where a ${type} should hang from the ceiling. Put it over the ` +
          `visual center of the main seating/dining area, horizontally centered ` +
          `on the ceiling above that furniture. yPct should sit on the ceiling ` +
          `(usually upper third of the frame), low enough that the fixture and a ` +
          `short drop are visible, not cropped at the top edge.`
        : mount === "wall"
          ? `Find the clearest, most prominent empty wall area for a ${type}. ` +
            `Center it on that wall span at a believable mounting height ` +
            `(typically a bit above eye level), clear of windows, art and ` +
            `furniture.`
          : `Find a natural, uncluttered spot on the floor for a ${type}.`;
    const prompt =
      `This is an empty interior room (no fixture yet). ${guidance} Also suggest ` +
      `a realistic on-screen size for the fixture as "coverage" = its height as a ` +
      `fraction of the frame height (chandeliers ~0.2-0.4, sconces ~0.12-0.25). ` +
      `Respond with ONLY JSON {"xPct": number, "yPct": number, "coverage": ` +
      `number, "reason": string}; xPct/yPct are the fixture center, 0..1 from the ` +
      `top-left.`;
    const url = `${baseUrl}/v1beta/models/${segmentModel}:generateContent`;
    try {
      const res = await fetchWithTimeout(
        "Gemini room analysis",
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": config.apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [imagePart(req.image), { text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        },
        req.timeoutMs ?? CRITIQUE_TIMEOUT_MS,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as GenerateContentResponse;
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      let body = text.trim();
      if (body.startsWith("```")) {
        body = body.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const num = (v: unknown): number | undefined =>
        typeof v === "number" && Number.isFinite(v) ? v : undefined;
      const clamp = (v: number, lo: number, hi: number) =>
        Math.min(hi, Math.max(lo, v));
      const x = num(parsed.xPct);
      const y = num(parsed.yPct);
      if (x === undefined || y === undefined) return null;
      const cov = num(parsed.coverage);
      return {
        xPct: clamp(x, 0, 1),
        yPct: clamp(y, 0, 1),
        coverage: cov !== undefined ? clamp(cov, 0.1, 0.6) : undefined,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Vision critic for the auto-placement loop. Judges the preview composite and
   * returns absolute corrections. Fails open (approved=true) so a flaky vision
   * call never deadlocks the loop.
   */
  async function critiquePlacement(
    req: PlacementCritiqueRequest,
  ): Promise<PlacementCritique> {
    const type = req.fixtureType ?? "light fixture";
    const mount = req.mount ?? "wall";
    const cur = req.current ?? {};
    const curStr = JSON.stringify({
      xPct: cur.xPct ?? 0.5,
      yPct: cur.yPct ?? 0.5,
      coverage: cur.coverage ?? 0.34,
      brightness: cur.brightness ?? 25,
    });
    const prompt =
      `This is a rendered marketing photo of a ${type} (${mount}-mounted) placed ` +
      `into a room. Judge it as a lighting designer would. Criteria: (1) the ` +
      `fixture sits believably ON the ${mount} (not floating, not clipped, not ` +
      `half off-frame); (2) its size is realistic for a real ${type}; (3) it is ` +
      `well composed (a ${mount === "ceiling" ? "ceiling" : "wall"} fixture should ` +
      `read clearly, generally upper/central); (4) it visibly casts light into the ` +
      `space. The current placement is ${curStr} where xPct/yPct are the fixture ` +
      `center (0..1 from top-left), coverage is fixture height as a fraction of the ` +
      `frame, brightness is a 0..100 light slider. Respond with ONLY JSON: ` +
      `{"approved": boolean, "xPct": number, "yPct": number, "coverage": number, ` +
      `"brightness": number, "reason": string}. Always return the BEST absolute ` +
      `values (corrected if needed, else the current ones). Keep coverage in ` +
      `[0.15,0.6] and brightness in [0,100].`;
    const url = `${baseUrl}/v1beta/models/${segmentModel}:generateContent`;
    try {
      const res = await fetchWithTimeout(
        "Gemini critique",
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": config.apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [imagePart(req.image), { text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        },
        req.timeoutMs ?? CRITIQUE_TIMEOUT_MS,
      );
      if (!res.ok) return { approved: true };
      const data = (await res.json()) as GenerateContentResponse;
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      let body = text.trim();
      if (body.startsWith("```")) {
        body = body.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const num = (v: unknown): number | undefined =>
        typeof v === "number" && Number.isFinite(v) ? v : undefined;
      const clamp = (v: number, lo: number, hi: number) =>
        Math.min(hi, Math.max(lo, v));
      const adjust: PlacementCritique["adjust"] = {};
      const x = num(parsed.xPct);
      const y = num(parsed.yPct);
      const cov = num(parsed.coverage);
      const br = num(parsed.brightness);
      if (x !== undefined) adjust.xPct = clamp(x, 0, 1);
      if (y !== undefined) adjust.yPct = clamp(y, 0, 1);
      if (cov !== undefined) adjust.coverage = clamp(cov, 0.15, 0.6);
      if (br !== undefined) adjust.brightness = clamp(br, 0, 100);
      return {
        approved: parsed.approved === true,
        adjust,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      };
    } catch {
      return { approved: true };
    }
  }

  /**
   * Vision yes/no: does the generated scene already have a light fixture or
   * mounting hardware (junction box, canopy, ceiling rose, recessed can) on the
   * target surface? Used to regenerate "dirty" scenes before compositing.
   * Fails open (returns false) so a flaky vision call never blocks scene gen.
   */
  async function hasMountedFixture(req: SceneInspectRequest): Promise<boolean> {
    const mount = req.mount ?? "ceiling";
    const prompt =
      `Look only at the ${mount} surface in this interior photo. Is there any ` +
      `light fixture, lamp, chandelier, pendant, recessed light, junction box, ` +
      `electrical box, canopy, ceiling medallion, mounting plate, or exposed ` +
      `wiring attached to or cut into that ${mount}? Respond with ONLY JSON ` +
      `{"present": true} or {"present": false}.`;
    const url = `${baseUrl}/v1beta/models/${segmentModel}:generateContent`;
    try {
      const res = await fetchWithTimeout(
        "Gemini inspect",
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": config.apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [imagePart(req.image), { text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        },
        req.timeoutMs ?? INSPECT_TIMEOUT_MS,
      );
      if (!res.ok) return false;
      const data = (await res.json()) as GenerateContentResponse;
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      let body = text.trim();
      if (body.startsWith("```")) {
        body = body.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      }
      const parsed = JSON.parse(body) as { present?: unknown };
      return parsed.present === true;
    } catch {
      return false;
    }
  }

  /** Ask Gemini vision for a keystone hint for the mount surface. */
  async function estimatePerspective(
    req: PerspectiveRequest,
  ): Promise<PerspectiveHint> {
    const mount = req.mount ?? "ceiling";
    const prompt =
      `This is an interior room photo. Estimate the camera perspective of the ` +
      `${mount} surface where a flat, front-facing product image would be placed. ` +
      `Respond with ONLY JSON {"vertical": number, "horizontal": number}, each in ` +
      `[-0.3, 0.3]. vertical>0 = the top edge recedes (looking up at a ceiling ` +
      `fixture); horizontal>0 = the right edge recedes (surface turned away to the ` +
      `right). Use 0 for a surface that faces the camera straight-on.`;
    const url = `${baseUrl}/v1beta/models/${segmentModel}:generateContent`;
    const res = await fetchWithTimeout(
      "Gemini perspective",
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [imagePart(req.image), { text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
      req.timeoutMs ?? PERSPECTIVE_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new Error(
        `Gemini perspective failed ${res.status}: ${await res.text().catch(() => "")}`,
      );
    }
    const data = (await res.json()) as GenerateContentResponse;
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
    return parsePerspectiveHint(text);
  }
}

/** Clamp a number into [-0.3, 0.3]; non-finite -> 0. */
function clampHint(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.min(0.3, Math.max(-0.3, v));
}

/** Parse Gemini's perspective JSON (tolerant of code fences); identity on failure. */
function parsePerspectiveHint(text: string): PerspectiveHint {
  let body = text.trim();
  if (body.startsWith("```")) {
    body = body.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  try {
    const parsed = JSON.parse(body) as { vertical?: number; horizontal?: number };
    return {
      vertical: clampHint(parsed.vertical),
      horizontal: clampHint(parsed.horizontal),
    };
  } catch {
    return { vertical: 0, horizontal: 0 };
  }
}
