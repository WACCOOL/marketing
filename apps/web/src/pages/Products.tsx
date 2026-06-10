import { Fragment, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { syncProducts, formatDimensions } from "../lib/products.js";

/**
 * Products hub — the window into the PIM, browsed family-first: pick a family
 * (e.g. CALLIOPE) to see its nested product pages (PPIDs), then a product to
 * see the full overview — imagery, attributes, variants, plus the marketing
 * layer (romance copy, SEO, normalized data) with jump links into the
 * editors. Searching by name/SKU cuts across families directly.
 */

interface FamilyEntry {
  family: string;
  count: number;
  brands: string[];
  image: string | null;
}

interface CatalogVariant {
  variant_id: string;
  sku: string | null;
  finish: string | null;
  name: string | null;
  dimensions_mm: Record<string, number>;
  image_urls: string[];
}

interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  category: string | null;
  family: string | null;
  is_accessory: boolean;
  dimensions_mm: Record<string, number>;
  primary_image_url: string | null;
  image_urls: string[];
  variants: CatalogVariant[];
}

export function Products() {
  const { user } = useAuth();
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [familyQ, setFamilyQ] = useState("");
  const [families, setFamilies] = useState<FamilyEntry[]>([]);
  const [noFamilyCount, setNoFamilyCount] = useState(0);
  const [selectedFamily, setSelectedFamily] = useState<string | null>(null);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [productsTotal, setProductsTotal] = useState(0);
  const [searchQ, setSearchQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [showAccessories, setShowAccessories] = useState(false);
  const [selected, setSelected] = useState<CatalogProduct | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadFamilies() {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      if (showAccessories) params.set("accessories", "include");
      const res = await api<{ families: FamilyEntry[]; noFamilyCount: number }>(
        `/api/products/families?${params}`,
      );
      setFamilies(res.families);
      setNoFamilyCount(res.noFamilyCount);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void loadFamilies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAccessories]);

  async function loadProducts(opts: { family?: string; q?: string }) {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (opts.family) params.set("family", opts.family);
      if (opts.q) params.set("q", opts.q);
      if (!showAccessories) params.set("accessories", "hide");
      const res = await api<{ products: CatalogProduct[]; total: number }>(
        `/api/products?${params}`,
      );
      setProducts(res.products);
      setProductsTotal(res.total);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setLoading(false);
    }
  }

  function openFamily(family: string) {
    setSelectedFamily(family);
    setSearching(false);
    setSelected(null);
    void loadProducts({ family });
  }

  function runSearch() {
    if (!searchQ.trim()) {
      setSearching(false);
      return;
    }
    setSearching(true);
    setSelectedFamily(null);
    setSelected(null);
    void loadProducts({ q: searchQ.trim() });
  }

  function backToFamilies() {
    setSelectedFamily(null);
    setSearching(false);
    setSelected(null);
  }

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

  const browsing = searching || selectedFamily !== null;

  return (
    <div className="col" style={{ gap: 20 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2>Products</h2>
          <div className="muted">
            Your window into the PIM, browsed by family. Pick a family to see
            its product pages (PPIDs), then a product for the full overview —
            attributes, variants, romance copy, SEO, and normalized data, with
            links into the editors.
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

      <div className="card row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input
          placeholder="Search any product, SKU, or model number…"
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") runSearch();
          }}
          style={{ flex: 2, minWidth: 220 }}
        />
        <button onClick={runSearch} disabled={loading}>
          {loading ? <span className="spinner" /> : null}
          Search products
        </button>
        <input
          placeholder="Filter families…"
          value={familyQ}
          onChange={(e) => setFamilyQ(e.target.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <label className="row" style={{ gap: 6, alignItems: "center", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={showAccessories}
            onChange={(e) => setShowAccessories(e.target.checked)}
            style={{ width: "auto" }}
          />
          Show accessories
        </label>
        {browsing && (
          <button className="secondary" onClick={backToFamilies}>
            ← All families
          </button>
        )}
      </div>

      {!browsing && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th style={{ width: 56 }} />
                <th>Family</th>
                <th>Brands</th>
                <th>Product pages</th>
              </tr>
            </thead>
            <tbody>
              {families
                .filter(
                  (f) =>
                    !familyQ.trim() ||
                    f.family.toLowerCase().includes(familyQ.trim().toLowerCase()),
                )
                .map((f) => (
                  <tr key={f.family} onClick={() => openFamily(f.family)} style={{ cursor: "pointer" }}>
                    <td>
                      {f.image ? (
                        <img
                          src={f.image}
                          alt=""
                          loading="lazy"
                          style={{ width: 48, height: 48, objectFit: "contain", background: "#fff", borderRadius: 4 }}
                        />
                      ) : (
                        <div style={{ width: 48, height: 48 }} />
                      )}
                    </td>
                    <td>{f.family}</td>
                    <td className="muted">{f.brands.join(", ")}</td>
                    <td>{f.count}</td>
                  </tr>
                ))}
              {noFamilyCount > 0 && !familyQ.trim() && (
                <tr onClick={() => openFamily("__none")} style={{ cursor: "pointer" }}>
                  <td />
                  <td className="muted">No family assigned</td>
                  <td />
                  <td>{noFamilyCount}</td>
                </tr>
              )}
              {families.length === 0 && !loading && (
                <tr>
                  <td colSpan={4} className="muted">
                    No families found. (Families come from the PIM — sync
                    products if this list is empty.)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {browsing && (
        <div className="card">
          <div className="muted" style={{ marginBottom: 8 }}>
            {searching
              ? `${productsTotal} result${productsTotal === 1 ? "" : "s"} for "${searchQ.trim()}"`
              : selectedFamily === "__none"
                ? `${productsTotal} products without a family`
                : `${selectedFamily} — ${productsTotal} product page${productsTotal === 1 ? "" : "s"}`}
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ width: 56 }} />
                <th>Product</th>
                <th>PPID</th>
                <th>Brand</th>
                <th>Category</th>
                <th>Variants</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setSelected(selected?.sku === p.sku ? null : p)}
                  style={{
                    cursor: "pointer",
                    ...(selected?.sku === p.sku ? { background: "var(--panel)" } : {}),
                  }}
                >
                  <td>
                    {p.primary_image_url ? (
                      <img
                        src={p.primary_image_url}
                        alt=""
                        loading="lazy"
                        style={{ width: 48, height: 48, objectFit: "contain", background: "#fff", borderRadius: 4 }}
                      />
                    ) : (
                      <div style={{ width: 48, height: 48 }} />
                    )}
                  </td>
                  <td>
                    {p.name}
                    {p.is_accessory && (
                      <span className="tag" style={{ marginLeft: 6 }}>
                        accessory
                      </span>
                    )}
                  </td>
                  <td className="muted">{p.sku}</td>
                  <td className="muted">{p.brand ?? "—"}</td>
                  <td className="muted">{p.category ?? "—"}</td>
                  <td>{p.variants.length}</td>
                </tr>
              ))}
              {products.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="muted">
                    No products match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <ProductDetail product={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

interface OverviewContentRow {
  id: string;
  ppid: string;
  sku: string;
  field: string;
  existing_value: string | null;
  ai_value: string | null;
  approved_value: string | null;
  status: string;
  flagged: boolean;
}

interface OverviewDetails {
  attributes: { label: string; value: string }[];
  features: string[];
  existing: {
    romance_copy: string | null;
    seo_title: string | null;
    seo_meta_description: string | null;
  };
}

/** The PIM + marketing-content overview for one PPID, with jump links into
 * the Romance / SEO / Normalization editors. Internal users only (the API
 * refuses reps; the section simply hides for them). */
function MarketingOverview({ ppid }: { ppid: string }) {
  const { user } = useAuth();
  const [details, setDetails] = useState<OverviewDetails | null>(null);
  const [content, setContent] = useState<OverviewContentRow[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (user?.role === "rep") return;
    let cancelled = false;
    setDetails(null);
    setFailed(false);
    api<{ details: OverviewDetails; content: OverviewContentRow[] }>(
      `/api/product-info/overview/${encodeURIComponent(ppid)}`,
    )
      .then((res) => {
        if (cancelled) return;
        setDetails(res.details);
        setContent(res.content);
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [ppid, user?.role]);

  if (user?.role === "rep" || failed) return null;

  const page = (field: string) => content.find((r) => r.field === field && r.sku === "");
  const value = (field: string) => {
    const r = page(field);
    return r?.approved_value ?? r?.ai_value ?? null;
  };
  const statusOf = (field: string) => page(field)?.status ?? "none";
  const romance = value("romance_copy") ?? details?.existing.romance_copy ?? null;
  const seoRows: [string, string][] = [
    ["Title tag", "seo_title"],
    ["Meta description", "seo_meta_description"],
    ["H1", "h1"],
    ["URL slug", "url_slug"],
    ["Canonical", "canonical_url"],
    ["og:title", "og_title"],
    ["og:description", "og_description"],
  ];
  const normRows: [string, string][] = [
    ["CCT", "cct"],
    ["CCT Type", "cct_type"],
    ["Beam", "beam"],
    ["Input voltage", "voltage"],
  ];

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div className="col" style={{ flex: 1, minWidth: 280, gap: 6 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <label>Romance copy ({statusOf("romance_copy").replace("_", " ")})</label>
            <Link to={`/product-info/romance?ppid=${encodeURIComponent(ppid)}`}>Edit</Link>
          </div>
          {romance ? (
            <p className="muted" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{romance}</p>
          ) : (
            <span className="muted">None yet — existing PIM copy and AI drafts appear here.</span>
          )}
          {details && details.attributes.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 10px", fontSize: 13, marginTop: 6 }}>
              {details.attributes.slice(0, 10).map((a) => (
                <Fragment key={a.label}>
                  <span className="muted">{a.label}</span>
                  <span>{a.value}</span>
                </Fragment>
              ))}
            </div>
          )}
        </div>
        <div className="col" style={{ flex: 1, minWidth: 280, gap: 6 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <label>SEO</label>
            <Link to={`/product-info/seo?ppid=${encodeURIComponent(ppid)}`}>Edit</Link>
          </div>
          <table>
            <tbody>
              {seoRows.map(([label, field]) => (
                <tr key={field}>
                  <td className="muted" style={{ whiteSpace: "nowrap", fontSize: 12 }}>{label}</td>
                  <td style={{ fontSize: 12, wordBreak: "break-word" }}>
                    {value(field) ?? <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <label>Normalized data</label>
            <Link to={`/product-info/normalization?ppid=${encodeURIComponent(ppid)}`}>Edit</Link>
          </div>
          <table>
            <tbody>
              {normRows.map(([label, field]) => {
                const row = page(field);
                return (
                  <tr key={field}>
                    <td className="muted" style={{ whiteSpace: "nowrap", fontSize: 12 }}>{label}</td>
                    <td style={{ fontSize: 12 }}>
                      {row?.approved_value ?? row?.ai_value ?? <span className="muted">—</span>}
                      {row?.flagged && <span style={{ color: "var(--bad)" }}> ⚑</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ProductDetail({
  product,
  onClose,
}: {
  product: CatalogProduct;
  onClose: () => void;
}) {
  return (
    <div className="card col" style={{ gap: 16 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h3 style={{ margin: 0 }}>{product.name}</h3>
          <div className="muted product-sku">
            PPID {product.sku}
            {product.family ? ` · ${product.family}` : ""}
          </div>
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

      <MarketingOverview ppid={product.sku} />

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
