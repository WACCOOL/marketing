import type { PptLayout, PptSlide } from "@wac/shared";
import { APPIMAGE_PARAMS_VERSION } from "@wac/shared";
import { api, apiBlob, type ApiError } from "../../lib/api.js";
import { supabase } from "../../lib/supabase.js";
import { createJob, pollJob } from "../../lib/jobs.js";
import { uploadImage } from "../../lib/uploads.js";

/**
 * Shared client plumbing for the PPT Generator pages (Templates, Deck Builder,
 * My Decks): template/introspection types mirroring the /api/ppt contract, a
 * multipart helper (the json-defaulting `api` helper would mangle FormData),
 * and the inline concept-image flow the builder's AI image slots use.
 */

export interface PptTemplate {
  id: string;
  name: string;
  brand: string | null;
  r2_key: string;
  version: number;
  layout_map: Record<string, string>;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PptPlaceholder {
  idx: number;
  type: string;
  name: string;
  xEmu: number;
  yEmu: number;
  wEmu: number;
  hEmu: number;
}

export interface PptTemplateLayout {
  index: number;
  name: string;
  placeholders: PptPlaceholder[];
}

export interface PptIntrospection {
  ok: boolean;
  slideWidthEmu?: number;
  slideHeightEmu?: number;
  layouts?: PptTemplateLayout[];
  suggestedMap?: Record<string, string>;
  error?: { code: string; message: string };
}

export async function listPptTemplates(): Promise<PptTemplate[]> {
  const res = await api<{ templates: PptTemplate[] }>("/api/ppt/templates");
  return res.templates;
}

const BASE = import.meta.env.VITE_API_BASE_URL ?? "";

/**
 * Authenticated multipart POST. `api()` force-sets `content-type:
 * application/json` on bodies, which would strip the multipart boundary, so
 * FormData requests go through this sibling instead.
 */
export async function apiForm<T>(path: string, form: FormData): Promise<T> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${BASE}${path}`, { method: "POST", body: form, headers });
  const ct = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    let body: unknown = await res.text();
    if (ct.includes("application/json")) {
      try {
        body = JSON.parse(body as string);
      } catch {
        // keep text
      }
    }
    throw {
      status: res.status,
      error:
        typeof body === "object" && body && "error" in body
          ? String((body as { error: unknown }).error)
          : String(body),
    } satisfies ApiError;
  }
  return (await res.json()) as T;
}

/** Human labels for the canonical deck layouts. */
export const PPT_LAYOUT_LABELS: Record<PptLayout, string> = {
  title: "Title",
  title_content: "Title + Content",
  two_column: "Two Column",
  image_full: "Full Image",
  image_caption: "Image + Caption",
  table: "Table",
  section: "Section",
};

/** "Layout Name — title, body, picture" labels for the mapping selects. */
export function describeTemplateLayout(layout: PptTemplateLayout): string {
  const types = [...new Set(layout.placeholders.map((p) => p.type))];
  return types.length > 0 ? `${layout.name} — ${types.join(", ")}` : layout.name;
}

export function newSlide(layout: PptLayout): PptSlide {
  return { id: crypto.randomUUID(), layout, fields: {} };
}

/**
 * Generate a concept image for a deck image slot (the same appimage job the
 * Image Generator page runs), then re-upload the result through /api/uploads.
 * Asset file downloads require an Authorization header, but deck image URLs
 * must be plain-HTTPS fetchable by the generation Container — the uploads
 * bucket is exactly that (unguessable public URLs), so it's the canonical
 * place for deck-bound bytes.
 */
export async function generateConceptImage(prompt: string): Promise<string> {
  const params = {
    version: APPIMAGE_PARAMS_VERSION,
    mode: "concept",
    prompt,
    referenceImages: [],
    output: { format: "png" },
  };
  const { jobId } = await createJob("appimage", "Deck image concept", params, [
    "concept",
  ]);
  const job = await pollJob(jobId);
  if (job.status !== "succeeded" || !job.assetId) {
    throw new Error(job.error ?? "image generation failed");
  }
  const blob = await apiBlob(`/api/assets/${job.assetId}/files/png`);
  const file = new File([blob], "deck-image.png", { type: "image/png" });
  const { url } = await uploadImage(file);
  return url;
}

export function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}
