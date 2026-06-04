import { api } from "./api.js";

/**
 * Upload an image (scene background or concept reference) to R2 via the API and
 * get back a public HTTPS URL the generation Container can fetch. The bytes are
 * sent raw with the file's content-type; see apps/api/src/routes/uploads.ts.
 */
export async function uploadImage(file: File): Promise<{ url: string }> {
  return api<{ url: string }>("/api/uploads", {
    method: "POST",
    headers: { "content-type": file.type },
    body: file,
  });
}

const ALLOWED = ["image/png", "image/jpeg", "image/webp"];

export function isAllowedImageType(file: File): boolean {
  return ALLOWED.includes(file.type);
}
