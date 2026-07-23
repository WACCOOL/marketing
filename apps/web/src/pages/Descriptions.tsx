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
  DESC_META_RANGE,
  DESC_SLOT_LABELS,
  DESC_STATUS_LABELS,
  DESC_SUPPLEMENT_SLOTS,
  DESC_TITLE_RANGE,
  buildExportRows,
  descriptionsCsv,
  titleFor,
  titleLengthOk,
  type DescContentStatus,
  type DescMasterSlot,
  type DescSupplementSlot,
  type SizeTuple,
} from "@wac/shared";
import { api, apiBlob, errorMessage } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { DescVoiceModal } from "../components/DescVoiceModal.js";
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
 * Descriptions (plan Stages 1–4): import the seasonal master lists and the
 * supplemental deck/pdfs in the browser, review the grouped PPID table with
 * thumbnails, lightbox, expanded product panel and the Schonbek tray, then
 * batch-generate descriptions + metas in each brand's voice and walk them
 * through the none → generated → edited → approved review workflow. Stage 5
 * adds client-side export (XLSX/CSV, from the loaded dataset) and the
 * orphaned-copy card (attach preserved copy to a product, or delete drafts).
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

/** One per-product result from POST /generate. */
interface GenResult {
  id: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  opening?: string;
  metaOpening?: string;
  content?: ContentRow;
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

/** The deterministic per-brand formula title for a row (plan decision 6). */
function formulaTitleFor(row: DescRow): string {
  return titleFor({
    brand: row.brand,
    collection: row.collection,
    name: row.name,
    productType: row.product_type,
    modelBases: row.model_bases,
  });
}

/** Effective title: a saved override wins over the formula. */
function effectiveTitle(row: DescRow): string {
  return row.content?.title_override ?? formulaTitleFor(row);
}

/** The effective description/meta shown everywhere: human edit wins. */
function descriptionOf(row: DescRow): string | null {
  return row.content?.description_final ?? row.content?.description_ai ?? null;
}
function metaOf(row: DescRow): string | null {
  return row.content?.meta_final ?? row.content?.meta_ai ?? null;
}

/** Live meta character counter, colored against the 50-160 docx range. */
function MetaCounter({ value }: { value: string }) {
  const len = value.length;
  const color =
    len === 0
      ? undefined
      : len < DESC_META_RANGE.min
        ? "var(--warn)"
        : len > DESC_META_RANGE.max
          ? "var(--bad)"
          : "var(--good)";
  return (
    <span className="muted" style={{ fontSize: 11, color }}>
      {len} / {DESC_META_RANGE.min}–{DESC_META_RANGE.max}
    </span>
  );
}

/** Green-in-range / amber-out-of-range length dot with the count on hover. */
function TitleLenDot({ title }: { title: string }) {
  return (
    <span
      className={`desc-len-dot${titleLengthOk(title) ? " ok" : ""}`}
      title={`${title.length} characters (target ${DESC_TITLE_RANGE.min}-${DESC_TITLE_RANGE.max})`}
    />
  );
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
  const [orphans, setOrphans] = useState<ContentRow[]>([]);
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
  const [voiceOpen, setVoiceOpen] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const voiceBtnRef = useRef<HTMLButtonElement>(null);

  // Batch generation state (ProductInfo runGenerateBatch pattern).
  const [genBusy, setGenBusy] = useState(false);
  const [genNotice, setGenNotice] = useState<string | null>(null);
  const [genErrors, setGenErrors] = useState<
    { id: string; name: string; error: string }[]
  >([]);
  const [inflight, setInflight] = useState<Set<string>>(new Set());
  const cancelRef = useRef(false);

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
      setOrphans(data.orphans ?? []);
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
  const hasFilters = !!(brand || collection || ptype || status || q);
  function clearFilters() {
    setBrand("");
    setCollection("");
    setPtype("");
    setStatus("");
    setQ("");
  }
  function toggleChecked(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Merge a saved desc_content row back into its product without reloading. */
  function updateContent(rowId: string, content: ContentRow) {
    setRows((prev) =>
      prev.map((r) => (r.id === rowId ? { ...r, content } : r)),
    );
  }

  /**
   * Client-driven chunk loop (plan decision 7): 6 ids per request, openings
   * (and meta opening verbs) threaded across chunks so a long run stays
   * self-diversifying, per-row spinner via `inflight`, "Stop after this
   * batch" between chunks. Approved rows are excluded client-side (the
   * server enforces the same skip). Batch runs never overwrite manual edits
   * (the server skips those rows per-id); only the per-row Regenerate button
   * opts into `overwriteEdits` after an explicit confirm.
   */
  async function runGenerate(ids: string[], opts?: { overwriteEdits?: boolean }) {
    const targets = rows.filter((r) => ids.includes(r.id));
    const eligible = targets.filter((r) => statusOf(r) !== "approved");
    const excluded = targets.length - eligible.length;
    if (eligible.length === 0) {
      setGenNotice(
        targets.length > 0
          ? "All selected rows are approved. Reopen them to regenerate."
          : "Nothing selected.",
      );
      return;
    }
    cancelRef.current = false;
    setGenBusy(true);
    setGenErrors([]);
    setErr(null);
    setGenNotice(null);
    const errors: { id: string; name: string; error: string }[] = [];
    const openings: string[] = [];
    const metaOpenings: string[] = [];
    let done = 0;
    const CHUNK = 6;
    const note = (extra = "") =>
      setGenNotice(
        `Generating descriptions… ${done} done, ${eligible.length - done - errors.length} remaining${
          errors.length ? `, ${errors.length} failed` : ""
        }${excluded ? ` (${excluded} approved excluded)` : ""}${extra}`,
      );
    try {
      for (let i = 0; i < eligible.length; i += CHUNK) {
        const chunk = eligible.slice(i, i + CHUNK);
        setInflight(new Set(chunk.map((r) => r.id)));
        note();
        const res = await api<{ results: GenResult[] }>(
          "/api/descriptions/generate",
          {
            method: "POST",
            body: JSON.stringify({
              ids: chunk.map((r) => r.id),
              // The server also mixes in the 8 most recent DB openings; this
              // carries the CURRENT run across request boundaries (≤24).
              priorOpenings: openings.slice(-24),
              priorMetaOpenings: metaOpenings.slice(-24),
              overwriteEdits: opts?.overwriteEdits ?? false,
            }),
          },
        );
        for (const result of res.results) {
          const row = chunk.find((x) => x.id === result.id);
          if (result.ok && result.content) {
            updateContent(result.id, result.content);
            done++;
            if (result.opening) openings.push(result.opening);
            if (result.metaOpening) metaOpenings.push(result.metaOpening);
          } else {
            errors.push({
              id: result.id,
              name: row?.name ?? row?.content_key ?? result.id,
              error:
                result.error ?? (result.skipped ? "approved; skipped" : "failed"),
            });
          }
        }
        setGenErrors([...errors]);
        if (cancelRef.current) break;
      }
      setGenNotice(
        `${cancelRef.current ? "Stopped: " : ""}${done} generated${
          errors.length ? `, ${errors.length} failed` : ""
        }${excluded ? `, ${excluded} approved excluded` : ""}.`,
      );
    } catch (e) {
      setErr(errorMessage(e));
      setGenNotice(null);
    } finally {
      setInflight(new Set());
      setGenBusy(false);
    }
  }

  /** Rows currently eligible for bulk approval among the checked set. */
  function approvableChecked(): DescRow[] {
    return rows.filter((r) => {
      if (!checked.has(r.id)) return false;
      const st = statusOf(r);
      return (st === "generated" || st === "in_review") && !!descriptionOf(r);
    });
  }

  async function bulkApprove() {
    const targets = approvableChecked();
    if (targets.length === 0) {
      setGenNotice(
        "No selected rows are ready to approve (they need a description and must not be approved already).",
      );
      return;
    }
    if (
      !confirm(
        `Approve ${targets.length} product description${targets.length === 1 ? "" : "s"}? Approval covers the description and meta together.`,
      )
    ) {
      return;
    }
    setGenBusy(true);
    setErr(null);
    try {
      const res = await api<{ approved: number; skipped: number }>(
        "/api/descriptions/bulk-approve",
        {
          method: "POST",
          body: JSON.stringify({ ids: targets.map((r) => r.id) }),
        },
      );
      setGenNotice(
        `Approved ${res.approved}${res.skipped ? `, skipped ${res.skipped}` : ""}.`,
      );
      await load();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setGenBusy(false);
    }
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
            <div className="desc-slots">
              {DESC_MASTER_SLOTS.map((slot) => (
                <MasterSlotCard
                  key={slot}
                  slot={slot}
                  meta={metaFor(slot)}
                  onImported={load}
                />
              ))}
            </div>
            <div className="desc-slots">
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
        <button
          ref={voiceBtnRef}
          className="secondary"
          style={{ whiteSpace: "nowrap" }}
          onClick={() => setVoiceOpen(true)}
        >
          Edit brand voice &amp; prompt
        </button>
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

      <BatchCard
        checkedRows={rows.filter((r) => checked.has(r.id))}
        filteredRows={filtered}
        allRows={rows}
        approvable={approvableChecked().length}
        busy={genBusy}
        notice={genNotice}
        errors={genErrors}
        onGenerate={() => void runGenerate([...checked])}
        onStop={() => {
          cancelRef.current = true;
        }}
        onApprove={() => void bulkApprove()}
      />

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
                const title = effectiveTitle(r);
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
                      <td style={{ maxWidth: 220 }}>
                        <span
                          className="row"
                          style={{ gap: 6, alignItems: "center", flexWrap: "nowrap" }}
                        >
                          <TitleLenDot title={title} />
                          <span
                            title={`${title}${r.content?.title_override ? " (manual override)" : " (formula)"}`}
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {title}
                          </span>
                        </span>
                      </td>
                      <td style={{ maxWidth: 200 }}>
                        {meta ? (
                          <span
                            title={`${meta} (${meta.length} chars)`}
                            style={{
                              display: "block",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {meta}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {inflight.has(r.id) ? (
                          <span className="spinner" aria-label="Generating" />
                        ) : (
                          <StatusTag status={st} />
                        )}
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
                            onContent={(content) => updateContent(r.id, content)}
                            onGenerate={() => {
                              // Per-row Regenerate opts into overwriting
                              // manual edits, but only after an explicit
                              // confirm when edits actually exist.
                              const hasEdits = !!(
                                r.content?.description_final ||
                                r.content?.meta_final
                              );
                              if (
                                hasEdits &&
                                !confirm(
                                  "This will replace your edited text with fresh AI copy. Continue?",
                                )
                              ) {
                                return;
                              }
                              void runGenerate([r.id], { overwriteEdits: true });
                            }}
                            generating={genBusy || inflight.has(r.id)}
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
                    {rows.length === 0 ? (
                      "No products yet. Drop the seasonal master lists into the file cards above and the table fills in from there."
                    ) : (
                      <>
                        No products match.{" "}
                        {hasFilters && (
                          <a
                            href="#"
                            onClick={(e) => {
                              e.preventDefault();
                              clearFilters();
                            }}
                          >
                            Clear filters
                          </a>
                        )}
                      </>
                    )}
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

      {orphans.length > 0 && (
        <OrphansCard
          orphans={orphans}
          rows={rows}
          onChanged={load}
          onError={setErr}
        />
      )}

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

      {voiceOpen && (
        <DescVoiceModal
          onClose={() => {
            setVoiceOpen(false);
            // Return focus to the trigger button (keyboard flow).
            voiceBtnRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Batch card — Generate (N) / Stop / Approve selected + progress + errors
// ---------------------------------------------------------------------------

function BatchCard({
  checkedRows,
  filteredRows,
  allRows,
  approvable,
  busy,
  notice,
  errors,
  onGenerate,
  onStop,
  onApprove,
}: {
  checkedRows: DescRow[];
  filteredRows: DescRow[];
  allRows: DescRow[];
  approvable: number;
  busy: boolean;
  notice: string | null;
  errors: { id: string; name: string; error: string }[];
  onGenerate: () => void;
  onStop: () => void;
  onApprove: () => void;
}) {
  const eligible = checkedRows.filter((r) => statusOf(r) !== "approved").length;
  const excluded = checkedRows.length - eligible;
  return (
    <div className="card col" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <strong style={{ fontSize: 13 }}>Batch</strong>
        <button onClick={onGenerate} disabled={busy || eligible === 0}>
          {busy ? <span className="spinner" /> : null}
          Generate descriptions ({eligible})
        </button>
        {busy && (
          <button className="secondary" onClick={onStop}>
            Stop after this batch
          </button>
        )}
        <button
          className="secondary"
          onClick={onApprove}
          disabled={busy || approvable === 0}
          title={
            approvable === 0
              ? "Selected rows need a generated or edited description first"
              : undefined
          }
        >
          Approve selected ({approvable})
        </button>
        <ExportMenu
          filteredRows={filteredRows}
          checkedRows={checkedRows}
          allRows={allRows}
        />
        {excluded > 0 && (
          <span className="muted" style={{ fontSize: 12 }}>
            {excluded} approved row{excluded === 1 ? "" : "s"} excluded from
            generation
          </span>
        )}
        {checkedRows.length === 0 && (
          <span className="muted" style={{ fontSize: 12 }}>
            Select rows with the checkboxes to generate or approve in bulk.
          </span>
        )}
      </div>
      {notice && (
        <div className="alert" style={{ margin: 0 }}>
          {notice}
        </div>
      )}
      {errors.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12 }}>
            {errors.length} product{errors.length === 1 ? "" : "s"} failed
          </summary>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {errors.map((e) => (
              <li key={e.id}>
                <strong>{e.name}</strong>: {e.error}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export menu — XLSX/CSV × (filtered | selected | approved only), fully
// client-side from the loaded dataset (plan decision 9). XLSX reuses the
// SheetJS chunk the import lane already dynamic-imports; CSV is a blob with
// a UTF-8 BOM so Excel opens it correctly.
// ---------------------------------------------------------------------------

type ExportScope = "filtered" | "selected" | "approved";

const EXPORT_SCOPE_LABELS: Record<ExportScope, string> = {
  filtered: "Filtered rows",
  selected: "Selected rows",
  approved: "Approved only",
};

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function ExportMenu({
  filteredRows,
  checkedRows,
  allRows,
}: {
  filteredRows: DescRow[];
  checkedRows: DescRow[];
  allRows: DescRow[];
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const scopeRows: Record<ExportScope, DescRow[]> = {
    filtered: filteredRows,
    selected: checkedRows,
    approved: allRows.filter((r) => statusOf(r) === "approved"),
  };

  async function runExport(format: "xlsx" | "csv", scope: ExportScope) {
    const products = scopeRows[scope];
    if (products.length === 0) return;
    setOpen(false);
    setWorking(true);
    setErr(null);
    try {
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const filename = `descriptions-${scope}-${stamp}.${format}`;
      if (format === "xlsx") {
        // Same dynamic chunk as the import lane's cell extraction.
        const XLSX = await import("xlsx");
        const ws = XLSX.utils.aoa_to_sheet(buildExportRows(products));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Descriptions");
        XLSX.writeFile(wb, filename);
      } else {
        downloadBlob(
          new Blob(["\ufeff", descriptionsCsv(products)], {
            type: "text/csv;charset=utf-8",
          }),
          filename,
        );
      }
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setWorking(false);
    }
  }

  const anyRows = Object.values(scopeRows).some((list) => list.length > 0);

  return (
    <span className="desc-menu">
      <button
        className="secondary"
        onClick={() => setOpen((v) => !v)}
        disabled={working || !anyRows}
        title={anyRows ? undefined : "Nothing to export yet"}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {working ? <span className="spinner" /> : null}
        Export ▾
      </button>
      {open && (
        <>
          <span className="desc-menu-backdrop" onClick={() => setOpen(false)} />
          <span className="desc-menu-pop" role="menu">
            {(["xlsx", "csv"] as const).map((format) => (
              <span key={format} className="desc-menu-group">
                <span className="desc-menu-title">
                  {format === "xlsx" ? "Excel (.xlsx)" : "CSV"}
                </span>
                {(Object.keys(EXPORT_SCOPE_LABELS) as ExportScope[]).map(
                  (scope) => {
                    const count = scopeRows[scope].length;
                    return (
                      <button
                        key={scope}
                        role="menuitem"
                        className="desc-menu-item"
                        disabled={count === 0}
                        onClick={() => void runExport(format, scope)}
                        title={
                          count === 0
                            ? scope === "selected"
                              ? "Select rows with the checkboxes first"
                              : scope === "approved"
                                ? "No rows are approved yet"
                                : "No rows match the current filters"
                            : undefined
                        }
                      >
                        {EXPORT_SCOPE_LABELS[scope]} ({count})
                      </button>
                    );
                  },
                )}
              </span>
            ))}
          </span>
        </>
      )}
      {err && (
        <span className="muted" style={{ fontSize: 11, color: "var(--bad)" }}>
          {err}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Expanded row — left product panel + right copy editors
// ---------------------------------------------------------------------------

function ExpandedRow({
  row,
  onLightbox,
  onUnassign,
  onContent,
  onGenerate,
  generating,
}: {
  row: DescRow;
  onLightbox: (index: number) => void;
  onUnassign: (imageId: string) => void;
  onContent: (content: ContentRow) => void;
  onGenerate: () => void;
  generating: boolean;
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
      <div className="desc-expand-right col" style={{ gap: 16 }}>
        <DescriptionEditor
          row={row}
          onSaved={onContent}
          onGenerate={onGenerate}
          generating={generating}
        />
        <MetaEditor row={row} onSaved={onContent} />
        <TitleEditor row={row} onSaved={onContent} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Description editor — draft + Save edits / Generate / Approve / Reopen.
// ONE status per row (plan decision 11): approving here approves the whole
// row (description + meta together); there are no per-field statuses.
// ---------------------------------------------------------------------------

function DescriptionEditor({
  row,
  onSaved,
  onGenerate,
  generating,
}: {
  row: DescRow;
  onSaved: (content: ContentRow) => void;
  onGenerate: () => void;
  generating: boolean;
}) {
  const saved = descriptionOf(row) ?? "";
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Re-seed the draft when the underlying content changes (a generation or
  // save landed) — the fresh server text is the new baseline.
  useEffect(() => {
    setValue(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const st = statusOf(row);
  const approved = st === "approved";
  const dirty = value.trim() !== saved.trim();
  const hasAny = !!descriptionOf(row);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      const { content } = await api<{ content: ContentRow }>(
        `/api/descriptions/content/${row.id}`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
      onSaved(content);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 13 }}>Description</strong>
        <span className="row" style={{ gap: 8, alignItems: "center" }}>
          {generating && <span className="spinner" />}
          <StatusTag status={st} />
        </span>
      </div>
      <textarea
        rows={7}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={approved || busy}
        placeholder="No description yet. Generate one, or write it by hand."
        aria-label={`Description for ${row.name ?? row.content_key}`}
      />
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="secondary"
          onClick={onGenerate}
          disabled={generating || busy || approved}
          title={approved ? "Reopen first" : undefined}
        >
          {hasAny ? "Regenerate" : "Generate"}
        </button>
        <button
          onClick={() => void patch({ action: "save", description: value })}
          disabled={busy || approved || !dirty}
        >
          {busy ? "Saving…" : "Save edits"}
        </button>
        {!approved ? (
          <button
            onClick={() => {
              const body: Record<string, unknown> = { action: "approve" };
              if (dirty) body.description = value; // approve-with-edits
              void patch(body);
            }}
            disabled={busy || generating || (!hasAny && !value.trim())}
            title={
              !hasAny && !value.trim()
                ? "Write or generate a description first"
                : "Approves the row: description and meta together"
            }
          >
            Approve
          </button>
        ) : (
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              void patch({ action: "reopen" });
            }}
          >
            Reopen
          </a>
        )}
        {dirty && !approved && (
          <span className="muted" style={{ fontSize: 11 }}>
            unsaved
          </span>
        )}
      </div>
      {err && (
        <div className="alert error" style={{ margin: 0 }}>
          {err}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meta editor — 50-160 counter + Generate meta (from the CURRENT saved
// description, via regenerate-meta) + Save. Approval is row-level above.
// ---------------------------------------------------------------------------

function MetaEditor({
  row,
  onSaved,
}: {
  row: DescRow;
  onSaved: (content: ContentRow) => void;
}) {
  const saved = metaOf(row) ?? "";
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setValue(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const st = statusOf(row);
  const approved = st === "approved";
  const dirty = value.trim() !== saved.trim();
  const hasDescription = !!descriptionOf(row);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const { content } = await api<{ content: ContentRow }>(
        `/api/descriptions/content/${row.id}`,
        { method: "PATCH", body: JSON.stringify({ action: "save", meta: value }) },
      );
      onSaved(content);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function generateMeta() {
    setBusy(true);
    setErr(null);
    try {
      const { content } = await api<{ content: ContentRow; meta: string }>(
        "/api/descriptions/regenerate-meta",
        { method: "POST", body: JSON.stringify({ id: row.id }) },
      );
      onSaved(content);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 13 }}>Meta description</strong>
        <MetaCounter value={value.trim()} />
      </div>
      <textarea
        rows={3}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={approved || busy}
        placeholder="Generated from the description, or write it by hand."
        aria-label={`Meta description for ${row.name ?? row.content_key}`}
      />
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="secondary"
          onClick={() => void generateMeta()}
          disabled={busy || approved || !hasDescription}
          title={
            approved
              ? "Reopen first"
              : !hasDescription
                ? "Generate or write a description first"
                : "Uses the current saved description (save your edits first)"
          }
        >
          {busy ? "Working…" : "Generate meta"}
        </button>
        <button onClick={() => void save()} disabled={busy || approved || !dirty}>
          Save
        </button>
        {dirty && !approved && (
          <span className="muted" style={{ fontSize: 11 }}>
            unsaved
          </span>
        )}
      </div>
      {err && (
        <div className="alert error" style={{ margin: 0 }}>
          {err}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Title editor — formula with manual override + "Reset to formula"
// ---------------------------------------------------------------------------

function TitleEditor({
  row,
  onSaved,
}: {
  row: DescRow;
  onSaved: (content: ContentRow) => void;
}) {
  const formula = formulaTitleFor(row);
  const [value, setValue] = useState(row.content?.title_override ?? formula);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const saved = row.content?.title_override ?? formula;
  const dirty = value.trim() !== saved;
  const hasOverride = !!row.content?.title_override;

  async function persist(override: string | null) {
    setBusy(true);
    setErr(null);
    try {
      // Content rows are created lazily — the PATCH upserts by product id.
      const { content } = await api<{ content: ContentRow }>(
        `/api/descriptions/content/${row.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ action: "save", title_override: override }),
        },
      );
      onSaved(content);
      setValue(content.title_override ?? formula);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const trimmed = value.trim();
    // Saving text identical to the formula stores no override at all.
    void persist(!trimmed || trimmed === formula ? null : trimmed);
  }

  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 13 }}>HTML title</strong>
        <span className="row" style={{ gap: 6, alignItems: "center" }}>
          <TitleLenDot title={value.trim() || formula} />
          <span className="muted" style={{ fontSize: 11 }}>
            {(value.trim() || formula).length} / {DESC_TITLE_RANGE.min}–
            {DESC_TITLE_RANGE.max}
          </span>
        </span>
      </div>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={`HTML title for ${row.name ?? row.content_key}`}
      />
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button disabled={busy || !dirty} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          className="secondary"
          disabled={busy || (!hasOverride && value.trim() === formula)}
          title={formula}
          onClick={() => {
            setValue(formula);
            if (hasOverride) void persist(null);
          }}
        >
          Reset to formula
        </button>
        <span className="muted" style={{ fontSize: 11 }}>
          {hasOverride ? "Manual override" : "Formula title"}
          {dirty ? " · unsaved" : ""}
        </span>
      </div>
      {err && (
        <div className="alert error" style={{ margin: 0 }}>
          {err}
        </div>
      )}
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
// Orphaned copy — desc_content rows whose product vanished from a re-import.
// Edited/approved text is preserved, never auto-deleted (plan decision 4);
// this card lets the user attach it to a product of the same file, or delete
// a draft they are sure about.
// ---------------------------------------------------------------------------

function snippet(text: string | null, max = 140): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function OrphansCard({
  orphans,
  rows,
  onChanged,
  onError,
}: {
  orphans: ContentRow[];
  rows: DescRow[];
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="card col" style={{ gap: 10 }}>
      <div
        className="row"
        style={{ justifyContent: "space-between", cursor: "pointer" }}
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <strong>Orphaned copy ({orphans.length})</strong>
          <div className="muted" style={{ fontSize: 12 }}>
            These descriptions were kept when their product disappeared from a
            re-imported master list. Attach each one to a product, or delete
            drafts you no longer need.
          </div>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          {open ? "Hide" : "Show"}
        </span>
      </div>
      {open && (
        <div className="col" style={{ gap: 10 }}>
          {orphans.map((o) => (
            <OrphanItem
              key={o.id}
              orphan={o}
              rows={rows}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OrphanItem({
  orphan,
  rows,
  onChanged,
  onError,
}: {
  orphan: ContentRow;
  rows: DescRow[];
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  // Attach targets: products of the SAME slot; rows already holding copy are
  // shown but disabled (the server rejects them with the same rule).
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return rows
      .filter((r) => {
        if (r.slot !== orphan.slot) return false;
        const hay = [r.name ?? "", r.family ?? "", ...r.model_numbers]
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      })
      .slice(0, 8);
  }, [q, rows, orphan.slot]);

  const description = snippet(
    orphan.description_final ?? orphan.description_ai,
  );
  const meta = snippet(orphan.meta_final ?? orphan.meta_ai, 100);

  async function attach(row: DescRow) {
    setBusy(true);
    try {
      await api(`/api/descriptions/content/${orphan.id}/attach`, {
        method: "POST",
        body: JSON.stringify({ content_key: row.content_key }),
      });
      await onChanged();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
      setPicking(false);
      setQ("");
    }
  }

  async function remove() {
    const approved = orphan.status === "approved";
    const ok = confirm(
      approved
        ? "This copy is APPROVED. Delete it permanently anyway?"
        : "Delete this orphaned draft permanently?",
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api(
        `/api/descriptions/content/${orphan.id}${approved ? "?confirm=approved" : ""}`,
        { method: "DELETE" },
      );
      await onChanged();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  /** Rows that hold copy of their own cannot absorb the orphan (server rule). */
  const rowHasCopy = (r: DescRow): boolean =>
    !!r.content &&
    !!(
      r.content.description_final ??
      r.content.description_ai ??
      r.content.meta_final ??
      r.content.meta_ai ??
      r.content.title_override
    );

  return (
    <div className="desc-orphan">
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span
          className="product-sku"
          style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}
        >
          {orphan.content_key}
        </span>
        <StatusTag status={orphan.status} />
        <span className="muted" style={{ fontSize: 11 }}>
          {DESC_SLOT_LABELS[orphan.slot] ?? orphan.slot}
        </span>
      </div>
      {orphan.note && (
        <div className="muted" style={{ fontSize: 12 }}>
          {orphan.note}
        </div>
      )}
      {description && <div style={{ fontSize: 13 }}>{description}</div>}
      {meta && (
        <div className="muted" style={{ fontSize: 12 }}>
          Meta: {meta}
        </div>
      )}
      {orphan.title_override && (
        <div className="muted" style={{ fontSize: 12 }}>
          Title: {orphan.title_override}
        </div>
      )}
      {picking ? (
        <div className="col" style={{ gap: 4, maxWidth: 420 }}>
          <input
            autoFocus
            placeholder="Search product by name, family or model…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ fontSize: 12 }}
          />
          {matches.map((r) => {
            const taken = rowHasCopy(r);
            return (
              <span key={r.id} className="row" style={{ gap: 6, alignItems: "center" }}>
                {taken ? (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {r.name ?? r.content_key} · already has copy
                  </span>
                ) : (
                  <a
                    href="#"
                    style={{ fontSize: 12 }}
                    onClick={(e) => {
                      e.preventDefault();
                      if (!busy) void attach(r);
                    }}
                  >
                    {r.name ?? r.content_key}
                    <span className="muted"> · {r.collection}</span>
                  </a>
                )}
              </span>
            );
          })}
          {q.trim() && matches.length === 0 && (
            <span className="muted" style={{ fontSize: 12 }}>
              No products match in this file.
            </span>
          )}
          <a
            href="#"
            className="muted"
            style={{ fontSize: 11 }}
            onClick={(e) => {
              e.preventDefault();
              setPicking(false);
              setQ("");
            }}
          >
            Cancel
          </a>
        </div>
      ) : (
        <div className="row" style={{ gap: 8 }}>
          <button
            className="secondary"
            style={{ fontSize: 12 }}
            disabled={busy}
            onClick={() => setPicking(true)}
          >
            Attach to product…
          </button>
          <button
            className="secondary"
            style={{ fontSize: 12, color: "var(--danger)" }}
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? "Working…" : "Delete draft"}
          </button>
        </div>
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
          {(phase.summary.kept > 0 || phase.summary.orphaned.length > 0) &&
            ` Descriptions kept on ${phase.summary.kept} product${
              phase.summary.kept === 1 ? "" : "s"
            }${
              phase.summary.orphaned.length > 0
                ? `, ${phase.summary.orphaned.length} orphaned (see the orphaned copy card below the table)`
                : ""
            }.`}
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
