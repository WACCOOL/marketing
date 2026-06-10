import { AssetGallery } from "./Library.js";

/**
 * Final Images — the image-generation gallery: everything produced by the
 * Image Generation tools (3D App-Shot, Cam Solve, Image Generator), with
 * download links and "Edit" to reopen a render in its editor. The full
 * cross-tool Asset Library is admin-only.
 */
export function FinalImages() {
  return (
    <AssetGallery
      title="Final Images"
      blurb="Every image generated in this app — 3D App-Shots, Cam Solve renders, and Image Generator outputs. Download any format, or hit Edit to reopen a render with its fixture, background, and settings restored."
      tool="appimage"
    />
  );
}
