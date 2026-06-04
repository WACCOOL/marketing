import { useRef, useState } from "react";
import type { AppImageMode } from "@wac/shared";
import { isAllowedImageType, uploadImage } from "../lib/uploads.js";

const MODES: { id: AppImageMode; title: string; desc: string }[] = [
  {
    id: "hybrid",
    title: "Hybrid (recommended)",
    desc: "Composites the real fixture, then AI paints integrated lighting & shadows. Needs a room/lighting prompt.",
  },
  {
    id: "composite",
    title: "Composite",
    desc: "Deterministic placement of the real cutout at the computed scale. No AI, fully product-accurate.",
  },
  {
    id: "concept",
    title: "Concept",
    desc: "Pure AI scene from a prompt (+ optional references). Fast, but NOT product-accurate.",
  },
];

interface ModePickerProps {
  mode: AppImageMode;
  onModeChange: (m: AppImageMode) => void;
  prompt: string;
  onPromptChange: (s: string) => void;
  harmonizeGlobalPass: boolean;
  onHarmonizeGlobalPassChange: (b: boolean) => void;
  referenceImages: string[];
  onReferenceImagesChange: (urls: string[]) => void;
  outputFormat: "png" | "jpeg";
  onOutputFormatChange: (f: "png" | "jpeg") => void;
}

/**
 * Generation mode selector + per-mode options (Phase 2e). Composite needs no
 * prompt; hybrid requires a prompt and offers the optional Gemini global pass;
 * concept requires a prompt and accepts reference image uploads.
 */
export function ModePicker({
  mode,
  onModeChange,
  prompt,
  onPromptChange,
  harmonizeGlobalPass,
  onHarmonizeGlobalPassChange,
  referenceImages,
  onReferenceImagesChange,
  outputFormat,
  onOutputFormatChange,
}: ModePickerProps) {
  return (
    <div className="card col" style={{ gap: 14 }}>
      <h3 style={{ margin: 0 }}>Mode</h3>

      <div className="col" style={{ gap: 8 }}>
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={"mode-option" + (mode === m.id ? " selected" : "")}
            onClick={() => onModeChange(m.id)}
          >
            <div className="row" style={{ gap: 8 }}>
              <span className={"radio" + (mode === m.id ? " on" : "")} />
              <strong>{m.title}</strong>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {m.desc}
            </div>
          </button>
        ))}
      </div>

      {(mode === "hybrid" || mode === "concept") && (
        <div>
          <label>
            {mode === "hybrid"
              ? "Lighting / room prompt"
              : "Scene prompt"}
          </label>
          <textarea
            rows={3}
            placeholder={
              mode === "hybrid"
                ? "e.g. warm evening light, soft contact shadows under the fixture"
                : "e.g. a modern kitchen at dusk with a pendant light over the island"
            }
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
          />
        </div>
      )}

      {mode === "hybrid" && (
        <label className="row" style={{ gap: 8, textTransform: "none" }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={harmonizeGlobalPass}
            onChange={(e) => onHarmonizeGlobalPassChange(e.target.checked)}
          />
          Run a final full-image lighting harmonization pass (Gemini)
        </label>
      )}

      {mode === "concept" && (
        <ReferenceUploads
          urls={referenceImages}
          onChange={onReferenceImagesChange}
        />
      )}

      <div style={{ maxWidth: 200 }}>
        <label>Output format</label>
        <select
          value={outputFormat}
          onChange={(e) => onOutputFormatChange(e.target.value as "png" | "jpeg")}
        >
          <option value="png">PNG</option>
          <option value="jpeg">JPEG</option>
        </select>
      </div>
    </div>
  );
}

function ReferenceUploads({
  urls,
  onChange,
}: {
  urls: string[];
  onChange: (urls: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  async function add(file: File) {
    setErr(null);
    if (!isAllowedImageType(file)) {
      setErr("Use a PNG, JPEG, or WebP image.");
      return;
    }
    setBusy(true);
    try {
      const { url } = await uploadImage(file);
      onChange([...urls, url]);
    } catch (e) {
      setErr(
        typeof e === "object" && e && "error" in e
          ? String((e as { error: unknown }).error)
          : String(e),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 8 }}>
      <label>Reference images (optional)</label>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        {urls.map((u) => (
          <div key={u} className="cutout-option">
            <img src={u} alt="" loading="lazy" />
            <button
              type="button"
              className="icon-btn"
              style={{ position: "absolute", top: 2, right: 2 }}
              onClick={() => onChange(urls.filter((x) => x !== u))}
              title="Remove"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
        >
          {busy ? <span className="spinner" /> : "Add image"}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void add(file);
            e.target.value = "";
          }}
        />
      </div>
      {err && <div className="alert error">{err}</div>}
    </div>
  );
}
