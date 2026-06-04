import { useRef, useState } from "react";
import { isAllowedImageType, uploadImage } from "../lib/uploads.js";

export interface SceneSelection {
  url: string;
  naturalWidth: number;
  naturalHeight: number;
}

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

  return (
    <div className="card col" style={{ gap: 14 }}>
      <div>
        <h3 style={{ margin: 0 }}>Scene</h3>
        <div className="muted">
          Upload a room photo, then tell us how wide the scene is in real life —
          that sets the scale so the fixture is sized correctly.
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
