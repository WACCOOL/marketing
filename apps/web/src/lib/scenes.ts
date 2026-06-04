import type {
  FixtureMount,
  GeminiAspectRatio,
  GeminiImageSize,
} from "@wac/shared";
import { api } from "./api.js";

/**
 * Generate a room scene from a text prompt (Gemini, via the API + generation
 * Container) and get back a public HTTPS URL the generator can later fetch as
 * the composite/hybrid scene. Sizes go up to 4K for large output. When a hero
 * fixture is known, `fixtureType`/`mount` make the scene leave space for it.
 */
export async function generateScene(req: {
  prompt: string;
  aspectRatio: GeminiAspectRatio;
  imageSize: GeminiImageSize;
  fixtureType?: string;
  mount?: FixtureMount;
}): Promise<{ url: string }> {
  return api<{ url: string }>("/api/scenes", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/**
 * Ask the server (Gemini vision) for a keystone hint for the mount surface in a
 * scene. Returns vertical/horizontal in [-0.3, 0.3]. Callers should fall back to
 * a positional heuristic if this throws (it's a best-effort enhancement).
 */
export async function suggestPerspective(req: {
  sceneUrl: string;
  mount?: FixtureMount;
}): Promise<{ vertical: number; horizontal: number }> {
  return api<{ vertical: number; horizontal: number }>(
    "/api/scenes/perspective",
    { method: "POST", body: JSON.stringify(req) },
  );
}
