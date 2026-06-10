import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import mammoth from "mammoth";
import {
  PPT_CHART_TYPES,
  PPT_LAYOUTS,
  PptDeckSchema,
  type PptChart,
  type PptChartType,
  type PptImage,
  type PptLayout,
  type PptQuote,
  type PptSlide,
  type PptSlideFields,
  type PptTable,
  type PptVideo,
} from "@wac/shared";
import { ArrowDown, ArrowUp, Copy, Trash2 } from "lucide-react";
import { api, apiBlob } from "../../lib/api.js";
import { createJob, getJob, pollJob } from "../../lib/jobs.js";
import {
  isAllowedVideoType,
  MAX_VIDEO_BYTES,
  uploadImage,
  uploadVideo,
} from "../../lib/uploads.js";
import { ImageSlotPicker } from "./ImageSlotPicker.js";
import { SlidePreview } from "./SlidePreview.js";
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
    /** Custom label for the bullets textarea (agenda). */
    bulletsLabel?: string;
    body?: boolean;
    body2?: boolean;
    images?: number;
    table?: boolean;
    quote?: boolean;
    chart?: boolean;
    /** Label for the items textarea (diagram/process). */
    items?: string;
    video?: boolean;
  }
> = {
  title: { subtitle: true },
  title_content: { bullets: true, body: true },
  title_content_image: { bullets: true, body: true, images: 1 },
  two_column: { body: true, body2: true },
  image_full: { images: 1 },
  image_caption: { images: 4 },
  agenda: { bullets: true, bulletsLabel: "Agenda items (one per line)" },
  quote: { quote: true },
  chart: { chart: true },
  diagram: { items: "Boxes (one per line)" },
  process: { items: "Steps (one per line)" },
  video: { video: true },
  table: { table: true },
  section: { subtitle: true },
};

const CHART_TYPE_LABELS: Record<PptChartType, string> = {
  column: "Column",
  bar: "Bar",
  line: "Line",
  pie: "Pie",
};

