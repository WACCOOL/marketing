import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  DESC_MASTER_SLOTS,
  DESC_SLOT_LABELS,
  DESC_STATUS_LABELS,
  DESC_SUPPLEMENT_SLOTS,
  type DescContentStatus,
  type DescMasterSlot,
  type DescSupplementSlot,
  type SizeTuple,
} from "@wac/shared";
import { api, apiBlob, errorMessage } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import {
  commitImport,
  parseMasterFile,
  uploadRawFile,
  type CommitSummary,
  type MasterPhase,
} from "../lib/descriptions/importMaster.js";
import {
  importSupplementFile,
  type SupplementPhase,
  type SupplementSummary,
} from "../lib/descriptions/importSupplement.js";

/**
 * Descriptions (plan Stages 1–2): import the seasonal master lists and the
 * supplemental deck/pdfs in the browser, review the grouped PPID table with
 * thumbnails, lightbox, expanded product panel and the Schonbek tray.
 * Generation, titles and export layer on in later stages.
 */

const XLSX_ACCEPT =
  ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SLOT_ACCEPT: Record<DescSupplementSlot, string> = {
  dweled_pptx:
    ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mf_pdf: ".pdf,application/pdf",
  schonbek_pdf: ".pdf,application/pdf",
};

interface ContentRow {
  id: string;
  slot: string;
  content_key: string;
  description_ai: string | null;
  description_final: string | null;
  meta_ai: string | null;
  meta_final: string | null;
  title_override: string | null;
  status: DescContentStatus;
  note: string | null;
  updated_at: string;
}

interface ImageRow {
  id: string;
  product_id?: string | null;
  slot: string;
  r2_key: string;
  source: string;
  sort_order: number;
}

interface DescRow {
  id: string;
  slot: string;
  brand: string;
  collection: string;
  year: number;
  content_key: string;
  name: string | null;
  family: string | null;
  product_type: string | null;
  diffuser_type: string | null;
  finishes: string[];
  sizes: SizeTuple[];
  cct: string[];
  model_numbers: string[];
  model_bases: string[];
  features: string[];
  attributes: {
    sheetFeatures?: string[];
    romance?: string;
    hierarchy?: string;
    [k: string]: unknown;
  };
  source_rows: number;
  sort_order: number;
  content: ContentRow | null;
  images: ImageRow[];
}

interface SlotMeta {
  slot: string;
  latest: {
    id: string;
    filename: string;
    bytes: number;
    status: string;
    uploaded_at: string;
    committed_at: string | null;
    parse_report: {
      products?: number;
      images?: number;
      units?: number;
      matched?: number;
      unmatched?: { ref: string; name: string | null; reason: string }[];
      warnings?: string[];
    } | null;
    uploaded_by_email: string | null;
  } | null;
}

const STATUS_OPTIONS: DescContentStatus[] = [
  "none",
  "generated",
  "in_review",
  "approved",
];

function statusOf(row: DescRow): DescContentStatus {
  return row.content?.status ?? "none";
}

function statusStyle(status: DescContentStatus): CSSProperties {
  switch (status) {
    case "approved":
      return { color: "var(--good)" };
    case "generated":
    case "in_review":
      return { color: "var(--accent)" };
    default:
      return {};
  }
}

function StatusTag({ status }: { status: DescContentStatus }) {
  return (
    <span className="tag" style={statusStyle(status)}>
      {DESC_STATUS_LABELS[status]}
    </span>
  );
}

