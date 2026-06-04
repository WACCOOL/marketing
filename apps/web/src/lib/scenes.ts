import type { GeminiAspectRatio, GeminiImageSize } from "@wac/shared";
import { api } from "./api.js";

/**
 * Generate a room scene from a text prompt (Gemini, via the API + generation
 * Container) and get back a public HTTPS URL the generator can later fetch as
 * the composite/hybrid scene. Sizes go up to 4K for large output.
 */
export async function generateScene(req: {
  prompt: string;
  aspectRatio: GeminiAspectRatio;
  imageSize: GeminiImageSize;
}): Promise<{ url: string }> {
  return api<{ url: string }>("/api/scenes", {
    method: "POST",
    body: JSON.stringify(req),
  });
}
