import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Product } from "@wac/shared";
import { APPIMAGE_PARAMS_VERSION } from "@wac/shared";
import { ProductPicker } from "../components/ProductPicker.js";
import { apiBlob } from "../lib/api.js";
import { createJob, pollJob, type JobResponse } from "../lib/jobs.js";
import { formatDimensions } from "../lib/products.js";

/**
 * Image Generator — the fast 2D path, shaped like the 3D App-Shot flow:
 * optionally pick a fixture, describe the room, and AI generates the room
 * featuring that fixture (via reference-image conditioning). No fixture
 * selected → it just generates the room. Outputs save to Final Images
 * automatically and can be downloaded in their native format.
 *
 * This is the "concept" pipeline: fast and flexible, but not guaranteed
 * product-accurate — for exact fixtures at exact scale, use the 3D App-Shot.
 */

type OutputFormat = "png" | "jpeg";

export function AppImage() {
  const [fixture, setFixture] = useState<Product | null>(null);
  const [prompt, setPrompt] = useState("");
  const [format, setFormat] = useState<OutputFormat>("png");
  const [name, setName] = useState("");

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  function buildPrompt(): string {
    const base = prompt.trim();
    if (!fixture) return base;
    const dims = formatDimensions(fixture.dimensions_mm);
    return [
      base,
      `Feature this exact lighting fixture, matching the reference image closely: ${fixture.name}${fixture.brand ? ` by ${fixture.brand}` : ""}${dims ? ` (approx. ${dims})` : ""}. Keep its shape, finish, and proportions accurate, integrated naturally into the room's lighting.`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async function generate() {
    if (!prompt.trim()) {
      setErr("Describe the room you want to generate.");
      return;
    }
    setBusy(true);
    setErr(null);
    setJob(null);
    setPreviewUrl(null);
    setStatus("Queued…");
    try {
      const referenceImages = fixture?.primary_image_url
        ? [fixture.primary_image_url]
        : [];
      const params = {
        version: APPIMAGE_PARAMS_VERSION,
        mode: "concept",
        prompt: buildPrompt(),
        referenceImages,
        output: { format },
      };
      const tags = ["concept", ...(fixture ? [`sku:${fixture.sku}`] : [])];
      const jobName =
        name.trim() ||
        (fixture ? `${fixture.name} concept room` : "Concept room");
      const { jobId } = await createJob("appimage", jobName, params, tags);
      setStatus("Generating…");
      const finished = await pollJob(jobId);
      setJob(finished);
      if (finished.status !== "succeeded") {
        setErr(finished.error ?? "Generation failed.");
        setStatus(null);
        return;
      }
      setStatus(null);
      if (finished.assetId) {
        const blob = await apiBlob(
          `/api/assets/${finished.assetId}/files/${format}`,
        );
        const url = URL.createObjectURL(blob);
        if (previewRef.current) URL.revokeObjectURL(previewRef.current);
        previewRef.current = url;
        setPreviewUrl(url);
      }
    } catch (e) {
      setErr(formatErr(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (!job?.assetId) return;
    try {
      const blob = await apiBlob(`/api/assets/${job.assetId}/files/${format}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${(name.trim() || fixture?.name || "concept-room").replace(/[^\w-]+/g, "-")}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(formatErr(e));
    }
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>Image Generator</h2>
        <div className="muted">
          Pick a fixture (optional), describe the room, and AI generates the
          scene — featuring your fixture when one is selected. Results save to{" "}
          <Link to="/final-images">Final Images</Link> automatically. For
          dimension-accurate renders of the actual product, use the 3D
          App-Shot.
        </div>
      </div>

      {err && <div className="alert error">{err}</div>}

      <div className="grid-2" style={{ gap: 16, alignItems: "start" }}>
      <div className="card col" style={{ gap: 10 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>1 · Fixture (optional)</h3>
          {fixture && (
            <button className="secondary" onClick={() => setFixture(null)}>
              Clear fixture
            </button>
          )}
        </div>
        {fixture ? (
          <div className="row" style={{ gap: 12, alignItems: "center" }}>
            {fixture.primary_image_url && (
              <img
                src={fixture.primary_image_url}
                alt={fixture.name}
                style={{ width: 72, height: 72, objectFit: "contain", background: "#fff", borderRadius: 6 }}
              />
            )}
            <div>
              <strong>{fixture.name}</strong>
              <div className="muted" style={{ fontSize: 12 }}>
                {[fixture.brand, formatDimensions(fixture.dimensions_mm)]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                The AI uses this product's catalog image as a visual reference.
              </div>
            </div>
          </div>
        ) : (
          <ProductPicker onSelect={setFixture} selectedSku={null} />
        )}
      </div>

      <div className="card col" style={{ gap: 10 }}>
        <h3 style={{ margin: 0 }}>2 · Describe the room</h3>
        <textarea
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. A warm modern living room at dusk, double-height ceiling, walnut paneling, large windows with city views…"
        />
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            placeholder="Name (optional — used for the saved image)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
          />
          <select value={format} onChange={(e) => setFormat(e.target.value as OutputFormat)}>
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
          </select>
          <button onClick={() => void generate()} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {busy ? status ?? "Generating…" : "Generate"}
          </button>
        </div>
      </div>
      </div>

      {previewUrl && job?.assetId && (
        <div className="card col" style={{ gap: 10 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>Result</h3>
            <div className="row" style={{ gap: 8 }}>
              <button onClick={() => void download()}>
                Download {format.toUpperCase()}
              </button>
              <Link to="/final-images">
                <button className="secondary">Open Final Images</button>
              </Link>
              <button className="secondary" onClick={() => void generate()} disabled={busy}>
                Regenerate
              </button>
            </div>
          </div>
          <img
            src={previewUrl}
            alt="Generated room"
            style={{ maxWidth: "100%", borderRadius: "var(--radius)" }}
          />
          <div className="muted" style={{ fontSize: 12 }}>
            Saved to Final Images{fixture ? ` (tagged sku:${fixture.sku})` : ""}.
            Concept images are AI-generated and not guaranteed product-accurate.
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