/** Render size tuples as per-axis min–max ranges: `26–32 × 5 × 7 in`. */
function sizeRange(sizes: SizeTuple[]): string {
  if (sizes.length === 0) return "—";
  const axis = (pick: (s: SizeTuple) => string | null): string => {
    const raw = sizes.map(pick).filter((v): v is string => !!v);
    if (raw.length === 0) return "—";
    const nums = raw.map((v) => parseFloat(v)).filter((n) => !Number.isNaN(n));
    if (nums.length !== raw.length) {
      // Non-numeric source strings: fall back to the distinct originals.
      return [...new Set(raw)].slice(0, 2).join("/");
    }
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const fmt = (n: number) => String(Math.round(n * 100) / 100);
    return min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`;
  };
  const l = axis((s) => s.length);
  const w = axis((s) => s.width);
  const h = axis((s) => s.height);
  if (l === "—" && w === "—" && h === "—") return "—";
  return `${l} × ${w} × ${h} in`;
}

/** `first +n` truncation with the full list in a tooltip. */
function PlusN({
  values,
  shown = 1,
  mono = false,
}: {
  values: string[];
  shown?: number;
  mono?: boolean;
}) {
  if (values.length === 0) return <span className="muted">—</span>;
  const head = values.slice(0, shown).join(", ");
  const rest = values.length - shown;
  return (
    <span
      title={values.join(", ")}
      className={mono ? "product-sku" : undefined}
      style={mono ? { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 } : undefined}
    >
      {head}
      {rest > 0 && <span className="muted"> +{rest}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Auth-gated image loading (images are never public — unreleased products)
// ---------------------------------------------------------------------------

const imageUrlCache = new Map<string, Promise<string>>();

function useDescImage(r2Key: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!r2Key) return;
    let alive = true;
    let promise = imageUrlCache.get(r2Key);
    if (!promise) {
      promise = apiBlob(`/api/descriptions/images/${r2Key}`).then((blob) =>
        URL.createObjectURL(blob),
      );
      imageUrlCache.set(r2Key, promise);
      promise.catch(() => imageUrlCache.delete(r2Key));
    }
    promise.then((u) => alive && setUrl(u)).catch(() => alive && setUrl(null));
    return () => {
      alive = false;
    };
  }, [r2Key]);
  return r2Key ? url : null;
}

function DescImg({
  r2Key,
  alt,
  className,
  onClick,
}: {
  r2Key: string;
  alt: string;
  className?: string;
  onClick?: () => void;
}) {
  const url = useDescImage(r2Key);
  if (!url) {
    return <span className={`desc-thumb desc-thumb-empty ${className ?? ""}`} />;
  }
  return (
    <img
      src={url}
      alt={alt}
      className={className}
      onClick={onClick}
      loading="lazy"
    />
  );
}

// ---------------------------------------------------------------------------
// Lightbox (←/→ navigation, Esc close)
// ---------------------------------------------------------------------------

interface LightboxState {
  images: ImageRow[];
  index: number;
  title: string;
}

function Lightbox({
  state,
  onClose,
  onIndex,
}: {
  state: LightboxState;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  const { images, index, title } = state;
  const current = images[index] ?? images[0];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onIndex((index + 1) % images.length);
      else if (e.key === "ArrowLeft") onIndex((index - 1 + images.length) % images.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length, onClose, onIndex]);
  if (!current) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal desc-lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <strong>{title}</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            {index + 1} / {images.length} · {current.source}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onClose();
              }}
              style={{ marginLeft: 12 }}
            >
              Close
            </a>
          </span>
        </div>
        <div className="desc-lightbox-main">
          {images.length > 1 && (
            <button
              className="secondary desc-lightbox-nav"
              onClick={() => onIndex((index - 1 + images.length) % images.length)}
              aria-label="Previous image"
            >
              ←
            </button>
          )}
          <DescImg r2Key={current.r2_key} alt={title} className="desc-lightbox-img" />
          {images.length > 1 && (
            <button
              className="secondary desc-lightbox-nav"
              onClick={() => onIndex((index + 1) % images.length)}
              aria-label="Next image"
            >
              →
            </button>
          )}
        </div>
        {images.length > 1 && (
          <div className="desc-lightbox-strip">
            {images.map((img, i) => (
              <DescImg
                key={img.id}
                r2Key={img.r2_key}
                alt={`${title} ${i + 1}`}
                className={`desc-thumb${i === index ? " desc-thumb-active" : ""}`}
                onClick={() => onIndex(i)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Descriptions() {
  const { user } = useAuth();
  const [rows, setRows] = useState<DescRow[]>([]);
  const [tray, setTray] = useState<ImageRow[]>([]);
  const [files, setFiles] = useState<SlotMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(true);

  const [brand, setBrand] = useState("");
  const [collection, setCollection] = useState("");
  const [ptype, setPtype] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [qd, setQd] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setQd(q.trim().toLowerCase()), 150);
    return () => clearTimeout(t);
  }, [q]);

  async function load() {
    setErr(null);
    try {
      const [data, fileRes] = await Promise.all([
        api<{ products: DescRow[]; tray: ImageRow[]; orphans: ContentRow[] }>(
          "/api/descriptions",
        ),
        api<{ files: SlotMeta[] }>("/api/descriptions/files"),
      ]);
      setRows(data.products);
      setTray(data.tray ?? []);
      setFiles(fileRes.files);
      // Product ids are replaced wholesale on re-import; a stale selection
      // would silently point at dead UUIDs (and bite batch actions later).
      setChecked(new Set());
      setExpanded(null);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Filter options derive from the dataset; collection narrows by brand.
  const brands = useMemo(
    () => [...new Set(rows.map((r) => r.brand))].sort(),
    [rows],
  );
  const collections = useMemo(
    () =>
      [
        ...new Set(
          rows.filter((r) => !brand || r.brand === brand).map((r) => r.collection),
        ),
      ].sort(),
    [rows, brand],
  );
  const ptypes = useMemo(
    () =>
      [
        ...new Set(
          rows.map((r) => r.product_type).filter((v): v is string => !!v),
        ),
      ].sort(),
    [rows],
  );
  useEffect(() => {
    if (collection && !collections.includes(collection)) setCollection("");
  }, [collections, collection]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (brand && r.brand !== brand) return false;
      if (collection && r.collection !== collection) return false;
      if (ptype && r.product_type !== ptype) return false;
      if (status && statusOf(r) !== status) return false;
      if (qd) {
        const hay = [r.name ?? "", r.family ?? "", ...r.model_numbers]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(qd)) return false;
      }
      return true;
    });
  }, [rows, brand, collection, ptype, status, qd]);

  const allFilteredChecked =
    filtered.length > 0 && filtered.every((r) => checked.has(r.id));
  const someFilteredChecked = filtered.some((r) => checked.has(r.id));
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        someFilteredChecked && !allFilteredChecked;
    }
  }, [someFilteredChecked, allFilteredChecked]);

  /** Header checkbox: selects exactly the currently filtered rows. */
  function toggleAllFiltered() {
    setChecked((prev) => {
      const next = new Set(prev);
      if (allFilteredChecked) {
        for (const r of filtered) next.delete(r.id);
      } else {
        for (const r of filtered) next.add(r.id);
      }
      return next;
    });
  }
  function toggleChecked(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function assignTrayImage(imageId: string, productId: string | null) {
    setErr(null);
    try {
      await api(`/api/descriptions/images/${imageId}`, {
        method: "PATCH",
        body: JSON.stringify({ product_id: productId }),
      });
      await load();
    } catch (e) {
      setErr(errorMessage(e));
    }
  }

  if (user?.role === "rep") {
    return (
      <div className="card">
        <h2>Descriptions</h2>
        <p className="muted">This tool is available to internal users only.</p>
      </div>
    );
  }

  const metaFor = (slot: string) =>
    files.find((f) => f.slot === slot)?.latest ?? null;

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>Descriptions</h2>
        <div className="muted">
          Import the seasonal master lists, then draft and review product
          descriptions in each brand's voice. One row per PPID page; approved
          and edited copy survives re-imports.
        </div>
      </div>

      <div className="card col" style={{ gap: 12 }}>
        <div
          className="row"
          style={{ justifyContent: "space-between", cursor: "pointer" }}
          onClick={() => setFilesOpen((v) => !v)}
        >
          <strong>Source files</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            {filesOpen ? "Hide" : "Show"}
          </span>
        </div>
        {filesOpen && (
          <>
            <div className="grid-3" style={{ gap: 12 }}>
              {DESC_MASTER_SLOTS.map((slot) => (
                <MasterSlotCard
                  key={slot}
                  slot={slot}
                  meta={metaFor(slot)}
                  onImported={load}
                />
              ))}
            </div>
            <div className="grid-3" style={{ gap: 12 }}>
              {DESC_SUPPLEMENT_SLOTS.map((slot) => (
                <SupplementSlotCard
                  key={slot}
                  slot={slot}
                  meta={metaFor(slot)}
                  onImported={load}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="card row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={brand} onChange={(e) => setBrand(e.target.value)} style={{ width: "auto" }}>
          <option value="">All brands</option>
          {brands.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        <select value={collection} onChange={(e) => setCollection(e.target.value)} style={{ width: "auto" }}>
          <option value="">All collections</option>
          {collections.map((cName) => (
            <option key={cName} value={cName}>{cName}</option>
          ))}
        </select>
        <select value={ptype} onChange={(e) => setPtype(e.target.value)} style={{ width: "auto" }}>
          <option value="">All product types</option>
          {ptypes.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{DESC_STATUS_LABELS[s]}</option>
          ))}
        </select>
        <input
          placeholder="Search name, family, model…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        {checked.size > 0 && (
          <span className="tag" style={{ margin: 0 }}>
            {checked.size} selected ·{" "}
            <a
              onClick={(e) => {
                e.preventDefault();
                setChecked(new Set());
              }}
              href="#"
            >
              clear
            </a>
          </span>
        )}
      </div>

      {err && <div className="alert error">{err}</div>}

      <div className="card">
        <div className="desc-table-wrap">
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allFilteredChecked}
                    onChange={toggleAllFiltered}
                    style={{ width: "auto" }}
                    aria-label="Select all filtered products"
                  />
                </th>
                <th>Images</th>
                <th>Name</th>
                <th>Brand / Collection</th>
                <th>Product Type</th>
                <th>Diffuser</th>
                <th>Finishes</th>
                <th>L × W × H</th>
                <th>CCT</th>
                <th>Models</th>
                <th>Features</th>
                <th>Description</th>
                <th>Title</th>
                <th>Meta</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const st = statusOf(r);
                const description =
                  r.content?.description_final ?? r.content?.description_ai ?? null;
                const meta = r.content?.meta_final ?? r.content?.meta_ai ?? null;
                const title = r.content?.title_override ?? null;
                const isOpen = expanded === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr
                      onClick={() => setExpanded(isOpen ? null : r.id)}
                      style={{ cursor: "pointer" }}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={checked.has(r.id)}
                          onChange={() => toggleChecked(r.id)}
                          style={{ width: "auto" }}
                          aria-label={`Select ${r.name ?? r.content_key}`}
                        />
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {r.images.length > 0 ? (
                          <button
                            className="desc-thumb-btn"
                            onClick={() =>
                              setLightbox({
                                images: r.images,
                                index: 0,
                                title: r.name ?? r.content_key,
                              })
                            }
                            aria-label={`View ${r.images.length} images of ${r.name ?? r.content_key}`}
                          >
                            <DescImg
                              r2Key={r.images[0]!.r2_key}
                              alt={r.name ?? r.content_key}
                              className="desc-thumb"
                            />
                            {r.images.length > 1 && (
                              <span className="desc-thumb-badge">
                                +{r.images.length - 1}
                              </span>
                            )}
                          </button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.name ?? "—"}</div>
                        {r.family && (
                          <div className="muted" style={{ fontSize: 11 }}>
                            {r.family}
                          </div>
                        )}
                      </td>
                      <td>
                        <div>
                          {r.brand} · {r.collection}
                        </div>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {r.year}
                        </div>
                      </td>
                      <td>{r.product_type ?? <span className="muted">—</span>}</td>
                      <td>{r.diffuser_type ?? <span className="muted">—</span>}</td>
                      <td>
                        <PlusN values={r.finishes} shown={2} />
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{sizeRange(r.sizes)}</td>
                      <td>{r.cct.length > 0 ? r.cct.join("/") : <span className="muted">—</span>}</td>
                      <td>
                        <PlusN values={r.model_numbers} mono />
                      </td>
                      <td>
                        {r.features.length > 0 ? (
                          <span className="tag" title={r.features.join("\n")} style={{ margin: 0 }}>
                            {r.features.length} ⋯
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td style={{ maxWidth: 220 }}>
                        {description ? (
                          <span
                            title={description}
                            style={{
                              display: "block",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {description}
                          </span>
                        ) : (
                          <span className="muted">not written</span>
                        )}
                      </td>
                      <td className="muted" title="Formula titles arrive in a later stage">
                        {title ?? "—"}
                      </td>
                      <td className="muted" title="Meta descriptions arrive in a later stage">
                        {meta ?? "—"}
                      </td>
                      <td>
                        <StatusTag status={st} />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="desc-expand-row">
                        <td colSpan={15}>
                          <ExpandedRow
                            row={r}
                            onLightbox={(index) =>
                              setLightbox({
                                images: r.images,
                                index,
                                title: r.name ?? r.content_key,
                              })
                            }
                            onUnassign={(imageId) => void assignTrayImage(imageId, null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {filtered.length === 0 && !loading && (
                <tr>
                  <td colSpan={15} className="muted">
                    {rows.length === 0
                      ? "No products yet. Upload the master lists above to populate the table."
                      : "No products match the current filters."}
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={15} className="muted">
                    <span className="spinner" /> Loading…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          {filtered.length} of {rows.length} products
        </div>
      </div>

      {tray.length > 0 && (
        <TrayCard
          tray={tray}
          rows={rows}
          onAssign={(imageId, productId) => void assignTrayImage(imageId, productId)}
          onView={(index) =>
            setLightbox({ images: tray, index, title: "Unassigned Schonbek pages" })
          }
        />
      )}

      {lightbox && (
        <Lightbox
          state={lightbox}
          onClose={() => setLightbox(null)}
          onIndex={(index) => setLightbox((s) => (s ? { ...s, index } : s))}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded row — left product panel (editors arrive in a later stage)
// ---------------------------------------------------------------------------

function ExpandedRow({
  row,
  onLightbox,
  onUnassign,
}: {
  row: DescRow;
  onLightbox: (index: number) => void;
  onUnassign: (imageId: string) => void;
}) {
  const enriched = Array.isArray(row.attributes?.sheetFeatures);
  const marker = row.slot === "dweled_master" ? "(deck)" : "(pdf)";
  return (
    <div className="desc-expand">
      <div className="desc-expand-left">
        {row.images.length > 0 && (
          <div className="desc-strip">
            {row.images.map((img, i) => (
              <span key={img.id} className="desc-strip-item">
                <DescImg
                  r2Key={img.r2_key}
                  alt={`${row.name ?? row.content_key} ${i + 1}`}
                  className="desc-thumb desc-thumb-lg"
                  onClick={() => onLightbox(i)}
                />
                {img.slot === "schonbek_pdf" && (
                  <a
                    href="#"
                    className="muted"
                    style={{ fontSize: 11 }}
                    onClick={(e) => {
                      e.preventDefault();
                      onUnassign(img.id);
                    }}
                  >
                    Return to tray
                  </a>
                )}
              </span>
            ))}
          </div>
        )}
        <div className="desc-attrs">
          <span className="muted">Product type</span>
          <span>{row.product_type ?? "—"}</span>
          <span className="muted">Diffuser</span>
          <span>{row.diffuser_type ?? "—"}</span>
          <span className="muted">Finishes</span>
          <span>{row.finishes.length > 0 ? row.finishes.join(", ") : "—"}</span>
          <span className="muted">Sizes</span>
          <span>
            {row.sizes.length > 0
              ? row.sizes
                  .map((s) => [s.length ?? "?", s.width ?? "?", s.height ?? "?"].join(" × "))
                  .join("; ")
              : "—"}
          </span>
          <span className="muted">CCT</span>
          <span>{row.cct.length > 0 ? row.cct.join(", ") : "—"}</span>
          <span className="muted">Models</span>
          <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}>
            {row.model_numbers.length > 0 ? row.model_numbers.join(", ") : "—"}
          </span>
          {row.family && (
            <>
              <span className="muted">Family</span>
              <span>{row.family}</span>
            </>
          )}
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            Features
          </div>
          {row.features.length > 0 ? (
            <ul className="desc-features">
              {row.features.map((f, i) => (
                <li key={i}>
                  {f}
                  {enriched && (
                    <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>
                      {marker}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <span className="muted">No features yet. Import the deck or naming PDF to fill these in.</span>
          )}
        </div>
      </div>
      <div className="desc-expand-right muted">
        Description, title and meta editors arrive in a later stage.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schonbek unassigned tray
// ---------------------------------------------------------------------------

function TrayCard({
  tray,
  rows,
  onAssign,
  onView,
}: {
  tray: ImageRow[];
  rows: DescRow[];
  onAssign: (imageId: string, productId: string) => void;
  onView: (index: number) => void;
}) {
  return (
    <div className="card col" style={{ gap: 10 }}>
      <div>
        <strong>Unassigned Schonbek pages</strong>
        <div className="muted" style={{ fontSize: 12 }}>
          The Schonbek names PDF has no readable text, so its pages need a
          manual match. Assign each page to a product, or leave it here.
        </div>
      </div>
      <div className="desc-tray">
        {tray.map((img, i) => (
          <TrayItem
            key={img.id}
            img={img}
            index={i}
            rows={rows}
            onAssign={onAssign}
            onView={onView}
          />
        ))}
      </div>
    </div>
  );
}

function TrayItem({
  img,
  index,
  rows,
  onAssign,
  onView,
}: {
  img: ImageRow;
  index: number;
  rows: DescRow[];
  onAssign: (imageId: string, productId: string) => void;
  onView: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    if (!q.trim()) return [];
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => {
        // Tray pages are Schonbek pdf renders — they only ever belong on
        // Schonbek master products (the API enforces the same rule).
        if (r.slot !== "schonbek_master") return false;
        const hay = [r.name ?? "", r.family ?? "", ...r.model_numbers]
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      })
      .slice(0, 8);
  }, [q, rows]);

  return (
    <div className="desc-tray-item">
      <DescImg
        r2Key={img.r2_key}
        alt={`Page ${index + 1}`}
        className="desc-thumb desc-thumb-lg"
        onClick={() => onView(index)}
      />
      {open ? (
        <div className="col" style={{ gap: 4 }}>
          <input
            autoFocus
            placeholder="Search product…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ fontSize: 12 }}
          />
          {matches.map((r) => (
            <a
              key={r.id}
              href="#"
              style={{ fontSize: 12 }}
              onClick={(e) => {
                e.preventDefault();
                onAssign(img.id, r.id);
              }}
            >
              {r.name ?? r.content_key}
              <span className="muted"> · {r.collection}</span>
            </a>
          ))}
          {q.trim() && matches.length === 0 && (
            <span className="muted" style={{ fontSize: 12 }}>
              No products match.
            </span>
          )}
          <a
            href="#"
            className="muted"
            style={{ fontSize: 11 }}
            onClick={(e) => {
              e.preventDefault();
              setOpen(false);
              setQ("");
            }}
          >
            Cancel
          </a>
        </div>
      ) : (
        <button className="secondary" style={{ fontSize: 12 }} onClick={() => setOpen(true)}>
          Assign…
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Master slot upload card (PricingSlot pattern, client-side phases)
// ---------------------------------------------------------------------------

type SlotPhase =
  | { kind: "idle" }
  | { kind: "reading"; name: string; detail?: string }
  | { kind: "importing"; name: string }
  | {
      kind: "confirm";
      name: string;
      importId: string;
      payload: Parameters<typeof commitImport>[2];
      removed: string[];
      orphaned: string[];
    }
  | { kind: "done"; name: string; summary: CommitSummary }
  | { kind: "error"; message: string };

function phaseDetail(p: MasterPhase | SupplementPhase): string | undefined {
  switch (p.kind) {
    case "images":
    case "extracting":
      return `Extracting images ${p.done}/${p.total}…`;
    case "uploading":
      return `Uploading images ${p.done}/${p.total}…`;
    default:
      return undefined;
  }
}

function MasterSlotCard({
  slot,
  meta,
  onImported,
}: {
  slot: DescMasterSlot;
  meta: SlotMeta["latest"];
  onImported: () => Promise<void>;
}) {
  const [phase, setPhase] = useState<SlotPhase>({ kind: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy =
    phase.kind === "reading" ||
    phase.kind === "importing" ||
    phase.kind === "confirm";

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setPhase({ kind: "error", message: "Please choose an .xlsx workbook" });
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      setPhase({ kind: "error", message: "File is too large (max 30 MB)" });
      return;
    }
    setPhase({ kind: "reading", name: file.name });
    const parsed = await parseMasterFile(slot, file, (p) =>
      setPhase({ kind: "reading", name: file.name, detail: phaseDetail(p) }),
    );
    if (!parsed.ok) {
      setPhase({
        kind: "error",
        message: `This doesn't look like the ${DESC_SLOT_LABELS[slot]}: ${parsed.error}. Nothing was imported.`,
      });
      return;
    }
    setPhase({ kind: "importing", name: file.name });
    try {
      const importId = await uploadRawFile(slot, file);
      const dry = await commitImport(slot, importId, parsed.payload, true);
      if (dry.removed.length > 0) {
        setPhase({
          kind: "confirm",
          name: file.name,
          importId,
          payload: parsed.payload,
          removed: dry.removed,
          orphaned: dry.orphaned,
        });
        return;
      }
      const summary = await commitImport(slot, importId, parsed.payload, false);
      setPhase({ kind: "done", name: file.name, summary });
      await onImported();
    } catch (e) {
      setPhase({ kind: "error", message: errorMessage(e) });
    }
  }

  async function confirmCommit() {
    if (phase.kind !== "confirm") return;
    const { name, importId, payload } = phase;
    setPhase({ kind: "importing", name });
    try {
      const summary = await commitImport(slot, importId, payload, false);
      setPhase({ kind: "done", name, summary });
      await onImported();
    } catch (e) {
      setPhase({ kind: "error", message: errorMessage(e) });
    }
  }

  const lastLine = meta
    ? `${new Date(meta.committed_at ?? meta.uploaded_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${
        meta.parse_report?.products != null
          ? `${meta.parse_report.products} products · `
          : ""
      }${
        meta.parse_report?.images ? `${meta.parse_report.images} images · ` : ""
      }${meta.uploaded_by_email?.split("@")[0] ?? meta.filename}`
    : "No file imported yet.";

  return (
    <div className="card col" style={{ gap: 8, padding: 14 }}>
      <strong style={{ fontSize: 13 }}>{DESC_SLOT_LABELS[slot]}</strong>

      <div
        className={`dropzone${dragOver ? " dragover" : ""}`}
        style={{ minHeight: 84, padding: 12, cursor: busy ? "default" : "pointer" }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file && !busy) void handleFile(file);
        }}
        onClick={() => !busy && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept={XLSX_ACCEPT}
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = "";
          }}
        />
        {phase.kind === "reading" ? (
          <span className="row" style={{ gap: 8 }}>
            <span className="spinner" /> {phase.detail ?? "Reading workbook…"}
          </span>
        ) : phase.kind === "importing" ? (
          <span className="row" style={{ gap: 8 }}>
            <span className="spinner" /> Importing…
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            Drop the workbook here, or click to choose
          </span>
        )}
      </div>

      {phase.kind === "confirm" && (
        <div className="alert warn" style={{ margin: 0 }}>
          <div>
            {phase.removed.length} product
            {phase.removed.length === 1 ? "" : "s"} disappear from this file:{" "}
            {phase.removed.slice(0, 6).join(", ")}
            {phase.removed.length > 6 ? "…" : ""}. Their drafts will be
            deleted.
            {phase.orphaned.length > 0 &&
              ` ${phase.orphaned.length} with edited or approved copy will be kept as orphans.`}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button onClick={() => void confirmCommit()}>Continue</button>
            <button className="secondary" onClick={() => setPhase({ kind: "idle" })}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase.kind === "done" && (
        <div className="alert good" style={{ margin: 0 }}>
          Imported {phase.summary.products} products ({phase.summary.new.length}{" "}
          new, {phase.summary.updated} updated
          {phase.summary.relinked > 0 ? `, ${phase.summary.relinked} relinked` : ""}
          {phase.summary.removed.length > 0
            ? `, ${phase.summary.removed.length} removed`
            : ""}
          {phase.summary.images > 0 ? `, ${phase.summary.images} images` : ""}
          ).
          {phase.summary.warnings.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: "pointer" }}>
                {phase.summary.warnings.length} warning
                {phase.summary.warnings.length === 1 ? "" : "s"}
              </summary>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {phase.summary.warnings.slice(0, 20).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {phase.kind === "error" && (
        <div className="alert error" style={{ margin: 0 }}>
          {phase.message}
        </div>
      )}

      <div className="muted" style={{ fontSize: 11 }}>
        {lastLine}
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        Re-uploading replaces this file's products. Approved and edited copy is
        kept for products that still match.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supplemental slot cards (deck / naming pdf / Schonbek pages)
// ---------------------------------------------------------------------------

type SupplementSlotPhase =
  | { kind: "idle" }
  | { kind: "working"; name: string; detail?: string }
  | { kind: "done"; name: string; summary: SupplementSummary }
  | { kind: "error"; message: string };

function SupplementSlotCard({
  slot,
  meta,
  onImported,
}: {
  slot: DescSupplementSlot;
  meta: SlotMeta["latest"];
  onImported: () => Promise<void>;
}) {
  const [phase, setPhase] = useState<SupplementSlotPhase>({ kind: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = phase.kind === "working";
  const wantExt = slot === "dweled_pptx" ? ".pptx" : ".pdf";

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith(wantExt)) {
      setPhase({ kind: "error", message: `Please choose a ${wantExt} file` });
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      setPhase({ kind: "error", message: "File is too large (max 30 MB)" });
      return;
    }
    setPhase({ kind: "working", name: file.name });
    const res = await importSupplementFile(slot, file, (p) =>
      setPhase({
        kind: "working",
        name: file.name,
        detail:
          p.kind === "importing"
            ? "Importing…"
            : (phaseDetail(p) ?? "Reading file…"),
      }),
    );
    if (!res.ok) {
      setPhase({ kind: "error", message: res.error });
      return;
    }
    setPhase({ kind: "done", name: file.name, summary: res.summary });
    await onImported();
  }

  const report = meta?.parse_report;
  const lastLine = meta
    ? `${new Date(meta.committed_at ?? meta.uploaded_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${
        slot === "schonbek_pdf"
          ? report?.units != null
            ? `${report.units} pages · `
            : ""
          : report?.units != null
            ? `${report.matched ?? 0} matched / ${report.unmatched?.length ?? 0} unmatched · `
            : ""
      }${meta.uploaded_by_email?.split("@")[0] ?? meta.filename}`
    : "No file imported yet.";

  const unmatchedList = (list: { ref: string; name: string | null; reason: string }[]) => (
    <details style={{ marginTop: 6 }}>
      <summary style={{ cursor: "pointer" }}>
        {list.length} unmatched
      </summary>
      <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
        {list.slice(0, 20).map((u, i) => (
          <li key={i}>
            {u.ref}
            {u.name ? ` (${u.name})` : ""}: {u.reason}
          </li>
        ))}
      </ul>
    </details>
  );

  return (
    <div className="card col" style={{ gap: 8, padding: 14 }}>
      <strong style={{ fontSize: 13 }}>{DESC_SLOT_LABELS[slot]}</strong>

      <div
        className={`dropzone${dragOver ? " dragover" : ""}`}
        style={{ minHeight: 84, padding: 12, cursor: busy ? "default" : "pointer" }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file && !busy) void handleFile(file);
        }}
        onClick={() => !busy && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept={SLOT_ACCEPT[slot]}
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = "";
          }}
        />
        {phase.kind === "working" ? (
          <span className="row" style={{ gap: 8 }}>
            <span className="spinner" /> {phase.detail ?? "Reading file…"}
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            Drop the {wantExt} here, or click to choose
          </span>
        )}
      </div>

      {phase.kind === "done" && (
        <div className="alert good" style={{ margin: 0 }}>
          {slot === "schonbek_pdf" ? (
            <>
              Imported {phase.summary.images} page image
              {phase.summary.images === 1 ? "" : "s"} into the tray.
            </>
          ) : (
            <>
              {phase.summary.matched} of {phase.summary.units} matched.
              {phase.summary.unmatched.length > 0 &&
                unmatchedList(phase.summary.unmatched)}
            </>
          )}
          {phase.summary.warnings.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: "pointer" }}>
                {phase.summary.warnings.length} warning
                {phase.summary.warnings.length === 1 ? "" : "s"}
              </summary>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {phase.summary.warnings.slice(0, 20).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {phase.kind === "error" && (
        <div className="alert error" style={{ margin: 0 }}>
          {phase.message}
        </div>
      )}

      <div className="muted" style={{ fontSize: 11 }}>
        {lastLine}
        {phase.kind !== "done" &&
          report?.unmatched != null &&
          report.unmatched.length > 0 &&
          unmatchedList(report.unmatched)}
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        {slot === "schonbek_pdf"
          ? "Pages land in the unassigned tray below the table for manual matching."
          : slot === "dweled_pptx"
            ? "Matched slides replace a product's features and add hero images."
            : "Matched pages replace a product's features."}
      </div>
    </div>
  );
}
