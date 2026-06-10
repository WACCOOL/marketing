import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import mammoth from "mammoth";
import {
  PPT_LAYOUTS,
  PptDeckSchema,
  type PptLayout,
  type PptSlide,
  type PptSlideFields,
  type PptTable,
} from "@wac/shared";
import { ArrowDown, ArrowUp, Copy, Trash2 } from "lucide-react";
import { api, apiBlob } from "../../lib/api.js";
import { createJob, getJob, pollJob } from "../../lib/jobs.js";
import { ImageSlotPicker } from "./ImageSlotPicker.js";
import {
  formatErr,
  generateConceptImage,
  listPptTemplates,
  newSlide,
  PPT_LAYOUT_LABELS,
  type PptTemplate,
} from "./lib.js";

/**
 * PPT Deck Builder: pick a branded template, compose slides in the canonical
 * layout vocabulary (filmstrip on the left, field editor on the right), or
 * draft a whole deck from a Word doc / pasted text, then export through the
 * async "ppt" generation job. The deck only carries content — all styling
 * comes from the template at render time, so switching templates later just
 * re-skins the same slides.
 */

const DRAFT_KEY = "wac-ppt-draft";

/** Which fields the editor exposes per canonical layout. */
const LAYOUT_FIELDS: Record<
  PptLayout,
  {
    subtitle?: boolean;
    bullets?: boolean;
    body?: boolean;
    body2?: boolean;
    images?: number;
    table?: boolean;
  }
> = {
  title: { subtitle: true },
  title_content: { bullets: true, body: true },
  two_column: { body: true, body2: true },
  image_full: { images: 1 },
  image_caption: { images: 4 },
  table: { table: true },
  section: { subtitle: true },
};

interface Draft {
  name: string;
  templateId: string;
  slides: PptSlide[];
  /** image URL → AI prompt that produced it (for the Regenerate field). */
  aiPrompts: Record<string, string>;
}

function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}

/** Trim/strip empty fields so the exported deck is clean for the generator. */
function cleanDeck(templateId: string, slides: PptSlide[]) {
  return {
    templateId,
    slides: slides.map((s) => {
      const f = s.fields;
      const fields: PptSlideFields = {};
      if (f.title?.trim()) fields.title = f.title.trim();
      if (f.subtitle?.trim()) fields.subtitle = f.subtitle.trim();
      if (f.body?.trim()) fields.body = f.body.trim();
      if (f.body2?.trim()) fields.body2 = f.body2.trim();
      const bullets = (f.bullets ?? []).map((b) => b.trim()).filter(Boolean);
      if (bullets.length > 0) fields.bullets = bullets;
      const images = (f.images ?? []).map((i) =>
        i.caption?.trim() ? { url: i.url, caption: i.caption.trim() } : { url: i.url },
      );
      if (images.length > 0) fields.images = images;
      if (f.table) fields.table = f.table;
      return { id: s.id, layout: s.layout, fields };
    }),
  };
}

interface ExportResult {
  jobId: string;
  assetId: string;
  name: string;
  formats: string[];
  warnings: string[];
  thumbUrl: string | null;
}

