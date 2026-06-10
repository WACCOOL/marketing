import { useState } from "react";
import type { Product } from "@wac/shared";
import { ProductPicker } from "../../components/ProductPicker.js";
import { isAllowedImageType, uploadImage } from "../../lib/uploads.js";
import { formatErr, generateConceptImage } from "./lib.js";

/**
 * Source picker for a deck image slot: a catalog product image, an upload, or
 * an inline AI concept generation. Every path resolves to an absolute HTTPS
 * URL the generation Container can fetch without auth (catalog CDN URLs or
 * /api/uploads public URLs — see generateConceptImage in ./lib.ts).
 */

type Tab = "product" | "upload" | "ai";

export function ImageSlotPicker(props: {
  onAdd: (img: { url: string; aiPrompt?: string }) => void;
}) {
  const [tab, setTab] = useState<Tab>("product");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Product tab
  const [product, setProduct] = useState<Product | null>(null);

  // AI tab
  const [prompt, setPrompt] = useState("");

  async function handleUpload(file: File) {
    if (!isAllowedImageType(file)) {
      setErr("Use a PNG, JPEG, or WebP image.");
      return;
    }
    setBusy(true);
    setErr(null);
    setStatus("Uploading…");
    try {
      const { url } = await uploadImage(file);
      props.onAdd({ url });
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  async function generate() {
    if (!prompt.trim()) {
      setErr("Describe the image to generate.");
      return;
    }
    setBusy(true);
    setErr(null);
    setStatus("Generating…");
    try {
      const url = await generateConceptImage(prompt.trim());
      props.onAdd({ url, aiPrompt: prompt.trim() });
      setPrompt("");
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  const productImages = product
    ? [
        ...new Set(
          [product.primary_image_url, ...product.image_urls].filter(
            (u): u is string => !!u,
          ),
        ),
      ]
    : [];

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 6 }}>
        {(["product", "upload", "ai"] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t ? "" : "secondary"}
            onClick={() => setTab(t)}
          >
            {t === "product" ? "Product" : t === "upload" ? "Upload" : "AI"}
          </button>
        ))}
      </div>

      {err && <div className="alert error">{err}</div>}

      {tab === "product" && (
        <div className="col" style={{ gap: 10 }}>
          {product ? (
            <>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{product.name}</strong>
                <button className="secondary" onClick={() => setProduct(null)}>
                  Change product
                </button>
              </div>
              {productImages.length === 0 ? (
                <div className="muted">This product has no images.</div>
              ) : (
                <>
                  <div className="muted" style={{ fontSize: 12 }}>
                    Pick an image to add to the slide.
                  </div>
                  <div className="ppt-image-options">
                    {productImages.map((url) => (
                      <button
                        key={url}
                        type="button"
                        className="ppt-image-option"
                        onClick={() => props.onAdd({ url })}
                        title="Add this image"
                      >
                        <img src={url} alt="" loading="lazy" />
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <ProductPicker onSelect={setProduct} selectedSku={null} />
          )}
        </div>
      )}

      {tab === "upload" && (
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUpload(f);
              e.target.value = "";
            }}
          />
          {busy && (
            <span className="muted">
              <span className="spinner" /> {status}
            </span>
          )}
        </div>
      )}

      {tab === "ai" && (
        <div className="col" style={{ gap: 8 }}>
          <textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. A bright modern kitchen with warm pendant lighting over the island…"
          />
          <div className="row" style={{ gap: 8 }}>
            <button onClick={() => void generate()} disabled={busy}>
              {busy ? <span className="spinner" /> : null}
              {busy ? status ?? "Generating…" : "Generate image"}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              AI concept images also save to Final Images.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
