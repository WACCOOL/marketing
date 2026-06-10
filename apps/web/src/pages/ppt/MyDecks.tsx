import { AssetGallery } from "../Library.js";

/**
 * My Decks: the asset gallery scoped to PPT exports. Edit links re-open a deck
 * in the builder via /ppt/builder?restore=<jobId> (see editHref in Library.tsx).
 */
export function MyDecks() {
  return (
    <AssetGallery
      title="My Decks"
      blurb="Exported presentations, scoped to your visibility. Edit re-opens a deck in the builder."
      tool="ppt"
    />
  );
}
