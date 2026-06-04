import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiBlob } from "../lib/api.js";
import { replaceAssetFile } from "../lib/assets.js";
import { createJob, pollJob, type JobResponse } from "../lib/jobs.js";
import { CropTool, type CropRect } from "./CropTool.js";

export interface JobRequest {
  params: Record<string, unknown>;
  tags: string[];
}

interface GenerationPreviewProps {
  name: string;
  onNameChange: (s: string) => void;
  roomType: string;
  onRoomTypeChange: (s: string) => void;
  /** Validate + build the appimage params/tags, or return a user-facing error. */
  buildRequest: () => JobRequest | { error: string };
}

/**
 * Generate → poll → preview → save (Phase 2e). A successful job already saves
 * the asset to the library (the container writes it), so "save" here is implicit
 * — naming + tagging happen up front and the result links straight to the
 * library. Regenerate re-submits the current params as a fresh job.
 */
export function GenerationPreview({
  name,
  onNameChange,
  roomType,
  onRoomTypeChange,
  buildRequest,
}: GenerationPreviewProps) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [format, setFormat] = useState<string>("png");
  const [cropping, setCropping] = useState(false);
  const objectUrl = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, []);

  function setPreviewBlob(blob: Blob) {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    const url = URL.createObjectURL(blob);
    objectUrl.current = url;
    setResultUrl(url);
  }

  async function showResult(job: JobResponse) {
    if (!job.assetId) throw new Error("job succeeded but no asset was recorded");
    const fmt = job.result?.files?.[0]?.format ?? "png";
    const blob = await apiBlob(`/api/assets/${job.assetId}/files/${fmt}`);
    setPreviewBlob(blob);
    setFormat(fmt);
    setAssetId(job.assetId);
    setCropping(false);
  }

  /** Crop the current preview to `rect` (fractions) and overwrite the saved asset. */
  async function applyCrop(rect: CropRect) {
    if (!resultUrl || !assetId) return;
    setErr(null);
    setBusy(true);
    try {
      const mime = format === "jpeg" || format === "jpg" ? "image/jpeg" : "image/png";
      const blob = await cropImage(resultUrl, rect, mime);
      await replaceAssetFile(assetId, format, blob);
      setPreviewBlob(blob);
      setCropping(false);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    const built = buildRequest();
    if ("error" in built) {
      setErr(built.error);
      return;
    }
    if (!name.trim()) {
      setErr("Give the image a name before generating.");
      return;
    }

    setBusy(true);
    setErr(null);
    setStatus("queued");
    try {
      const { jobId } = await createJob(
        "appimage",
        name.trim(),
        built.params,
        built.tags,
      );
      const job = await pollJob(jobId, {
        onUpdate: (j) => setStatus(j.status),
        timeoutMs: 4 * 60_000,
      });
      if (job.status === "failed") {
        throw new Error(job.error ?? "generation failed");
      }
      await showResult(job);
      setStatus("succeeded");
    } catch (e) {
      setErr(formatErr(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card col" style={{ gap: 14 }}>
      <h3 style={{ margin: 0 }}>Generate</h3>

      <div className="grid-2">
        <div>
          <label>Image name</label>
          <input
            placeholder="e.g. TO24 in modern kitchen"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
          />
        </div>
        <div>
          <label>Room type (tag)</label>
          <input
            placeholder="e.g. kitchen"
            value={roomType}
            onChange={(e) => onRoomTypeChange(e.target.value)}
          />
        </div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button onClick={() => void generate()} disabled={busy}>
          {busy ? <span className="spinner" /> : null}
          {resultUrl ? "Regenerate" : "Generate"}
        </button>
        {status && !err && (
          <span className="muted" style={{ fontSize: 13 }}>
            {busy ? `${status}…` : status}
          </span>
        )}
      </div>

      {err && <div className="alert error">{err}</div>}

      {resultUrl && (
        <div className="col" style={{ gap: 10 }}>
          {cropping ? (
            <CropTool
              imageUrl={resultUrl}
              busy={busy}
              onApply={(rect) => void applyCrop(rect)}
              onCancel={() => setCropping(false)}
            />
          ) : (
            <img
              src={resultUrl}
              alt={name}
              style={{
                maxWidth: "100%",
                borderRadius: 8,
                border: "1px solid var(--border)",
              }}
            />
          )}
          <div className="row" style={{ gap: 12, alignItems: "center" }}>
            {!cropping && (
              <button
                className="secondary"
                onClick={() => setCropping(true)}
                disabled={busy}
              >
                Crop image
              </button>
            )}
            <a href={resultUrl} download={`${name || "app-image"}.${format}`}>
              Download
            </a>
            <Link to="/library">View in Asset Library</Link>
            {assetId && (
              <span className="muted" style={{ fontSize: 12 }}>
                saved · {assetId.slice(0, 8)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}

/** Load an image URL and crop `rect` (fractions) to a Blob of the given mime. */
function cropImage(url: string, rect: CropRect, mime: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const sx = Math.round(rect.x * img.naturalWidth);
      const sy = Math.round(rect.y * img.naturalHeight);
      const sw = Math.max(1, Math.round(rect.w * img.naturalWidth));
      const sh = Math.max(1, Math.round(rect.h * img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("could not get a canvas context"));
        return;
      }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("crop failed"))),
        mime,
        0.95,
      );
    };
    img.onerror = () => reject(new Error("could not load image for cropping"));
    img.src = url;
  });
}
