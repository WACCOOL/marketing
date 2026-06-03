import { useState } from "react";
import type { Product } from "@wac/shared";
import { ProductPicker } from "../components/ProductPicker.js";
import { useAuth } from "../lib/auth.js";
import { syncProducts, formatDimensions } from "../lib/products.js";

export function Products() {
  const { user } = useAuth();
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Product | null>(null);

  async function onSync() {
    setSyncing(true);
    setMsg(null);
    setErr(null);
    try {
      await syncProducts();
      setMsg(
        "Sync started in the background. The catalog is large, so it may take a minute or two — reload the page to see refreshed products.",
      );
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2>Products</h2>
          <div className="muted">
            Authoritative fixtures from the Sales Layer catalog — SKU, name,
            dimensions (mm), and imagery at the product and variant level. These
            power the upcoming Application Image generator.
          </div>
        </div>
        {user?.role === "admin" && (
          <button onClick={() => void onSync()} disabled={syncing}>
            {syncing ? <span className="spinner" /> : null}
            Sync from Sales Layer
          </button>
        )}
      </div>

      {msg && <div className="alert good">{msg}</div>}
      {err && <div className="alert error">{err}</div>}

      <ProductPicker onSelect={setSelected} selectedSku={selected?.sku ?? null} />

      {selected && (
        <ProductDetail product={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function ProductDetail({
  product,
  onClose,
}: {
  product: Product;
  onClose: () => void;
}) {
  return (
    <div className="card col" style={{ gap: 16 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h3 style={{ margin: 0 }}>{product.name}</h3>
          <div className="muted product-sku">{product.sku}</div>
          <div className="muted" style={{ marginTop: 4 }}>
            {product.category ?? "Uncategorized"} ·{" "}
            {formatDimensions(product.dimensions_mm)} · {product.variants.length}{" "}
            variant{product.variants.length === 1 ? "" : "s"} ·{" "}
            {product.image_urls.length} image
            {product.image_urls.length === 1 ? "" : "s"}
          </div>
        </div>
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>

      <div>
        <label>All images (product + variants)</label>
        <ImageStrip urls={product.image_urls} />
      </div>

      {product.variants.length > 0 && (
        <div className="col" style={{ gap: 10 }}>
          <label>Variants</label>
          <table>
            <thead>
              <tr>
                <th>Variant / SKU</th>
                <th>Finish</th>
                <th>Dimensions</th>
                <th>Images</th>
              </tr>
            </thead>
            <tbody>
              {product.variants.map((v) => (
                <tr key={v.variant_id}>
                  <td>
                    <div>{v.sku ?? v.variant_id}</div>
                    {v.name ? <div className="muted">{v.name}</div> : null}
                  </td>
                  <td>{v.finish ?? "—"}</td>
                  <td className="muted">{formatDimensions(v.dimensions_mm)}</td>
                  <td>
                    <ImageStrip urls={v.image_urls} small />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ImageStrip({ urls, small }: { urls: string[]; small?: boolean }) {
  if (urls.length === 0) return <span className="muted">none</span>;
  const size = small ? 48 : 88;
  return (
    <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
      {urls.map((u) => (
        <a key={u} href={u} target="_blank" rel="noreferrer" title={u}>
          <img
            src={u}
            alt=""
            loading="lazy"
            style={{
              width: size,
              height: size,
              objectFit: "contain",
              background: "white",
              borderRadius: 6,
              border: "1px solid var(--border)",
            }}
          />
        </a>
      ))}
    </div>
  );
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}
