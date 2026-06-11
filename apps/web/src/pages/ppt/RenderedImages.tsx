import { PPT_IMAGE_TAG } from "@wac/shared";
import { AssetGallery } from "../Library.js";

/**
 * Rendered Images — images generated for deck image slots (the Deck Builder's
 * AI image generation). They ride the normal image pipeline but are tagged
 * `ppt-image` so they live here instead of cluttering the Image Generation
 * section's Final Images.
 */
export function PptRenderedImages() {
  return (
    <AssetGallery
      title="Rendered Images"
      blurb="Images generated for deck image slots in the Deck Builder. Final renders from the Image Generation tools live under Final Images instead."
      tool="appimage"
      tag={PPT_IMAGE_TAG}
    />
  );
}
