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
  type SegmentAdapter,
  type SegmentationMask,
} from "./adapter.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-2.5-flash-image";
// Segmentation is an image-understanding task; use a vision text model, not the
// image-output model. gemini-2.5-flash supports segmentation masks.
const DEFAULT_SEGMENT_MODEL = "gemini-2.5-flash";
const REQUEST_TIMEOUT_MS = 30_000;
const SEGMENT_TIMEOUT_MS = 60_000;

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
      Array.isArray(box) &&
      box.length === 4 &&
      box.every((n) => typeof n === "number") &&
      typeof mask === "string" &&
      mask.length > 0
    ) {
      masks.push({
        box2d: [box[0]!, box[1]!, box[2]!, box[3]!],
        maskPngBase64: mask.replace(/^data:image\/png;base64,/, ""),
        label: typeof item.label === "string" ? item.label : undefined,
      });
    }
  }
  return masks;
}

export function makeGeminiAdapter(
  config: GeminiConfig,
): HarmonizeAdapter & GenerateAdapter & SegmentAdapter {
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
    segment,
  };
}
