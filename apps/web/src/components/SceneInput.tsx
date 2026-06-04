import { useRef, useState } from "react";
import type { GeminiAspectRatio, GeminiImageSize } from "@wac/shared";
import { isAllowedImageType, uploadImage } from "../lib/uploads.js";
import { generateScene } from "../lib/scenes.js";

export interface SceneSelection {
  url: string;
  naturalWidth: number;
  naturalHeight: number;
}

type SceneSource = "upload" | "generate";

const ASPECT_RATIOS: { value: GeminiAspectRatio; label: string }[] = [
  { value: "16:9", label: "16:9 — wide room" },
  { value: "3:2", label: "3:2 — photo" },
  { value: "4:3", label: "4:3 — classic" },
  { value: "1:1", label: "1:1 — square" },
  { value: "21:9", label: "21:9 — ultrawide" },
  { value: "9:16", label: "9:16 — vertical" },
  { value: "3:4", label: "3:4 — vertical" },
  { value: "2:3", label: "2:3 — vertical" },
];

const IMAGE_SIZES: { value: GeminiImageSize; label: string }[] = [
  { value: "1K", label: "1K — fast" },
  { value: "2K", label: "2K — balanced" },
  { value: "4K", label: "4K — very large (slower)" },
];

interface SceneInputProps {
  scene: SceneSelection | null;
  sceneWidthMm: number;
  onSceneChange: (scene: SceneSelection | null) => void;
  onWidthMmChange: (mm: number) => void;
}

/** Load an image URL and resolve its intrinsic pixel dimensions. */
function loadDimensions(
  url: string,
): Promise<{ naturalWidth: number; naturalHeight: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () =>
      resolve({ naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
    img.onerror = () => reject(new Error("could not load image"));
    img.src = url;
  });
}

/**
 * Scene background input (Phase 2e). Drag/drop or pick an image, upload it to
 * get a public URL the generator can fetch, and capture the scene's real-world
 * width (mm) that drives the scale engine. A URL-paste fallback covers local dev
 * where uploaded URLs aren't container-reachable.
 */
export function SceneInput({
  scene,
  sceneWidthMm,
  onSceneChange,
  onWidthMmChange,
}: SceneInputProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [pasteUrl, setPasteUrl] = useState("");
  const [source, setSource] = useState<SceneSource>("upload");
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<GeminiAspectRatio>("16:9");
  const [imageSize, setImageSize] = useState<GeminiImageSize>("2K");
  const fileInput = useRef<HTMLInputElement | null>(null);

  async function handleFile(file: File) {
    setErr(null);
    if (!isAllowedImageType(file)) {
      setErr("Use a PNG, JPEG, or WebP image.");
      return;
    }
    setBusy(true);
    try {
      const { url } = await uploadImage(file);
      const dims = await loadDimensions(url);
      onSceneChange({ url, ...dims });
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function handlePaste() {
    const url = pasteUrl.trim();
    if (!url) return;
    setErr(null);
    setBusy(true);
    try {
      const dims = await loadDimensions(url);
      onSceneChange({ url, ...dims });
      setPasteUrl("");
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerate() {
    if (!prompt.trim()) {
      setErr("Describe the room you want to generate.");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const { url } = await generateScene({
        prompt: prompt.trim(),
        aspectRatio,
        imageSize,
      });
      const dims = await loadDimensions(url);
      onSceneChange({ url, ...dims });
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card col" style={{ gap: 14 }}>
      <div>
        <h3 style={{ margin: 0 }}>Scene</h3>
        <div className="muted">
          Upload a room photo or generate one from a description, then tell us
          how wide the scene is in real life — that sets the scale so the fixture
          is sized correctly.
        </div>
      </div>

      {scene ? (
        <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
          <img
            src={scene.url}
            alt="scene"
            style={{
              width: 160,
              height: "auto",
              borderRadius: 8,
              border: "1px solid var(--border)",
            }}
          />
          <div className="col" style={{ gap: 6 }}>
            <div className="muted" style={{ fontSize: 12 }}>
              {scene.naturalWidth} × {scene.naturalHeight}px
            </div>
            <button className="secondary" onClick={() => onSceneChange(null)}>
              Replace scene
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className={"tag" + (source === "upload" ? " tag-selected" : "")}
              onClick={() => setSource("upload")}
            >
              Upload
            </button>
            <button
              type="button"
              className={"tag" + (source === "generate" ? " tag-selected" : "")}
              onClick={() => setSource("generate")}
            >
              Generate with AI
            </button>
          </div>

          {source === "upload" ? (
            <>
              <div
                className={"dropzone" + (dragOver ? " dragover" : "")}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) void handleFile(file);
                }}
                onClick={() => fileInput.current?.click()}
              >
                {busy ? (
                  <span className="spinner" />
                ) : (
                  <span className="muted">
                    Drag an image here, or click to choose a file
                  </span>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleFile(file);
                    e.target.value = "";
                  }}
                />
              </div>
              <div className="row" style={{ gap: 8 }}>
                <input
                  placeholder="…or paste an https image URL"
                  value={pasteUrl}
                  onChange={(e) => setPasteUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handlePaste();
                  }}
                />
                <button
                  className="secondary"
                  onClick={() => void handlePaste()}
                  disabled={busy || !pasteUrl.trim()}
                >
                  Use URL
                </button>
              </div>
            </>
          ) : (
            <div className="col" style={{ gap: 10 }}>
              <div>
                <label>Room description</label>
                <textarea
                  rows={3}
                  placeholder="e.g. an empty modern kitchen at dusk, no light fixtures, warm wood floors, large island"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  Describe an empty room — you'll drop the real fixtures in next.
                </div>
              </div>
              <div className="grid-2">
                <div>
                  <label>Aspect ratio</label>
                  <select
                    value={aspectRatio}
                    onChange={(e) =>
                      setAspectRatio(e.target.value as GeminiAspectRatio)
                    }
                  >
                    {ASPECT_RATIOS.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Size</label>
                  <select
                    value={imageSize}
                    onChange={(e) =>
                      setImageSize(e.target.value as GeminiImageSize)
                    }
                  >
                    {IMAGE_SIZES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button
                  onClick={() => void handleGenerate()}
                  disabled={busy || !prompt.trim()}
                >
                  {busy ? <span className="spinner" /> : null}
                  Generate scene
                </button>
                {busy && (
                  <span className="muted" style={{ fontSize: 13 }}>
                    generating{imageSize === "4K" ? " (4K can take a minute)" : ""}…
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {err && <div className="alert error">{err}</div>}

      <div style={{ maxWidth: 240 }}>
        <label>Scene real-world width (mm)</label>
        <input
          type="number"
          min={1}
          value={sceneWidthMm}
          onChange={(e) => onWidthMmChange(Number(e.target.value))}
        />
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          e.g. a 10 ft wall ≈ 3048 mm. Adjust if the fixture looks too big/small.
        </div>
      </div>
    </div>
  );
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}
