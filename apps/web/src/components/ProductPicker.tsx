import { useEffect, useRef, useState } from "react";
import type { Product } from "@wac/shared";
import { useProducts, formatDimensions } from "../lib/products.js";

interface ProductPickerProps {
  /** Called when a product card is clicked. Omit for a read-only browser. */
  onSelect?: (product: Product) => void;
  /** SKU of the currently selected product, for highlight. */
  selectedSku?: string | null;
}

/**
 * Reusable Sales Layer product search + result grid. Standalone on the Products
 * page today; designed to drop into the Phase 2 Application Image Generator as
 * the fixture picker (pass onSelect / selectedSku).
 */
export function ProductPicker({ onSelect, selectedSku }: ProductPickerProps) {
  const { products, total, query, setQuery, search, loading, err } =
    useProducts();

  // Debounce search-as-you-type so we don't fire a request per keystroke.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, setPending] = useState(query);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      setQuery(pending);
      void search(pending);
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="card row">
        <input
          placeholder="Search by SKU or name…"
          value={pending}
          onChange={(e) => setPending(e.target.value)}
        />
        {loading ? <span className="spinner" /> : null}
        <span className="muted" style={{ whiteSpace: "nowrap" }}>
          {total} product{total === 1 ? "" : "s"}
        </span>
      </div>

      {err && <div className="alert error">{err}</div>}

      <div className="product-grid">
        {products.map((p) => (
          <button
            key={p.id}
            type="button"
            className={
              "product-card" + (selectedSku === p.sku ? " selected" : "")
            }
            onClick={() => onSelect?.(p)}
            // A read-only browser shouldn't look clickable.
            style={onSelect ? undefined : { cursor: "default" }}
          >
            <div className="product-thumb">
              {p.primary_image_url ? (
                <img src={p.primary_image_url} alt={p.name} loading="lazy" />
              ) : (
                <span className="muted">no image</span>
              )}
            </div>
            <div className="product-meta">
              <div className="product-name" title={p.name}>
                {p.name}
              </div>
              <div className="muted product-sku">{p.sku}</div>
              <div className="muted product-dims">
                {formatDimensions(p.dimensions_mm)}
              </div>
              {p.category ? <span className="tag">{p.category}</span> : null}
            </div>
          </button>
        ))}
      </div>

      {!loading && products.length === 0 && (
        <div className="muted">
          No products found. {query ? "Try a different search." : null} If the
          catalog looks empty, an admin may need to run a Sales Layer sync.
        </div>
      )}
    </div>
  );
}
