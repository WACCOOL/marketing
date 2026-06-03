/**
 * Google Gemini adapter — gemini-2.5-flash-image ("nano-banana"), Phase 2d.
 *
 * Two capabilities, both prompt-driven and both returning opaque images (Gemini
 * does not support transparency, so it only ever runs AFTER compositing):
 * - harmonize: send the post-inpaint image + a lighting prompt -> integrated
 *   global lighting/shadows. There is no mask and no separate "edit" mode;
 *   including an image part implicitly makes it an edit.
 * - generate: prompt (+ optional reference images) -> a new concept scene.
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
} from "./adapter.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-2.5-flash-image";
const REQUEST_TIMEOUT_MS = 30_000;

export interface GeminiConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
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

export function makeGeminiAdapter(config: GeminiConfig): HarmonizeAdapter & GenerateAdapter {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = config.model ?? DEFAULT_MODEL;
  const url = `${baseUrl}/v1/models/${model}:generateContent`;

  async function call(parts: Part[]): Promise<Buffer> {
    const body = {
      contents: [{ parts }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    };

    const res = await fetchWithTimeout(
      "Gemini generateContent",
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": config.apiKey,
        },
        body: JSON.stringify(body),
      },
      REQUEST_TIMEOUT_MS,
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

  return {
    provider: "gemini-2.5-flash-image",
    harmonize(req: HarmonizeRequest): Promise<Buffer> {
      return call([imagePart(req.image), { text: req.prompt }]);
    },
    generate(req: GenerateRequest): Promise<Buffer> {
      const parts: Part[] = [{ text: req.prompt }];
      for (const ref of req.referenceImages ?? []) parts.push(imagePart(ref));
      return call(parts);
    },
  };
}
