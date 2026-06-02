import QRCode from "qrcode";

/**
 * Server-side QR rendering for bulk + social fan-out paths.
 *
 * Uses node-qrcode, which is DOM-free (no <canvas>): emits an SVG string and
 * a raw PNG buffer that we can write straight to R2. This is the deliberate
 * split from the interactive single-link UI, which uses qr-code-styling
 * client-side for live preview.
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

  const pngBuffer = await QRCode.toBuffer(data, {
    type: "png",
    errorCorrectionLevel: "H",
    margin: 2,
    width: 1024,
    color: { dark: "#000000", light: "#ffffff" },
  });

  return { svg, png: new Uint8Array(pngBuffer) };
}
