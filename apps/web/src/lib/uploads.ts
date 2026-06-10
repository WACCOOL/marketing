import { api } from "./api.js";

/**
 * Upload a media file (scene background, concept reference, deck image/video)
 * to R2 via the API and get back a public HTTPS URL the generation Container
 * can fetch. The bytes are sent raw with the file's content-type; see
 * apps/api/src/routes/uploads.ts.
 */
async function uploadFile(file: File): Promise<{ url: string }> {
  return api<{ url: string }>("/api/uploads", {
    method: "POST",
    headers: { "content-type": file.type },
    body: file,
  });
}

export async function uploadImage(file: File): Promise<{ url: string }> {
  return uploadFile(file);
}

const ALLOWED = ["image/png", "image/jpeg", "image/webp"];

export function isAllowedImageType(file: File): boolean {
  return ALLOWED.includes(file.type);
}

/** Deck videos (PPT video layout): /api/uploads also accepts mp4/webm. */
const ALLOWED_VIDEO = ["video/mp4", "video/webm"];

/** Server-side cap for video uploads, mirrored client-side for a fast error. */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export function isAllowedVideoType(file: File): boolean {
  return ALLOWED_VIDEO.includes(file.type);
}

export async function uploadVideo(file: File): Promise<{ url: string }> {
  return uploadFile(file);
}
