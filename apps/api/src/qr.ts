import QRCode from "qrcode";

/**
 * Server-side QR rendering for bulk + social fan-out paths.
 *
 * Uses node-qrcode to compute the module matrix (DOM-free, no <canvas>), then
 * encodes the SVG + a PNG ourselves. We cannot use `QRCode.toBuffer` here: on
 * Cloudflare Workers the package resolves to its browser build, which has no
 * Node `Buffer`/stream pipeline and therefore no `toBuffer`. Instead we encode
 * a grayscale PNG by hand using the WHATWG `CompressionStream` (zlib) that the
 * Workers runtime provides.
 */
export interface RenderedQr {
  svg: string;
  png: Uint8Array;
}

export async function renderQr(data: string): Promise<RenderedQr> {
  const svg = await QRCode.toString(data, {
    type: "svg",
    errorCorrectionLevel: "H",
    margin: 2, // quiet zone
    color: { dark: "#000000", light: "#ffffff" },
  });

  const png = await renderQrPng(data);

  return { svg, png };
}

/** Render a QR as a grayscale PNG without any Node/canvas dependency. */
async function renderQrPng(
  data: string,
  opts: { targetSize?: number; margin?: number } = {},
): Promise<Uint8Array> {
  const qr = QRCode.create(data, { errorCorrectionLevel: "H" });
  const size = qr.modules.size;
  const matrix = qr.modules.data; // 1 = dark module, 0 = light

  const margin = opts.margin ?? 4; // quiet zone, in modules
  const target = opts.targetSize ?? 512;
  const dim = size + margin * 2; // total modules per side incl. quiet zone
  const scale = Math.max(2, Math.floor(target / dim)); // pixels per module
  const px = dim * scale; // final image side in pixels

  // PNG raw image data: one filter byte (0 = none) per scanline, then `px`
  // grayscale bytes. We build one scanline per module-row and blit it `scale`
  // times — keeps the hot loop small enough for the Workers CPU budget.
  const stride = px + 1;
  const raw = new Uint8Array(stride * px);

  const colModule = new Int32Array(px);
  for (let x = 0; x < px; x++) colModule[x] = Math.floor(x / scale) - margin;

  let y = 0;
  const line = new Uint8Array(px);
  for (let myPix = 0; myPix < dim; myPix++) {
    const my = myPix - margin;
    for (let x = 0; x < px; x++) {
      const mx = colModule[x]!;
      let dark = false;
      if (my >= 0 && my < size && mx >= 0 && mx < size) {
        dark = matrix[my * size + mx] === 1;
      }
      line[x] = dark ? 0x00 : 0xff;
    }
    for (let s = 0; s < scale; s++) {
      const rowStart = y * stride;
      raw[rowStart] = 0; // filter type: none
      raw.set(line, rowStart + 1);
      y++;
    }
  }

  const idat = await zlibDeflate(raw);
  return buildPng(px, px, idat);
}

/** Compress with the Workers-native zlib (RFC 1950) stream — what PNG IDAT wants. */
async function zlibDeflate(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  void writer.write(input);
  void writer.close();

  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concatBytes(chunks);
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function buildPng(width: number, height: number, idat: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  return concatBytes([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  // CRC covers the type bytes + data.
  const crc = crc32(out.subarray(4, 8 + data.length));
  dv.setUint32(8 + data.length, crc >>> 0);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
