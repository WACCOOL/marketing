import { api } from "./api.js";

/**
 * Overwrite a saved asset's image with new bytes (used by the crop-before-save
 * step). The server replaces the R2 object in place, so the asset id/format and
 * any existing links stay stable.
 */
export async function replaceAssetFile(
  assetId: string,
  format: string,
  blob: Blob,
): Promise<{ ok: true }> {
  return api<{ ok: true }>(`/api/assets/${assetId}/files/${format}`, {
    method: "POST",
    body: blob,
    headers: { "content-type": blob.type || "image/png" },
  });
}
