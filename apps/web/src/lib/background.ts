import type { GeminiAspectRatio, RenderQuality } from "@wac/shared";

/**
 * Cam Solve background plate generation.
 *
 * Cam Solve stages a fixture over a plain backdrop instead of a room. We reuse
 * the entire 3D App-Shot pipeline by generating that backdrop as a normal scene
 * image (a PNG) client-side, uploading it, and feeding it in as the `sceneUrl`.
 * Transparent plates carry a real alpha channel so the clean render styles can
 * preserve transparency all the way to the exported PNG/PSD.
 */

export type BackgroundKind = "transparent" | "color";

export interface BackgroundChoice {
  kind: BackgroundKind;
  /** Hex color (#rrggbb) when kind === "color". */
  color?: string;
}

/** Named presets surfaced as swatches in the UI. */
export const BACKGROUND_PRESETS: { id: string; label: string; choice: BackgroundChoice }[] = [
  { id: "transparent", label: "Transparent", choice: { kind: "transparent" } },
  { id: "black", label: "Black", choice: { kind: "color", color: "#000000" } },
  { id: "white", label: "White", choice: { kind: "color", color: "#ffffff" } },
  { id: "grey", label: "Grey", choice: { kind: "color", color: "#808080" } },
];

/**
 * Plate long-edge (px) for a quality tier. For the clean-cutout render styles
 * the output is exactly the plate size, so this is the resolution lever there:
 * a bigger plate = a bigger, crisper final on the colored/transparent backdrop.
 */
export function plateLongEdge(quality: RenderQuality | undefined): number {
  switch (quality) {
    case "draft":
      return 1536;
    case "high":
      return 3072;
    case "max":
      return 4096;
    case "standard":
    default:
      return 2048;
  }
}

/** Pixel dimensions for an aspect ratio at the given long edge. */
function dimsForAspect(
  aspect: GeminiAspectRatio,
  longEdge: number,
): { width: number; height: number } {
  const LONG = longEdge;
  switch (aspect) {
    case "16:9":
      return { width: LONG, height: Math.round((LONG * 9) / 16) };
    case "3:2":
      return { width: LONG, height: Math.round((LONG * 2) / 3) };
    case "4:3":
      return { width: LONG, height: Math.round((LONG * 3) / 4) };
    case "1:1":
    default:
      return { width: LONG, height: LONG };
  }
}

/** True for a well-formed #rgb or #rrggbb hex string. */
export function isHexColor(value: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

/**
 * Render the chosen background to a PNG `File` (alpha preserved for transparent),
 * ready to hand to `uploadImage`. Returns a stable filename so the upload's
 * content-type is unambiguous.
 */
export async function makeBackgroundPlate(req: {
  choice: BackgroundChoice;
  aspect: GeminiAspectRatio;
  /** Long-edge in px (defaults to the `standard` tier's 2K plate). */
  longEdge?: number;
}): Promise<File> {
  const { width, height } = dimsForAspect(req.aspect, req.longEdge ?? 2048);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not create a drawing canvas");

  if (req.choice.kind === "color") {
    const color = req.choice.color ?? "#808080";
    if (!isHexColor(color)) throw new Error(`invalid hex color: ${color}`);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
  }
  // Transparent: leave the canvas cleared (alpha 0).

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("could not encode the background image");
  return new File([blob], "camsolve-background.png", { type: "image/png" });
}