export function DeckBuilder() {
  const saved = useRef<Draft | null>(loadDraft());

  const [templates, setTemplates] = useState<PptTemplate[]>([]);
  const [templatesErr, setTemplatesErr] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string>(
    saved.current?.templateId ?? "",
  );
  const [slides, setSlides] = useState<PptSlide[]>(saved.current?.slides ?? []);
  const [aiPrompts, setAiPrompts] = useState<Record<string, string>>(
    saved.current?.aiPrompts ?? {},
  );
  const [name, setName] = useState(saved.current?.name ?? "");
  const [selectedId, setSelectedId] = useState<string | null>(
    saved.current?.slides[0]?.id ?? null,
  );
  const [addLayout, setAddLayout] = useState<PptLayout>("title_content");
  const dragIndex = useRef<number | null>(null);

  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  // Draft-from-document
  const [docText, setDocText] = useState("");
  const [docBusy, setDocBusy] = useState(false);

  // Export
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exported, setExported] = useState<ExportResult | null>(null);

  useEffect(() => {
    listPptTemplates()
      .then(setTemplates)
      .catch((e) => setTemplatesErr(formatErr(e)));
  }, []);

  // "Edit" restore: /ppt/builder?restore=<jobId> reloads a finished deck from
  // the job's params (the same mechanism the 3D render Edit buttons use).
  useEffect(() => {
    const jobId = new URLSearchParams(window.location.search).get("restore");
    if (!jobId) return;
    getJob(jobId)
      .then((job) => {
        const parsed = PptDeckSchema.safeParse(job.params);
        if (!parsed.success) {
          setErr("Could not restore this deck: the job's params are not a valid deck.");
          return;
        }
        setTemplateId(parsed.data.templateId);
        setSlides(parsed.data.slides);
        setSelectedId(parsed.data.slides[0]?.id ?? null);
        setName(job.name);
        setExported(null);
      })
      .catch((e) => setErr(formatErr(e)))
      .finally(() => window.history.replaceState(null, "", "/ppt/builder"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Draft persistence: everything needed to come back later.
  useEffect(() => {
    const draft: Draft = { name, templateId, slides, aiPrompts };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // quota — non-critical
    }
  }, [name, templateId, slides, aiPrompts]);

  const template = templates.find((t) => t.id === templateId) ?? null;
  const selected = slides.find((s) => s.id === selectedId) ?? slides[0] ?? null;

  function updateSlide(id: string, fn: (s: PptSlide) => PptSlide) {
    setSlides((prev) => prev.map((s) => (s.id === id ? fn(s) : s)));
  }

  function addSlide(layout: PptLayout) {
    const slide = newSlide(layout);
    setSlides((prev) => [...prev, slide]);
    setSelectedId(slide.id);
  }

  function duplicateSlide(id: string) {
    setSlides((prev) => {
      const i = prev.findIndex((s) => s.id === id);
      const src = prev[i];
      if (!src) return prev;
      const copy: PptSlide = JSON.parse(JSON.stringify(src)) as PptSlide;
      copy.id = crypto.randomUUID();
      const next = [...prev];
      next.splice(i + 1, 0, copy);
      setSelectedId(copy.id);
      return next;
    });
  }

  function deleteSlide(id: string) {
    setSlides((prev) => {
      const i = prev.findIndex((s) => s.id === id);
      const next = prev.filter((s) => s.id !== id);
      if (selectedId === id) {
        setSelectedId(next[Math.min(i, next.length - 1)]?.id ?? null);
      }
      return next;
    });
  }

  function moveSlide(from: number, to: number) {
    setSlides((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [s] = next.splice(from, 1);
      if (!s) return prev;
      next.splice(to, 0, s);
      return next;
    });
  }

  async function readDocx(file: File) {
    setErr(null);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      setDocText(result.value);
    } catch (e) {
      setErr(`Could not read the document: ${formatErr(e)}`);
    }
  }

  async function draftFromText() {
    if (!templateId) {
      setErr("Pick a template before drafting a deck.");
      return;
    }
    const text = docText.trim();
    if (!text) {
      setErr("Upload a .docx or paste text to draft from.");
      return;
    }
    if (
      slides.length > 0 &&
      !confirm("Drafting replaces the current slides. Continue?")
    ) {
      return;
    }
    setDocBusy(true);
    setErr(null);
    try {
      const res = await api<{ deck: { templateId: string; slides: PptSlide[] } }>(
        "/api/ppt/draft",
        { method: "POST", body: JSON.stringify({ text, templateId }) },
      );
      setSlides(res.deck.slides);
      setSelectedId(res.deck.slides[0]?.id ?? null);
      setExported(null);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setDocBusy(false);
    }
  }

  async function exportDeck() {
    setIssues([]);
    setErr(null);
    setExported(null);
    const deck = cleanDeck(templateId, slides);
    const parsed = PptDeckSchema.safeParse(deck);
    if (!parsed.success) {
      setIssues(
        parsed.error.issues.map((i) =>
          i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message,
        ),
      );
      return;
    }
    setExporting(true);
    setExportStatus("Queued…");
    try {
      const jobName =
        name.trim() || `${template?.name ?? "Untitled"} deck`;
      const { jobId } = await createJob("ppt", jobName, parsed.data, [
        `template:${templateId}`,
      ]);
      setExportStatus("Rendering deck…");
      const job = await pollJob(jobId, { timeoutMs: 10 * 60_000 });
      if (job.status !== "succeeded" || !job.assetId) {
        setErr(job.error ?? "Export failed.");
        return;
      }
      // Formats + warnings live on the saved asset row (metadata_json.warnings
      // and asset_files); the jobs endpoint doesn't return asset metadata.
      let formats = job.result?.files?.map((f) => f.format) ?? [];
      let warnings: string[] = [];
      try {
        const res = await api<{
          assets: {
            id: string;
            metadata_json: Record<string, unknown>;
            asset_files: { format: string }[];
          }[];
        }>("/api/assets?tool=ppt");
        const asset = res.assets.find((a) => a.id === job.assetId);
        if (asset) {
          if (asset.asset_files.length > 0) {
            formats = asset.asset_files.map((f) => f.format);
          }
          const w = (asset.metadata_json as { warnings?: unknown }).warnings;
          if (Array.isArray(w)) warnings = w.map(String);
        }
      } catch {
        // metadata is informational only
      }
      // Thumbnail png is optional (LibreOffice may be unavailable server-side).
      let thumbUrl: string | null = null;
      if (formats.length === 0 || formats.includes("png")) {
        try {
          const blob = await apiBlob(`/api/assets/${job.assetId}/files/png`);
          thumbUrl = URL.createObjectURL(blob);
          if (!formats.includes("png")) formats = [...formats, "png"];
        } catch {
          thumbUrl = null;
        }
      }
      setExported({
        jobId,
        assetId: job.assetId,
        name: jobName,
        formats,
        warnings,
        thumbUrl,
      });
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setExporting(false);
      setExportStatus(null);
    }
  }

  async function downloadExport(format: "pptx" | "pdf") {
    if (!exported) return;
    try {
      const blob = await apiBlob(
        `/api/assets/${exported.assetId}/files/${format}`,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${exported.name.replace(/[^\w-]+/g, "-")}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      const status = (e as { status?: number }).status;
      setErr(
        status === 404
          ? `No ${format.toUpperCase()} was produced for this deck.`
          : formatErr(e),
      );
    }
  }

  // ---- Step 1: template picker ----------------------------------------
  if (!templateId) {
    return (
      <div className="col" style={{ gap: 20 }}>
        <div>
          <h2>Deck Builder</h2>
          <div className="muted">
            Pick a branded template to start. Slides carry only content — the
            template controls fonts, colors, and positioning.
          </div>
        </div>
        {templatesErr && <div className="alert error">{templatesErr}</div>}
        {!templatesErr && templates.length === 0 && (
          <div className="muted">
            No templates available yet. An admin can upload one under PPT
            Generator → Templates.
          </div>
        )}
        <div className="product-grid">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              className="product-card"
              onClick={() => setTemplateId(t.id)}
            >
              <div className="product-meta">
                <div className="product-name" title={t.name}>
                  {t.name}
                </div>
                {t.brand && <div className="muted product-brand">{t.brand}</div>}
                <div className="muted product-sku">
                  v{t.version} · updated{" "}
                  {new Date(t.updated_at).toLocaleDateString()}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ---- Editor -----------------------------------------------------------
  return (
    <div className="col" style={{ gap: 16 }}>
      <div>
        <h2>Deck Builder</h2>
        <div className="muted">
          Compose slides, draft from a document, then export a branded .pptx.
          Drafts persist in this browser automatically.
        </div>
      </div>

      {err && <div className="alert error">{err}</div>}
      {templatesErr && <div className="alert error">{templatesErr}</div>}
      {issues.length > 0 && (
        <div className="alert error">
          <strong>Fix before exporting:</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {issues.map((i, n) => (
              <li key={n}>{i}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card row" style={{ gap: 8, flexWrap: "wrap" }}>
        <label className="muted" style={{ fontSize: 13 }}>
          Template
        </label>
        <select
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          style={{ maxWidth: 280 }}
        >
          {!template && <option value={templateId}>(unavailable template)</option>}
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.brand ? ` (${t.brand})` : ""}
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 12 }}>
          Switching keeps your slides and re-skins the next export.
        </span>
        <span style={{ flex: 1 }} />
        <input
          placeholder={`Deck name (default: ${template?.name ?? "template"} deck)`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ minWidth: 240 }}
        />
        <button onClick={() => void exportDeck()} disabled={exporting || slides.length === 0}>
          {exporting ? <span className="spinner" /> : null}
          {exporting ? exportStatus ?? "Exporting…" : "Export deck"}
        </button>
      </div>

      {exported && (
        <div className="card col" style={{ gap: 10 }}>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <h3 style={{ margin: 0 }}>Deck ready</h3>
            <div className="row" style={{ gap: 8 }}>
              <button onClick={() => void downloadExport("pptx")}>
                Download PPTX
              </button>
              {exported.formats.includes("pdf") && (
                <button className="secondary" onClick={() => void downloadExport("pdf")}>
                  Download PDF
                </button>
              )}
              <Link to="/ppt/decks">
                <button className="secondary">Open My Decks</button>
              </Link>
            </div>
          </div>
          {exported.warnings.length > 0 && (
            <div className="alert warn">
              <strong>Warnings:</strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {exported.warnings.map((w, n) => (
                  <li key={n}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {exported.thumbUrl && (
            <img
              src={exported.thumbUrl}
              alt="First slide preview"
              style={{ maxWidth: 360, borderRadius: "var(--radius)", border: "1px solid var(--border)" }}
            />
          )}
          <div className="muted" style={{ fontSize: 12 }}>
            Saved to My Decks. You can re-open it there with Edit.
          </div>
        </div>
      )}

      <div className="ppt-editor">
        {/* LEFT: filmstrip */}
        <div className="ppt-filmstrip">
          {slides.map((s, i) => (
            <div
              key={s.id}
              className={`ppt-slide-item${selected?.id === s.id ? " selected" : ""}`}
              draggable
              onDragStart={() => {
                dragIndex.current = i;
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex.current !== null && dragIndex.current !== i) {
                  moveSlide(dragIndex.current, i);
                }
                dragIndex.current = null;
              }}
              onClick={() => setSelectedId(s.id)}
            >
              <div className="ppt-slide-num muted">{i + 1}</div>
              <div className="ppt-slide-main">
                <SlideThumb slide={s} />
                <div className="muted ppt-slide-layout">
                  {PPT_LAYOUT_LABELS[s.layout]}
                </div>
              </div>
              <div className="ppt-slide-actions">
                <button
                  type="button"
                  className="icon-btn"
                  title="Move up"
                  disabled={i === 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    moveSlide(i, i - 1);
                  }}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Move down"
                  disabled={i === slides.length - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    moveSlide(i, i + 1);
                  }}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Duplicate"
                  onClick={(e) => {
                    e.stopPropagation();
                    duplicateSlide(s.id);
                  }}
                >
                  <Copy size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSlide(s.id);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}

          <div className="row" style={{ gap: 6 }}>
            <select
              value={addLayout}
              onChange={(e) => setAddLayout(e.target.value as PptLayout)}
              style={{ flex: 1 }}
            >
              {PPT_LAYOUTS.map((l) => (
                <option key={l} value={l}>
                  {PPT_LAYOUT_LABELS[l]}
                </option>
              ))}
            </select>
            <button onClick={() => addSlide(addLayout)}>Add slide</button>
          </div>
        </div>

        {/* RIGHT: slide editor or document drafting */}
        <div className="col" style={{ gap: 16 }}>
          {selected ? (
            <SlideEditor
              key={selected.id}
              slide={selected}
              aiPrompts={aiPrompts}
              setAiPrompt={(url, prompt) =>
                setAiPrompts((prev) => ({ ...prev, [url]: prompt }))
              }
              onChange={(fn) => updateSlide(selected.id, fn)}
              onError={setErr}
            />
          ) : (
            <div className="card muted">
              No slides yet — add one on the left, or draft a deck from a
              document below.
            </div>
          )}

          <div className="card col" style={{ gap: 10 }}>
            <h3 style={{ margin: 0 }}>Draft from document</h3>
            <div className="muted" style={{ fontSize: 13 }}>
              Upload a Word doc or paste text; AI structures it into slides for
              review. Drafting replaces the current slides.
            </div>
            <input
              type="file"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void readDocx(f);
                e.target.value = "";
              }}
            />
            <textarea
              rows={5}
              value={docText}
              onChange={(e) => setDocText(e.target.value)}
              placeholder="…or paste the source text here."
            />
            <div className="row">
              <button onClick={() => void draftFromText()} disabled={docBusy}>
                {docBusy ? <span className="spinner" /> : null}
                {docBusy ? "Drafting…" : "Draft deck"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filmstrip thumbnails: tiny CSS sketches of each canonical layout.
// ---------------------------------------------------------------------------

function SlideThumb({ slide }: { slide: PptSlide }) {
  const img = slide.fields.images?.[0]?.url ?? null;
  switch (slide.layout) {
    case "title":
      return (
        <div className="ppt-slide-thumb ppt-thumb-centered">
          <div className="ppt-thumb-bar" style={{ width: "70%" }} />
          <div className="ppt-thumb-line" style={{ width: "45%" }} />
        </div>
      );
    case "section":
      return (
        <div className="ppt-slide-thumb ppt-thumb-centered">
          <div className="ppt-thumb-bar" style={{ width: "80%", height: 8 }} />
        </div>
      );
    case "title_content":
      return (
        <div className="ppt-slide-thumb">
          <div className="ppt-thumb-bar" style={{ width: "60%" }} />
          <div className="ppt-thumb-line" />
          <div className="ppt-thumb-line" />
          <div className="ppt-thumb-line" style={{ width: "70%" }} />
        </div>
      );
    case "two_column":
      return (
        <div className="ppt-slide-thumb">
          <div className="ppt-thumb-bar" style={{ width: "60%" }} />
          <div className="ppt-thumb-cols">
            <div className="ppt-thumb-block" />
            <div className="ppt-thumb-block" />
          </div>
        </div>
      );
    case "image_full":
      return (
        <div className="ppt-slide-thumb ppt-thumb-image">
          {img ? <img src={img} alt="" /> : <div className="ppt-thumb-block" style={{ flex: 1 }} />}
        </div>
      );
    case "image_caption":
      return (
        <div className="ppt-slide-thumb">
          <div className="ppt-thumb-image" style={{ flex: 1 }}>
            {img ? <img src={img} alt="" /> : <div className="ppt-thumb-block" style={{ height: "100%" }} />}
          </div>
          <div className="ppt-thumb-line" style={{ width: "50%" }} />
        </div>
      );
    case "table":
      return (
        <div className="ppt-slide-thumb">
          <div className="ppt-thumb-bar" style={{ width: "50%" }} />
          <div className="ppt-thumb-grid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} />
            ))}
          </div>
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// Right-pane editor for the selected slide.
// ---------------------------------------------------------------------------

function SlideEditor(props: {
  slide: PptSlide;
  aiPrompts: Record<string, string>;
  setAiPrompt: (url: string, prompt: string) => void;
  onChange: (fn: (s: PptSlide) => PptSlide) => void;
  onError: (msg: string | null) => void;
}) {
  const { slide } = props;
  const cfg = LAYOUT_FIELDS[slide.layout];

  function setField<K extends keyof PptSlideFields>(
    key: K,
    value: PptSlideFields[K],
  ) {
    props.onChange((s) => ({ ...s, fields: { ...s.fields, [key]: value } }));
  }

  return (
    <div className="card col" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Slide</h3>
        <div className="row" style={{ gap: 8 }}>
          <label className="muted" style={{ fontSize: 13 }}>
            Layout
          </label>
          <select
            value={slide.layout}
            onChange={(e) =>
              props.onChange((s) => ({
                ...s,
                layout: e.target.value as PptLayout,
              }))
            }
          >
            {PPT_LAYOUTS.map((l) => (
              <option key={l} value={l}>
                {PPT_LAYOUT_LABELS[l]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <input
        placeholder="Title"
        value={slide.fields.title ?? ""}
        onChange={(e) => setField("title", e.target.value)}
      />

      {cfg.subtitle && (
        <input
          placeholder="Subtitle"
          value={slide.fields.subtitle ?? ""}
          onChange={(e) => setField("subtitle", e.target.value)}
        />
      )}

      {cfg.bullets && (
        <div className="col" style={{ gap: 4 }}>
          <label className="muted" style={{ fontSize: 13 }}>
            Bullets (one per line)
          </label>
          <textarea
            rows={5}
            value={(slide.fields.bullets ?? []).join("\n")}
            onChange={(e) =>
              setField(
                "bullets",
                e.target.value.length > 0 ? e.target.value.split("\n") : [],
              )
            }
            placeholder={"First point\nSecond point"}
          />
        </div>
      )}

      {cfg.body && (
        <div className="col" style={{ gap: 4 }}>
          <label className="muted" style={{ fontSize: 13 }}>
            {cfg.body2 ? "Left column" : "Body"}
          </label>
          <textarea
            rows={4}
            value={slide.fields.body ?? ""}
            onChange={(e) => setField("body", e.target.value)}
          />
        </div>
      )}

      {cfg.body2 && (
        <div className="col" style={{ gap: 4 }}>
          <label className="muted" style={{ fontSize: 13 }}>
            Right column
          </label>
          <textarea
            rows={4}
            value={slide.fields.body2 ?? ""}
            onChange={(e) => setField("body2", e.target.value)}
          />
        </div>
      )}

      {cfg.table && (
        <TableEditor
          table={slide.fields.table ?? null}
          onChange={(t) => setField("table", t ?? undefined)}
        />
      )}

      {(cfg.images ?? 0) > 0 && (
        <ImageSlots
          slide={slide}
          max={cfg.images ?? 1}
          aiPrompts={props.aiPrompts}
          setAiPrompt={props.setAiPrompt}
          setImages={(images) =>
            setField("images", images.length > 0 ? images : undefined)
          }
          onError={props.onError}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Image slots: list current images + add via Product/Upload/AI picker.
// ---------------------------------------------------------------------------

function ImageSlots(props: {
  slide: PptSlide;
  max: number;
  aiPrompts: Record<string, string>;
  setAiPrompt: (url: string, prompt: string) => void;
  setImages: (images: { url: string; caption?: string }[]) => void;
  onError: (msg: string | null) => void;
}) {
  const images = props.slide.fields.images ?? [];
  const withCaptions = props.slide.layout === "image_caption";
  const [regenBusy, setRegenBusy] = useState<string | null>(null);
  const [regenPrompts, setRegenPrompts] = useState<Record<string, string>>({});

  async function regenerate(url: string) {
    const prompt = (regenPrompts[url] ?? props.aiPrompts[url] ?? "").trim();
    if (!prompt) return;
    setRegenBusy(url);
    props.onError(null);
    try {
      const newUrl = await generateConceptImage(prompt);
      props.setImages(
        images.map((img) => (img.url === url ? { ...img, url: newUrl } : img)),
      );
      props.setAiPrompt(newUrl, prompt);
    } catch (e) {
      props.onError(formatErr(e));
    } finally {
      setRegenBusy(null);
    }
  }

  return (
    <div className="col" style={{ gap: 10 }}>
      <label className="muted" style={{ fontSize: 13 }}>
        Images ({images.length}/{props.max})
      </label>

      {images.map((img, i) => {
        const aiPrompt = props.aiPrompts[img.url];
        return (
          <div key={`${img.url}-${i}`} className="ppt-deck-image">
            <img src={img.url} alt="" />
            <div className="col" style={{ gap: 6, flex: 1, minWidth: 0 }}>
              {withCaptions && (
                <input
                  placeholder="Caption"
                  value={img.caption ?? ""}
                  onChange={(e) =>
                    props.setImages(
                      images.map((m, n) =>
                        n === i ? { ...m, caption: e.target.value } : m,
                      ),
                    )
                  }
                />
              )}
              {aiPrompt !== undefined && (
                <div className="row" style={{ gap: 6 }}>
                  <input
                    placeholder="AI prompt"
                    value={regenPrompts[img.url] ?? aiPrompt}
                    onChange={(e) =>
                      setRegenPrompts((prev) => ({
                        ...prev,
                        [img.url]: e.target.value,
                      }))
                    }
                    style={{ flex: 1 }}
                  />
                  <button
                    className="secondary"
                    onClick={() => void regenerate(img.url)}
                    disabled={regenBusy !== null}
                  >
                    {regenBusy === img.url ? <span className="spinner" /> : null}
                    Regenerate
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="icon-btn"
              title="Remove image"
              onClick={() => props.setImages(images.filter((_, n) => n !== i))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}

      {images.length < props.max && (
        <ImageSlotPicker
          onAdd={({ url, aiPrompt }) => {
            props.setImages([...images, { url }]);
            if (aiPrompt) props.setAiPrompt(url, aiPrompt);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table editor.
// ---------------------------------------------------------------------------

const EMPTY_TABLE: PptTable = { headers: ["Column 1", "Column 2"], rows: [["", ""]] };

function TableEditor(props: {
  table: PptTable | null;
  onChange: (t: PptTable | null) => void;
}) {
  const table = props.table;

  if (!table) {
    return (
      <div>
        <button className="secondary" onClick={() => props.onChange(EMPTY_TABLE)}>
          Add table
        </button>
      </div>
    );
  }

  function update(fn: (t: PptTable) => PptTable) {
    props.onChange(fn(table!));
  }

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="ppt-table-scroll">
        <table className="ppt-table-editor">
          <thead>
            <tr>
              {table.headers.map((h, c) => (
                <th key={c}>
                  <input
                    value={h}
                    placeholder={`Header ${c + 1}`}
                    onChange={(e) =>
                      update((t) => ({
                        ...t,
                        headers: t.headers.map((x, n) =>
                          n === c ? e.target.value : x,
                        ),
                      }))
                    }
                  />
                </th>
              ))}
              <th style={{ width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={r}>
                {table.headers.map((_, c) => (
                  <td key={c}>
                    <input
                      value={row[c] ?? ""}
                      onChange={(e) =>
                        update((t) => ({
                          ...t,
                          rows: t.rows.map((rr, rn) =>
                            rn === r
                              ? t.headers.map((__, cn) =>
                                  cn === c ? e.target.value : rr[cn] ?? "",
                                )
                              : rr,
                          ),
                        }))
                      }
                    />
                  </td>
                ))}
                <td>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Remove row"
                    onClick={() =>
                      update((t) => ({
                        ...t,
                        rows: t.rows.filter((_, n) => n !== r),
                      }))
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <button
          className="secondary"
          onClick={() =>
            update((t) => ({ ...t, rows: [...t.rows, t.headers.map(() => "")] }))
          }
        >
          Add row
        </button>
        <button
          className="secondary"
          onClick={() =>
            update((t) => ({
              headers: [...t.headers, `Column ${t.headers.length + 1}`],
              rows: t.rows.map((r) => [...r, ""]),
            }))
          }
        >
          Add column
        </button>
        <button
          className="secondary"
          disabled={table.headers.length <= 1}
          onClick={() =>
            update((t) => ({
              headers: t.headers.slice(0, -1),
              rows: t.rows.map((r) => r.slice(0, t.headers.length - 1)),
            }))
          }
        >
          Remove column
        </button>
        <button className="secondary" onClick={() => props.onChange(null)}>
          Remove table
        </button>
      </div>
    </div>
  );
}
