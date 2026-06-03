import sharp from "sharp";

/**
 * Image fetch with guards (Phase 2c). Used for both the scene background and the
 * Sales Layer CDN cutouts. Enforces https-only, an image content-type, a max-byte
 * cap (so a bad URL can't stream gigabytes into memory), and a request timeout.
 * It also decodes metadata up front so callers can enforce the cutout-must-have-
 * alpha contract before compositing.
 */

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const DEFAULT_TIMEOUT_MS = 20_000;

export interface FetchImageOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

export interface FetchedImage {
  buffer: Buffer;
  /** Response content-type header, if present. */
  contentType: string | null;
  /** Decoded format reported by sharp (e.g. "png", "jpeg"). */
  format: string | undefined;
  /** True only when the image carries a real alpha channel. */
  hasAlpha: boolean;
  width: number | undefined;
  height: number | undefined;
}

async function readWithCap(
  res: Response,
  maxBytes: number,
  url: string,
): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`image exceeds maxBytes (${maxBytes}): ${url}`);
    }
    return buf;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`image exceeds maxBytes (${maxBytes}): ${url}`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

export async function fetchImageBuffer(
  url: string,
  opts: FetchImageOptions = {},
): Promise<FetchedImage> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid image URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`image URL must use https (got ${parsed.protocol}): ${url}`);
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "image/*" },
  });
  if (!res.ok) {
    throw new Error(`fetch failed ${res.status} ${res.statusText}: ${url}`);
  }

  const contentType = res.headers.get("content-type");
  if (contentType && !contentType.toLowerCase().startsWith("image/")) {
    throw new Error(
      `URL did not return an image (content-type: ${contentType}): ${url}`,
    );
  }
  const lenHeader = res.headers.get("content-length");
  if (lenHeader && Number(lenHeader) > maxBytes) {
    throw new Error(`image exceeds maxBytes (${maxBytes}): ${url}`);
  }

  const buffer = await readWithCap(res, maxBytes, url);

  let meta: sharp.Metadata;
  try {
    meta = await sharp(buffer).metadata();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`could not decode image at ${url}: ${msg}`);
  }

  return {
    buffer,
    contentType,
    format: meta.format,
    hasAlpha: Boolean(meta.hasAlpha),
    width: meta.width,
    height: meta.height,
  };
}
