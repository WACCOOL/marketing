import { AssetGallery } from "../Library.js";

/**
 * My Decks: the asset gallery scoped to PPT exports. Edit re-opens a deck in
 * the builder via /ppt/builder?restore=<jobId> (exports then update it in
 * place); Clone opens an unlinked copy via ?clone=<jobId> (see editHref /
 * cloneHref in Library.tsx).
 */
export function MyDecks() {
  return (
    <AssetGallery
      title="My Decks"
      blurb="Exported presentations, scoped to your visibility. Edit re-opens a deck in the builder (exports update it in place); Clone starts a copy."
      tool="ppt"
    />
  );
}