interface Draft {
  name: string;
  templateId: string;
  slides: PptSlide[];
  /** image URL → AI prompt that produced it. Legacy — new images carry the
   * prompt on the image object itself; this sidecar keeps old drafts working. */
  aiPrompts: Record<string, string>;
  /** Asset this deck edits in place (exports update it instead of creating). */
  deckAssetId: string | null;
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
function cleanDeck(
  templateId: string,
  slides: PptSlide[],
  replaceAssetId: string | null,
) {
  return {
    templateId,
    ...(replaceAssetId ? { replaceAssetId } : {}),
    slides: slides.map((s) => {
      const f = s.fields;
      const fields: PptSlideFields = {};
      if (f.title?.trim()) fields.title = f.title.trim();
      if (f.subtitle?.trim()) fields.subtitle = f.subtitle.trim();
      if (f.body?.trim()) fields.body = f.body.trim();
      if (f.body2?.trim()) fields.body2 = f.body2.trim();
      const bullets = (f.bullets ?? []).map((b) => b.trim()).filter(Boolean);
      if (bullets.length > 0) fields.bullets = bullets;
      const images = (f.images ?? []).map((i) => {
        const img: PptImage = { url: i.url };
        if (i.caption?.trim()) img.caption = i.caption.trim();
        if (i.prompt?.trim()) img.prompt = i.prompt.trim();
        return img;
      });
      if (images.length > 0) fields.images = images;
      if (f.table) fields.table = f.table;
      if (f.quote?.text.trim()) {
        fields.quote = f.quote.attribution?.trim()
          ? { text: f.quote.text.trim(), attribution: f.quote.attribution.trim() }
          : { text: f.quote.text.trim() };
      }
      if (f.chart) {
        fields.chart = {
          chartType: f.chart.chartType,
          categories: f.chart.categories.map((c) => c.trim()),
          series: f.chart.series.map((sr) => ({
            name: sr.name.trim(),
            values: sr.values,
          })),
        };
      }
      const items = (f.items ?? []).map((x) => x.trim()).filter(Boolean);
      if (items.length > 0) fields.items = items;
      if (f.video?.url.trim()) {
        fields.video = f.video.caption?.trim()
          ? { url: f.video.url.trim(), caption: f.video.caption.trim() }
          : { url: f.video.url.trim() };
      }
      if (f.imagePrompt?.trim()) fields.imagePrompt = f.imagePrompt.trim();
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

// ---- Docx → marked text ----------------------------------------------------
// Images extracted from the doc are uploaded and replaced by [IMAGE:n] markers
// the /api/ppt/draft endpoint resolves back onto the drafted slides.

const MAX_DOC_IMAGES = 10;
const MAX_DOC_IMAGE_BYTES = 10 * 1024 * 1024;
const DOC_IMAGE_SRC_PREFIX = "wac-doc-image:";

/**
 * Flatten mammoth's HTML into plain text: one line per block element, with
 * each extracted image emitted as a `[IMAGE:n]` marker on its own line.
 */
function docHtmlToMarkedText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const lines: string[] = [];
  emitDocBlocks(doc.body, lines);
  return lines.join("\n\n");
}

const DOC_CONTAINER_TAGS = new Set([
  "ul",
  "ol",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "div",
  "section",
]);

function emitDocBlocks(el: Element, lines: string[]) {
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "img") {
      emitDocImage(child, lines);
    } else if (DOC_CONTAINER_TAGS.has(tag)) {
      emitDocBlocks(child, lines);
    } else {
      // Block leaf (p, h1–h6, li, td/th…): its images become marker lines,
      // then whatever text remains becomes one line.
      for (const img of Array.from(child.querySelectorAll("img"))) {
        emitDocImage(img, lines);
        img.remove();
      }
      const text = (child.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text) lines.push(text);
    }
  }
}

function emitDocImage(img: Element, lines: string[]) {
  const src = img.getAttribute("src") ?? "";
  if (!src.startsWith(DOC_IMAGE_SRC_PREFIX)) return; // skipped/oversized image
  const ref = Number(src.slice(DOC_IMAGE_SRC_PREFIX.length));
  if (Number.isInteger(ref) && ref >= 1 && ref <= 99) {
    lines.push(`[IMAGE:${ref}]`);
  }
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
  const [deckAssetId, setDeckAssetId] = useState<string | null>(
    saved.current?.deckAssetId ?? null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    saved.current?.slides[0]?.id ?? null,
  );
  const [addLayout, setAddLayout] = useState<PptLayout>("title_content");
  const dragIndex = useRef<number | null>(null);

  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  // Draft-from-document
  const [docText, setDocText] = useState("");
  const [docImages, setDocImages] = useState<{ ref: number; url: string }[]>([]);
  const [docNote, setDocNote] = useState<string | null>(null);
  const [docReading, setDocReading] = useState(false);
  const [docBusy, setDocBusy] = useState(false);

  // Auto-generation of drafted slide images (fields.imagePrompt)
  const [genStatus, setGenStatus] = useState<string | null>(null);
  const [genWarning, setGenWarning] = useState<string | null>(null);

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
  // the job's params (the same mechanism the 3D render Edit buttons use) and
  // links it to the existing asset so exports update it in place.
  // "Clone": /ppt/builder?clone=<jobId> loads the same deck unlinked, so the
  // next export creates a new asset.
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const cloneId = search.get("clone");
    const jobId = search.get("restore") ?? cloneId;
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
        setName(cloneId ? `Copy of ${job.name}` : job.name);
        setDeckAssetId(cloneId ? null : job.assetId);
        setExported(null);
      })
      .catch((e) => setErr(formatErr(e)))
      .finally(() => window.history.replaceState(null, "", "/ppt/builder"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Draft persistence: everything needed to come back later.
  useEffect(() => {
    const draft: Draft = { name, templateId, slides, aiPrompts, deckAssetId };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // quota — non-critical
    }
  }, [name, templateId, slides, aiPrompts, deckAssetId]);

  const template = templates.find((t) => t.id === templateId) ?? null;
  const selected = slides.find((s) => s.id === selectedId) ?? slides[0] ?? null;
  const deckLabel = name.trim() || `${template?.name ?? "Untitled"} deck`;

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

  /** Blank slate (keeps the selected template); the draft effect persists it. */
  function startOver() {
    if (!confirm("Start over? This clears the current slides and starts a new deck.")) {
      return;
    }
    setSlides([]);
    setSelectedId(null);
    setName("");
    setAiPrompts({});
    setExported(null);
    setDocText("");
    setDocImages([]);
    setDocNote(null);
    setIssues([]);
    setErr(null);
    setGenStatus(null);
    setGenWarning(null);
    setDeckAssetId(null);
  }

  async function readDocx(file: File) {
    setErr(null);
    setDocNote(null);
    setDocReading(true);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const collected: { ref: number; url: string }[] = [];
      const notes: string[] = [];
      let accepted = 0;
      let skippedExtra = 0;
      const result = await mammoth.convertToHtml(
        { arrayBuffer },
        {
          // Each embedded image is uploaded to /api/uploads; the HTML keeps a
          // sentinel src that docHtmlToMarkedText turns into [IMAGE:n].
          convertImage: mammoth.images.imgElement(async (image) => {
            if (accepted >= MAX_DOC_IMAGES) {
              skippedExtra += 1;
              return { src: "" };
            }
            try {
              const bytes = await image.readAsArrayBuffer();
              if (bytes.byteLength > MAX_DOC_IMAGE_BYTES) {
                notes.push("Skipped an image over 10MB.");
                return { src: "" };
              }
              const ref = ++accepted;
              const ext = (image.contentType.split("/")[1] ?? "png").split("+")[0];
              const upload = new File([bytes], `doc-image-${ref}.${ext}`, {
                type: image.contentType,
              });
              const { url } = await uploadImage(upload);
              collected.push({ ref, url });
              return { src: `${DOC_IMAGE_SRC_PREFIX}${ref}` };
            } catch (e) {
              notes.push(`Skipped an image that could not be uploaded (${formatErr(e)}).`);
              return { src: "" };
            }
          }),
        },
      );
      if (skippedExtra > 0) {
        notes.push(
          `Only the first ${MAX_DOC_IMAGES} images were carried over (${skippedExtra} skipped).`,
        );
      }
      setDocText(docHtmlToMarkedText(result.value));
      setDocImages(collected);
      if (notes.length > 0) setDocNote(notes.join(" "));
    } catch (e) {
      setErr(`Could not read the document: ${formatErr(e)}`);
    } finally {
      setDocReading(false);
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
    setGenWarning(null);
    try {
      const body: {
        text: string;
        templateId: string;
        images?: { ref: number; url: string }[];
      } = { text, templateId };
      if (docImages.length > 0) body.images = docImages;
      const res = await api<{ deck: { templateId: string; slides: PptSlide[] } }>(
        "/api/ppt/draft",
        { method: "POST", body: JSON.stringify(body) },
      );
      setSlides(res.deck.slides);
      setSelectedId(res.deck.slides[0]?.id ?? null);
      setExported(null);
      await autoGenerateImages(res.deck.slides);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setDocBusy(false);
    }
  }

  /**
   * Generate an image for every drafted slide that carries an imagePrompt but
   * no images yet (concurrency 2). Successes land on fields.images with the
   * prompt attached; failures keep the prompt so "Generate image" can retry.
   */
  async function autoGenerateImages(drafted: PptSlide[]) {
    const targets = drafted.filter(
      (s) =>
        (s.fields.imagePrompt ?? "").trim().length > 0 &&
        (s.fields.images?.length ?? 0) === 0,
    );
    if (targets.length === 0) return;
    const total = targets.length;
    let done = 0;
    const failures: string[] = [];
    setGenStatus(`Generating slide images 0/${total}…`);
    const queue = [...targets];
    const worker = async () => {
      for (;;) {
        const slide = queue.shift();
        if (!slide) return;
        const prompt = (slide.fields.imagePrompt ?? "").trim();
        try {
          const url = await generateConceptImage(prompt);
          setSlides((prev) =>
            prev.map((s) => {
              if (s.id !== slide.id) return s;
              const fields: PptSlideFields = {
                ...s.fields,
                images: [{ url, prompt }],
              };
              delete fields.imagePrompt;
              return { ...s, fields };
            }),
          );
        } catch (e) {
          failures.push(`slide ${drafted.indexOf(slide) + 1}: ${formatErr(e)}`);
        }
        done += 1;
        setGenStatus(`Generating slide images ${done}/${total}…`);
      }
    };
    await Promise.all([worker(), worker()]);
    setGenStatus(null);
    if (failures.length > 0) {
      setGenWarning(
        `Could not generate ${failures.length === 1 ? "an image" : `${failures.length} images`} (${failures.join(
          "; ",
        )}). The prompts stay on those slides — use “Generate image” there to retry.`,
      );
    }
  }

  async function exportDeck() {
    setIssues([]);
    setErr(null);
    setExported(null);
    const deck = cleanDeck(templateId, slides, deckAssetId);
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
      const jobName = deckLabel;
      const { jobId } = await createJob("ppt", jobName, parsed.data, [
        `template:${templateId}`,
      ]);
      setExportStatus("Rendering deck…");
      const job = await pollJob(jobId, { timeoutMs: 10 * 60_000 });
      if (job.status !== "succeeded" || !job.assetId) {
        setErr(job.error ?? "Export failed.");
        return;
      }
      // Further exports keep updating this deck asset in place.
      setDeckAssetId(job.assetId);
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
      {genStatus && (
        <div className="card row" style={{ gap: 8 }}>
          <span className="spinner" />
          <span className="muted">{genStatus}</span>
        </div>
      )}
      {genWarning && <div className="alert warn">{genWarning}</div>}

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
        {(slides.length > 0 || deckAssetId !== null) && (
          <button className="secondary" onClick={startOver} disabled={exporting}>
            Start over
          </button>
        )}
        <button onClick={() => void exportDeck()} disabled={exporting || slides.length === 0}>
          {exporting ? <span className="spinner" /> : null}
          {exporting
            ? exportStatus ?? "Exporting…"
            : deckAssetId
              ? "Save deck"
              : "Export deck"}
        </button>
        {deckAssetId && (
          <div className="muted" style={{ width: "100%", fontSize: 12 }}>
            Exports update “{deckLabel}” in My Decks — use Clone there for a
            copy.
          </div>
        )}
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
            Saved to My Decks. Further exports here update it in place; use
            Clone there for a copy.
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
                <SlidePreview slide={s} size="thumb" />
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

          <div className="ppt-filmstrip-add row" style={{ gap: 6 }}>
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
            <>
              <SlidePreview slide={selected} size="full" />
              <SlideEditor
                key={selected.id}
                slide={selected}
                aiPrompts={aiPrompts}
                onChange={(fn) => updateSlide(selected.id, fn)}
                onError={setErr}
              />
            </>
          ) : (
            <div className="card muted">
              No slides yet — add one on the left, or draft a deck from a
              document below.
            </div>
          )}

