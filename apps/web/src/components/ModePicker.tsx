import { useRef, useState } from "react";
import type { AppImageMode } from "@wac/shared";
import { isAllowedImageType, uploadImage } from "../lib/uploads.js";

const MODES: { id: AppImageMode; title: string; desc: string }[] = [
  {
    id: "hybrid",
    title: "Hybrid (recommended)",
    desc: "Places the real fixture, then color/light-matches it to the room (like Photoshop's Harmonize). Product-accurate — never re-draws the fixture.",
  },
  {
    id: "composite",
    title: "Composite",
    desc: "Deterministic placement of the real cutout at the computed scale. No color matching, fully product-accurate.",
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
  harmonizeStrength: number;
  onHarmonizeStrengthChange: (n: number) => void;
  harmonizeShadowPx: number;
  onHarmonizeShadowPxChange: (n: number) => void;
  referenceImages: string[];
  onReferenceImagesChange: (urls: string[]) => void;
  outputFormat: "png" | "jpeg";
  onOutputFormatChange: (f: "png" | "jpeg") => void;
}

/**
 * Generation mode selector + per-mode options. Composite is pure deterministic;
 * hybrid adds a shape-preserving color/light match (strength + optional contact
 * shadow) and takes an optional context prompt; concept requires a prompt and
 * accepts reference image uploads.
 */
export function ModePicker({
  mode,
  onModeChange,
  prompt,
  onPromptChange,
  harmonizeStrength,
  onHarmonizeStrengthChange,
  harmonizeShadowPx,
  onHarmonizeShadowPxChange,
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
              ? "Room / lighting notes (optional)"
              : "Scene prompt"}
          </label>
          <textarea
            rows={3}
            placeholder={
              mode === "hybrid"
                ? "Optional context — e.g. warm evening light. Harmonization is automatic; a prompt is not required."
                : "e.g. a modern kitchen at dusk with a pendant light over the island"
            }
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
          />
        </div>
      )}

      {mode === "hybrid" && (
        <div className="col" style={{ gap: 12 }}>
          <div style={{ maxWidth: 360 }}>
            <label>Color / light match ({Math.round(harmonizeStrength * 100)}%)</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={harmonizeStrength}
              onChange={(e) => onHarmonizeStrengthChange(Number(e.target.value))}
            />
            <div className="muted" style={{ fontSize: 12 }}>
              How strongly the fixture's color/exposure is pulled toward the
              room. Shape is always preserved.
            </div>
          </div>
          <div style={{ maxWidth: 360 }}>
            <label>Contact shadow ({harmonizeShadowPx}px)</label>
            <input
              type="range"
              min={0}
              max={64}
              step={2}
              value={harmonizeShadowPx}
              onChange={(e) => onHarmonizeShadowPxChange(Number(e.target.value))}
            />
            <div className="muted" style={{ fontSize: 12 }}>
              Optional soft shadow under each fixture to ground it. 0 = none.
            </div>
          </div>
        </div>
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
