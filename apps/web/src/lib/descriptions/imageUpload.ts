import { apiForm } from "../api.js";

/**
 * Image normalisation + upload (plan Stage 2): every extracted image is
 * downscaled to <= 1600px JPEG on a canvas in the browser, then uploaded to
 * the Worker which content-hashes it into descriptions/img/{slot}/. Retries
 * and re-imports are idempotent because identical bytes produce the same key
 * (the Worker dedups on an existing hash).
 */

const MAX_DIM = 1600;
const JPEG_QUALITY = 0.85;

export function mimeForMediaPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      // emf/wmf/wdp etc — createImageBitmap will fail and the caller warns.
      return "application/octet-stream";
  }
}

/** Downscale to JPEG; null when the browser cannot decode the format. */
export async function downscaleToJpeg(
  bytes: Uint8Array,
  mime: string,
  maxDim = MAX_DIM,
): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    const buffer = bytes.slice().buffer as ArrayBuffer;
    bitmap = await createImageBitmap(new Blob([buffer], { type: mime }));
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // JPEG has no alpha — matte transparent renders onto white.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
  } finally {
    bitmap.close();
  }
}

export interface UploadItem {
  /** Extractor-local id (zip media path or "page-N"). */
  id: string;
  blob: Blob;
}

/**
 * Upload prepared images with 4-way concurrency. Returns id → r2_key for
 * every successful upload; the first failure rejects the whole batch (the
 * import is all-or-nothing per slot).
 */
export async function uploadDescImages(
  slot: string,
  items: UploadItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      const item = items[idx]!;
      const form = new FormData();
      form.append("file", item.blob, "image.jpg");
      const res = await apiForm<{ images: { r2_key: string }[] }>(
        `/api/descriptions/files/${slot}/images`,
        form,
      );
      const key = res.images[0]?.r2_key;
      if (!key) throw new Error("image upload returned no key");
      out.set(item.id, key);
      done++;
      onProgress?.(done, items.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, () => worker()),
  );
  return out;
}