          {slides.length === 0 && (
            <div className="card col" style={{ gap: 10 }}>
              <h3 style={{ margin: 0 }}>Draft from document</h3>
              <div className="muted" style={{ fontSize: 13 }}>
                Upload a Word doc or paste text; AI structures it into slides
                for review. Document images come along, and described images
                are generated automatically.
              </div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <input
                  type="file"
                  accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  disabled={docReading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void readDocx(f);
                    e.target.value = "";
                  }}
                />
                {docReading && (
                  <span className="muted">
                    <span className="spinner" /> Reading document…
                  </span>
                )}
              </div>
              {docNote && (
                <div className="muted" style={{ fontSize: 12 }}>
                  {docNote}
                </div>
              )}
              <textarea
                rows={5}
                value={docText}
                onChange={(e) => setDocText(e.target.value)}
                placeholder="…or paste the source text here."
              />
              <div className="row">
                <button
                  onClick={() => void draftFromText()}
                  disabled={docBusy || docReading}
                >
                  {docBusy ? <span className="spinner" /> : null}
                  {docBusy ? "Drafting…" : "Draft deck"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right-pane editor for the selected slide.
// ---------------------------------------------------------------------------

function SlideEditor(props: {
  slide: PptSlide;
  /** Legacy url → prompt sidecar (old drafts); new images carry img.prompt. */
  aiPrompts: Record<string, string>;
  onChange: (fn: (s: PptSlide) => PptSlide) => void;
  onError: (msg: string | null) => void;
}) {
  const { slide } = props;
  const cfg = LAYOUT_FIELDS[slide.layout];
  const [promptBusy, setPromptBusy] = useState(false);

  function setField<K extends keyof PptSlideFields>(
    key: K,
    value: PptSlideFields[K],
  ) {
    props.onChange((s) => ({ ...s, fields: { ...s.fields, [key]: value } }));
  }

  function setQuote(patch: Partial<PptQuote>) {
    const next: PptQuote = { text: "", ...slide.fields.quote, ...patch };
    setField("quote", next.text || next.attribution ? next : undefined);
  }

  /** Turn the drafted imagePrompt into a generated image on this slide. */
  async function generateFromPrompt() {
    const prompt = (slide.fields.imagePrompt ?? "").trim();
    if (!prompt) return;
    setPromptBusy(true);
    props.onError(null);
    try {
      const url = await generateConceptImage(prompt);
      props.onChange((s) => {
        const fields: PptSlideFields = {
          ...s.fields,
          images: [...(s.fields.images ?? []), { url, prompt }],
        };
        delete fields.imagePrompt;
        return { ...s, fields };
      });
    } catch (e) {
      props.onError(formatErr(e));
    } finally {
      setPromptBusy(false);
    }
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
            {cfg.bulletsLabel ?? "Bullets (one per line)"}
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

      {cfg.quote && (
        <div className="col" style={{ gap: 6 }}>
          <label className="muted" style={{ fontSize: 13 }}>
            Quote
          </label>
          <textarea
            rows={3}
            value={slide.fields.quote?.text ?? ""}
            onChange={(e) => setQuote({ text: e.target.value })}
            placeholder="The pull quote…"
          />
          <input
            placeholder="Attribution (optional)"
            value={slide.fields.quote?.attribution ?? ""}
            onChange={(e) => setQuote({ attribution: e.target.value })}
          />
        </div>
      )}

      {cfg.chart && (
        <ChartEditor
          chart={slide.fields.chart ?? null}
          onChange={(c) => setField("chart", c ?? undefined)}
        />
      )}

      {cfg.items && (
        <div className="col" style={{ gap: 4 }}>
          <label className="muted" style={{ fontSize: 13 }}>
            {cfg.items}
          </label>
          <textarea
            rows={5}
            value={(slide.fields.items ?? []).join("\n")}
            onChange={(e) =>
              setField(
                "items",
                e.target.value.length > 0
                  ? e.target.value.split("\n")
                  : undefined,
              )
            }
            placeholder={"First\nSecond\nThird"}
          />
        </div>
      )}

      {cfg.video && (
        <VideoEditor
          video={slide.fields.video ?? null}
          onChange={(v) => setField("video", v ?? undefined)}
          onError={props.onError}
        />
      )}

      {cfg.table && (
        <TableEditor
          table={slide.fields.table ?? null}
          onChange={(t) => setField("table", t ?? undefined)}
        />
      )}

      {slide.fields.imagePrompt !== undefined && (
        <div className="col" style={{ gap: 4 }}>
          <label className="muted" style={{ fontSize: 13 }}>
            AI image prompt
          </label>
          <div className="row" style={{ gap: 6 }}>
            <input
              value={slide.fields.imagePrompt}
              onChange={(e) => setField("imagePrompt", e.target.value)}
              placeholder="Describe the image to generate…"
              style={{ flex: 1 }}
            />
            <button
              className="secondary"
              onClick={() => void generateFromPrompt()}
              disabled={promptBusy || !slide.fields.imagePrompt.trim()}
            >
              {promptBusy ? <span className="spinner" /> : null}
              Generate image
            </button>
          </div>
        </div>
      )}

      {(cfg.images ?? 0) > 0 && (
        <ImageSlots
          slide={slide}
          max={cfg.images ?? 1}
          aiPrompts={props.aiPrompts}
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
  /** Legacy url → prompt sidecar; new images carry img.prompt directly. */
  aiPrompts: Record<string, string>;
  setImages: (images: PptImage[]) => void;
  onError: (msg: string | null) => void;
}) {
  const images = props.slide.fields.images ?? [];
  const withCaptions = props.slide.layout === "image_caption";
  const [regenBusy, setRegenBusy] = useState<string | null>(null);
  const [regenPrompts, setRegenPrompts] = useState<Record<string, string>>({});

  async function regenerate(img: PptImage) {
    const prompt = (
      regenPrompts[img.url] ??
      img.prompt ??
      props.aiPrompts[img.url] ??
      ""
    ).trim();
    if (!prompt) return;
    setRegenBusy(img.url);
    props.onError(null);
    try {
      const newUrl = await generateConceptImage(prompt);
      props.setImages(
        images.map((m) =>
          m.url === img.url ? { ...m, url: newUrl, prompt } : m,
        ),
      );
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
        const aiPrompt = img.prompt ?? props.aiPrompts[img.url];
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
                    onClick={() => void regenerate(img)}
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
          onAdd={({ url, aiPrompt }) =>
            props.setImages([
              ...images,
              aiPrompt ? { url, prompt: aiPrompt } : { url },
            ])
          }
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart editor.
// ---------------------------------------------------------------------------

const EMPTY_CHART: PptChart = {
  chartType: "column",
  categories: ["Category 1", "Category 2", "Category 3"],
  series: [{ name: "Series 1", values: [0, 0, 0] }],
};

/** Pad with zeroes / truncate so a series always has one value per category. */
function alignValues(values: number[], len: number): number[] {
  return Array.from({ length: len }, (_, i) => values[i] ?? 0);
}

function parseValues(text: string, len: number): number[] {
  const nums = text
    .split(",")
    .map((v) => Number(v.trim()))
    .map((n) => (Number.isFinite(n) ? n : 0));
  return alignValues(nums, len);
}

function ChartEditor(props: {
  chart: PptChart | null;
  onChange: (c: PptChart | null) => void;
}) {
  const chart = props.chart;
  // Raw text shadows so typing "1," doesn't get reformatted mid-keystroke;
  // the parsed numbers/categories land in the slide state on every change.
  const [catText, setCatText] = useState<string | null>(null);
  const [valText, setValText] = useState<Record<number, string>>({});

  if (!chart) {
    return (
      <div>
        <button className="secondary" onClick={() => props.onChange(EMPTY_CHART)}>
          Add chart
        </button>
      </div>
    );
  }

  function update(fn: (c: PptChart) => PptChart) {
    props.onChange(fn(chart!));
  }

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8 }}>
        <label className="muted" style={{ fontSize: 13 }}>
          Chart type
        </label>
        <select
          value={chart.chartType}
          onChange={(e) =>
            update((c) => ({ ...c, chartType: e.target.value as PptChartType }))
          }
        >
          {PPT_CHART_TYPES.map((t) => (
            <option key={t} value={t}>
              {CHART_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </div>

      <div className="col" style={{ gap: 4 }}>
        <label className="muted" style={{ fontSize: 13 }}>
          Categories (comma-separated)
        </label>
        <input
          value={catText ?? chart.categories.join(", ")}
          placeholder="Q1, Q2, Q3, Q4"
          onChange={(e) => {
            setCatText(e.target.value);
            const categories = e.target.value.split(",").map((c) => c.trim());
            update((c) => ({
              ...c,
              categories,
              series: c.series.map((s) => ({
                ...s,
                values: alignValues(s.values, categories.length),
              })),
            }));
          }}
        />
      </div>

      <label className="muted" style={{ fontSize: 13 }}>
        Series
      </label>
      {chart.series.map((s, i) => (
        <div key={i} className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <input
            value={s.name}
            placeholder={`Series ${i + 1}`}
            onChange={(e) =>
              update((c) => ({
                ...c,
                series: c.series.map((x, n) =>
                  n === i ? { ...x, name: e.target.value } : x,
                ),
              }))
            }
            style={{ width: 140 }}
          />
          <input
            value={valText[i] ?? s.values.join(", ")}
            placeholder="10, 20, 30"
            onChange={(e) => {
              setValText((prev) => ({ ...prev, [i]: e.target.value }));
              const values = parseValues(e.target.value, chart.categories.length);
              update((c) => ({
                ...c,
                series: c.series.map((x, n) =>
                  n === i ? { ...x, values } : x,
                ),
              }));
            }}
            style={{ flex: 1, minWidth: 160 }}
          />
          <button
            type="button"
            className="icon-btn"
            title="Remove series"
            disabled={chart.series.length <= 1}
            onClick={() => {
              setValText({}); // indexes shift — drop the raw-text shadows
              update((c) => ({
                ...c,
                series: c.series.filter((_, n) => n !== i),
              }));
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="muted" style={{ fontSize: 12 }}>
        Each series needs one value per category — values are padded with 0 or
        truncated when the categories change.
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button
          className="secondary"
          disabled={chart.series.length >= 6}
          onClick={() =>
            update((c) => ({
              ...c,
              series: [
                ...c.series,
                {
                  name: `Series ${c.series.length + 1}`,
                  values: c.categories.map(() => 0),
                },
              ],
            }))
          }
        >
          Add series
        </button>
        <button className="secondary" onClick={() => props.onChange(null)}>
          Remove chart
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Video editor: URL or upload (mp4/webm ≤50MB via /api/uploads) + caption.
// ---------------------------------------------------------------------------

function VideoEditor(props: {
  video: PptVideo | null;
  onChange: (v: PptVideo | null) => void;
  onError: (msg: string | null) => void;
}) {
  const video = props.video;
  const [busy, setBusy] = useState(false);

  function set(patch: Partial<PptVideo>) {
    const next: PptVideo = { url: "", ...video, ...patch };
    props.onChange(next.url || next.caption ? next : null);
  }

  async function handleUpload(file: File) {
    if (!isAllowedVideoType(file)) {
      props.onError("Use an MP4 or WebM video.");
      return;
    }
    if (file.size > MAX_VIDEO_BYTES) {
      props.onError("That video is over the 50MB limit.");
      return;
    }
    setBusy(true);
    props.onError(null);
    try {
      const { url } = await uploadVideo(file);
      set({ url });
    } catch (e) {
      props.onError(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 6 }}>
      <label className="muted" style={{ fontSize: 13 }}>
        Video
      </label>
      <input
        placeholder="https://… (.mp4 or .webm)"
        value={video?.url ?? ""}
        onChange={(e) => set({ url: e.target.value })}
      />
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input
          type="file"
          accept="video/mp4,video/webm,.mp4,.webm"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleUpload(f);
            e.target.value = "";
          }}
        />
        {busy && (
          <span className="muted">
            <span className="spinner" /> Uploading…
          </span>
        )}
      </div>
      <input
        placeholder="Caption (optional)"
        value={video?.caption ?? ""}
        onChange={(e) => set({ caption: e.target.value })}
      />
      <div className="muted" style={{ fontSize: 12 }}>
        MP4 or WebM up to 50MB — the video is embedded in the exported deck.
      </div>
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
