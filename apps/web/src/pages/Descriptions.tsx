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
  type DescContentStatus,
  type DescMasterSlot,
  type SizeTuple,
} from "@wac/shared";
import { api, errorMessage } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import {
  commitImport,
  parseMasterFile,
  uploadRawFile,
  type CommitSummary,
} from "../lib/descriptions/importMaster.js";

/**
 * Descriptions (plan Stage 1): import the seasonal master lists in the
 * browser, review the grouped PPID table, filter/search/select. Generation,
 * titles, images and export layer on in later stages — their cells render
 * placeholders here.
 */

const XLSX_ACCEPT =
  ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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
  source_rows: number;
  sort_order: number;
  content: ContentRow | null;
  images: { id: string; r2_key: string }[];
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
    parse_report: { products?: number; warnings?: string[] } | null;
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

export function Descriptions() {
  const { user } = useAuth();
  const [rows, setRows] = useState<DescRow[]>([]);
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
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setQd(q.trim().toLowerCase()), 150);
    return () => clearTimeout(t);
  }, [q]);

  async function load() {
    setErr(null);
    try {
      const [data, fileRes] = await Promise.all([
        api<{ products: DescRow[]; orphans: ContentRow[] }>("/api/descriptions"),
        api<{ files: SlotMeta[] }>("/api/descriptions/files"),
      ]);
      setRows(data.products);
      setFiles(fileRes.files);
      // Product ids are replaced wholesale on re-import; a stale selection
      // would silently point at dead UUIDs (and bite batch actions later).
      setChecked(new Set());
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
                return (
                  <Fragment key={r.id}>
                    <tr>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={checked.has(r.id)}
                          onChange={() => toggleChecked(r.id)}
                          style={{ width: "auto" }}
                          aria-label={`Select ${r.name ?? r.content_key}`}
                        />
                      </td>
                      <td className="muted">
                        {r.images.length > 0 ? `${r.images.length}` : "—"}
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Master slot upload card (PricingSlot pattern, client-side phases)
// ---------------------------------------------------------------------------

type SlotPhase =
  | { kind: "idle" }
  | { kind: "reading"; name: string }
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
    const parsed = await parseMasterFile(slot, file);
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
            <span className="spinner" /> Reading workbook…
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
