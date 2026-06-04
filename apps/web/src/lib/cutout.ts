import { api } from "./api.js";

/**
 * Remove the background from a product image (server-side, via the generation
 * Container's matting — Gemini segmentation with a classical flood-fill
 * fallback) and get back a transparent PNG URL. Used in the fixture step so the
 * chosen image is shown (and later composited) with its background already gone.
 */
export async function removeBackground(sourceUrl: string): Promise<{ url: string }> {
  return api<{ url: string }>("/api/cutout", {
    method: "POST",
    body: JSON.stringify({ sourceUrl }),
  });
}
