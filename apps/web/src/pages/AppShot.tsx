import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppShotPlacement,
  GeminiAspectRatio,
  GeminiImageSize,
  RenderQuality,
} from "@wac/shared";
import { isAllowedImageType, uploadImage } from "../lib/uploads.js";
import { generateScene } from "../lib/scenes.js";
import { apiBlob } from "../lib/api.js";
import {
  cutoutShot,
  finalizeShot,
  glbShot,
  listFixtures,
  placeShot,
  previewShot,
  type ShotFixture,
} from "../lib/appshot.js";
import { usePrewarmWorker } from "../lib/usePrewarm.js";
import { formatDimensions } from "../lib/products.js";
import { MOUNT_LABELS } from "../lib/fixtureKind.js";
import {
  EditPanel,
  QualityPicker,
  type ViewerMode,
} from "../components/appshotEditor.js";
import { FixtureThumb } from "../components/fixtureThumb.js";

/**
 * 3D App-Shot Studio.
 *
 * Flow: pick a real fixture + a furnished room, let the AI drop it at the
 * natural mount spot, then place it like a Photoshop layer — DRAG to move,
 * scroll / +- to resize, instantly (the fixture is a real Blender-rendered
 * transparent cutout overlaid on the scene). When it looks right, "Test render"
 * does an in-Blender preview with true light/shadow/glass; "Final render"
 * exports the layered PNG + AVIF + PSD. Everything persists to localStorage so
 * navigating away never loses progress.
 */

const STORAGE_KEY = "wac.appshot.v3";

const ASPECT_RATIOS: { value: GeminiAspectRatio; label: string }[] = [
  { value: "16:9", label: "16:9 — wide room" },
  { value: "3:2", label: "3:2 — photo" },
  { value: "4:3", label: "4:3 — classic" },
  { value: "1:1", label: "1:1 — square" },
];

const IMAGE_SIZES: { value: GeminiImageSize; label: string }[] = [
  { value: "1K", label: "1K — fast" },
  { value: "2K", label: "2K — balanced" },
  { value: "4K", label: "4K — large (slower)" },
];

const DEFAULT_PLACEMENT: AppShotPlacement = {
  xPct: 0.5,
  yPct: 0.34,
  coverage: 0.34,
  brightness: 25,
  lightOutput: 25,
  warm: 0.45,
  pose: { azimuthDeg: 0, elevationDeg: -18, rollDeg: 0, fovDeg: 36, distanceFactor: 1, marginFactor: 1.25 },
};

/**
 * A sensible AI-free starting placement by mount type, so "Place manually" gives
 * a believable angle (ceiling fixtures seen from below, wall fixtures head-on)
 * without any vision call. The user then drags/scales to taste.
 */
function defaultPlacementFor(mount: string | undefined): AppShotPlacement {
  if (mount === "wall") {
    return {
      xPct: 0.5,
      yPct: 0.44,
      coverage: 0.26,
      brightness: 25,
      lightOutput: 25,
      warm: 0.45,
      pose: { azimuthDeg: -8, elevationDeg: 2, rollDeg: 0, fovDeg: 30, distanceFactor: 1, marginFactor: 1.25 },
    };
  }
  if (mount === "floor") {
    return {
      xPct: 0.5,
      yPct: 0.6,
      coverage: 0.4,
      brightness: 25,
      lightOutput: 25,
      warm: 0.45,
      pose: { azimuthDeg: 0, elevationDeg: -5, rollDeg: 0, fovDeg: 35, distanceFactor: 1, marginFactor: 1.25 },
    };
  }
  return DEFAULT_PLACEMENT; // ceiling / recessed: from below
}

interface Cutout {
  url: string;
  coverageRef: number;
}

/** The fixture GLB for the viewer, tagged with the SKU it belongs to. */
interface Glb {
  sku: string;
  url: string;
}

interface Persisted {
  sku: string | null;
  sceneUrl: string | null;
  placement: AppShotPlacement | null;
  cutout: Cutout | null;
  glb: Glb | null;
  viewerMode: ViewerMode | null;
  previewUrl: string | null;
  finalAssetId: string | null;
  renderQuality: RenderQuality;
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}

function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}

export function AppShot() {
  const saved = useRef<Persisted | null>(loadPersisted());

  const [fixtures, setFixtures] = useState<ShotFixture[]>([]);
  const [fixturesErr, setFixturesErr] = useState<string | null>(null);
  const [fixtureQuery, setFixtureQuery] = useState("");
  const [fixtureBrand, setFixtureBrand] = useState("");
  const [fixtureBrands, setFixtureBrands] = useState<string[]>([]);
  const [fixturesTotal, setFixturesTotal] = useState(0);
  const [sku, setSku] = useState<string | null>(saved.current?.sku ?? null);

  const [sceneUrl, setSceneUrl] = useState<string | null>(
    saved.current?.sceneUrl ?? null,
  );
  const [sceneSource, setSceneSource] = useState<"upload" | "generate">("generate");
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<GeminiAspectRatio>("16:9");
  const [imageSize, setImageSize] = useState<GeminiImageSize>("2K");
  const [sceneBusy, setSceneBusy] = useState(false);

  const [placement, setPlacement] = useState<AppShotPlacement | null>(
    // Backfill any fields added since the persisted state was written (e.g.
    // lightOutput) so newer sliders never bind to `undefined`.
    saved.current?.placement
      ? { ...DEFAULT_PLACEMENT, ...saved.current.placement }
      : null,
  );
  const [cutout, setCutout] = useState<Cutout | null>(saved.current?.cutout ?? null);
  const [glb, setGlb] = useState<Glb | null>(saved.current?.glb ?? null);
  const [glbBusy, setGlbBusy] = useState(false);
  const [viewerMode, setViewerMode] = useState<ViewerMode>(
    saved.current?.viewerMode ?? "viewer",
  );
  const [placing, setPlacing] = useState(false);
  const [cutoutBusy, setCutoutBusy] = useState(false);

  const [previewUrl, setPreviewUrl] = useState<string | null>(
    saved.current?.previewUrl ?? null,
  );
  const [showPreview, setShowPreview] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);

  const [finalizing, setFinalizing] = useState(false);
  const [queued, setQueued] = useState(false);
  const [queuedJobId, setQueuedJobId] = useState<string | null>(null);
  const [finalStatus, setFinalStatus] = useState<string | null>(null);
  const [finalAssetId, setFinalAssetId] = useState<string | null>(
    saved.current?.finalAssetId ?? null,
  );
  const [renderQuality, setRenderQuality] = useState<RenderQuality>(
    saved.current?.renderQuality ?? "standard",
  );

  const [error, setError] = useState<string | null>(null);

  const poseTimer = useRef<number | null>(null);
  // Serialize cutout renders: at most ONE Blender render in flight at a time, and
  // coalesce rapid changes to the latest. Concurrent GPU renders are what froze
  // the machine, so this guard is load-bearing, not just an optimization.
  const cutoutBusyRef = useRef(false);
  const pendingCutout = useRef<AppShotPlacement | null>(null);

  // `sku` holds the selected fixtureKey (a scene option); find its fixture group.
  const fixture =
    fixtures.find((f) => f.options.some((o) => o.fixtureKey === sku)) ?? null;
  // The viewer path needs a loaded GLB; the overlay (fallback) needs a cutout.
  const placementReady =
    viewerMode === "viewer" ? Boolean(glb && glb.sku === sku) : Boolean(cutout);
  const editing = Boolean(placement && sceneUrl && placementReady);

  // Browse the fixtures registry, debounced on the search box. Auto-select the
  // first result only when nothing is picked yet (don't fight the user's choice
  // on later searches).
  useEffect(() => {
    const q = fixtureQuery.trim();
    const handle = window.setTimeout(() => {
      listFixtures({ q, brand: fixtureBrand })
        .then(({ fixtures: list, total, brands }) => {
          setFixtures(list);
          setFixturesTotal(total);
          setFixtureBrands(brands);
          setFixturesErr(null);
          if (list[0]?.options[0]) {
            setSku((cur) => cur ?? list[0]!.options[0]!.fixtureKey);
          }
        })
        .catch((e) => setFixturesErr(formatErr(e)));
    }, q ? 250 : 0);
    return () => window.clearTimeout(handle);
  }, [fixtureQuery, fixtureBrand]);

  // Boot the render worker while the editor is open so the first Test/Final
  // render skips the cold-container boot (kernels are already cached).
  usePrewarmWorker();

  // Persist the whole studio so navigating away never loses progress.
  useEffect(() => {
    const snap: Persisted = {
      sku,
      sceneUrl,
      placement,
      cutout,
      glb,
      viewerMode,
      previewUrl,
      finalAssetId,
      renderQuality,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
    } catch {
      // storage full / unavailable — non-fatal
    }
  }, [sku, sceneUrl, placement, cutout, glb, viewerMode, previewUrl, finalAssetId, renderQuality]);

  useEffect(() => {
    return () => {
      if (poseTimer.current) window.clearTimeout(poseTimer.current);
    };
  }, []);

  // --- scene -----------------------------------------------------------------
  async function handleFile(file: File) {
    setError(null);
    if (!isAllowedImageType(file)) {
      setError("Use a PNG, JPEG, or WebP image.");
      return;
    }
    setSceneBusy(true);
    try {
      const { url } = await uploadImage(file);
      resetForNewScene(url);
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setSceneBusy(false);
    }
  }

  async function handleGenerateScene() {
    if (!prompt.trim()) {
      setError("Describe the room you want to generate.");
      return;
    }
    setError(null);
    setSceneBusy(true);
    try {
      const { url } = await generateScene({
        prompt: prompt.trim(),
        aspectRatio,
        imageSize,
        fixtureType: fixture?.fixtureType,
        mount: fixture?.mount,
        gate: true,
      });
      resetForNewScene(url);
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setSceneBusy(false);
    }
  }

  function resetForNewScene(url: string) {
    setSceneUrl(url);
    setPlacement(null);
    setCutout(null);
    setPreviewUrl(null);
    setShowPreview(false);
    setFinalAssetId(null);
    setFinalStatus(null);
    setQueued(false);
    setQueuedJobId(null);
  }

  /** Measure the scene's natural aspect so the cutout is rendered to match it. */
  function sceneRenderSize(): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
      if (!sceneUrl) return resolve({ width: 1024, height: 576 });
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || 1024;
        const h = img.naturalHeight || 576;
        const longEdge = 800;
        const s = Math.min(1, longEdge / Math.max(w, h));
        resolve({
          width: Math.max(8, Math.round(w * s)),
          height: Math.max(8, Math.round(h * s)),
        });
      };
      img.onerror = () => resolve({ width: 1024, height: 576 });
      img.src = sceneUrl;
    });
  }

  // --- cutout (one Blender render per pose; drag/scale are client-side) -------
  // Always records the latest requested placement; if a render is already in
  // flight, it just updates the pending target and returns, so we never spawn a
  // second concurrent Blender process. When the current render finishes it picks
  // up the newest pending target.
  const refreshCutout = useCallback(
    async (place: AppShotPlacement) => {
      if (!sku) return;
      pendingCutout.current = place;
      if (cutoutBusyRef.current) return;
      cutoutBusyRef.current = true;
      setCutoutBusy(true);
      try {
        while (pendingCutout.current) {
          const target = pendingCutout.current;
          pendingCutout.current = null;
          const { width, height } = await sceneRenderSize();
          const r = await cutoutShot({
            sku,
            pose: target.pose,
            coverageRef: target.coverage,
            width,
            height,
          });
          setCutout({ url: r.cutoutUrl, coverageRef: r.coverageRef });
        }
      } catch (e) {
        setError(formatErr(e));
        pendingCutout.current = null;
      } finally {
        cutoutBusyRef.current = false;
        setCutoutBusy(false);
      }
    },
    // sceneUrl is read inside sceneRenderSize; refresh when it changes
    [sku, sceneUrl],
  );

  // --- GLB (one export per SKU; cached in R2 then reused) ---------------------
  // A persisted glb URL (from localStorage) can point at an R2 object that no
  // longer exists (e.g. cache cleared, bucket switched) — model-viewer then 404s
  // and shows nothing. So only trust a URL we've validated *this session*; for
  // anything else, re-ask the server (POST /glb HEADs R2 and is cheap on a hit,
  // re-exporting only when the object is genuinely gone).
  const glbVerified = useRef<Set<string>>(new Set());
  const ensureGlb = useCallback(
    async (targetSku: string): Promise<string> => {
      if (
        glb &&
        glb.sku === targetSku &&
        glb.url.startsWith("/") &&
        glbVerified.current.has(targetSku)
      ) {
        return glb.url;
      }
      setGlbBusy(true);
      try {
        const { url } = await glbShot({ sku: targetSku });
        glbVerified.current.add(targetSku);
        setGlb({ sku: targetSku, url });
        return url;
      } finally {
        setGlbBusy(false);
      }
    },
    [glb],
  );

  // Self-heal the viewer: whenever we're in 3D-viewer mode with a placement but
  // no valid (fresh, same-origin) GLB, export/load it. Covers page reloads and
  // mode switches where runPlace didn't fetch it, and repairs a stale URL.
  // glbTried guards against re-firing forever if the export keeps failing.
  const glbTried = useRef<string | null>(null);
  useEffect(() => {
    if (viewerMode !== "viewer" || !sku || !placement || glbBusy) return;
    if (
      glb &&
      glb.sku === sku &&
      glb.url.startsWith("/") &&
      glbVerified.current.has(sku)
    ) {
      glbTried.current = null;
      return;
    }
    if (glbTried.current === sku) return;
    glbTried.current = sku;
    void ensureGlb(sku).catch((e) => setError(formatErr(e)));
  }, [viewerMode, sku, placement, glb, glbBusy, ensureGlb]);

  // --- place (AI vision) + first asset (GLB for viewer, cutout for overlay) ---
  async function runPlace(useAi: boolean) {
    if (!sku || !sceneUrl) return;
    setError(null);
    setPlacing(true);
    setShowPreview(false);
    try {
      let next = defaultPlacementFor(fixture?.mount);
      if (useAi) {
        const r = await placeShot({ sku, sceneUrl });
        next = { ...next, ...r.placement };
      }
      setPlacement(next);
      if (viewerMode === "viewer") {
        await ensureGlb(sku);
      } else {
        await refreshCutout(next);
      }
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setPlacing(false);
    }
  }

  // Switch placement method mid-edit, loading whatever the new mode needs.
  async function switchViewerMode(mode: ViewerMode) {
    if (mode === viewerMode) return;
    setViewerMode(mode);
    setShowPreview(false);
    if (!sku || !placement) return;
    setError(null);
    try {
      if (mode === "viewer") {
        await ensureGlb(sku);
      } else if (!cutout) {
        await refreshCutout(placement);
      }
    } catch (e) {
      setError(formatErr(e));
    }
  }

  // --- placement edits (instant; pose re-renders the cutout, debounced) ------
  function patchPlacement(patch: Partial<AppShotPlacement>) {
    setPlacement((p) => (p ? { ...p, ...patch } : p));
    setShowPreview(false);
  }

  function patchPose(patch: Partial<AppShotPlacement["pose"]>, rerender = true) {
    setPlacement((p) => {
      if (!p) return p;
      const next = { ...p, pose: { ...p.pose, ...patch } };
      // Only the overlay (fallback) path re-renders a Blender cutout per angle.
      // The viewer path updates the live WebGL model from the pose prop — no
      // server round-trip — so angle changes are instant there.
      if (rerender && viewerMode === "overlay") {
        if (poseTimer.current) window.clearTimeout(poseTimer.current);
        poseTimer.current = window.setTimeout(() => void refreshCutout(next), 400);
      }
      return next;
    });
    setShowPreview(false);
  }

  // --- test render (in-Blender, true light/shadow/glass) ---------------------
  async function runTestRender() {
    if (!sku || !sceneUrl || !placement) return;
    setError(null);
    setPreviewBusy(true);
    try {
      const r = await previewShot({ sku, sceneUrl, placement, renderQuality });
      setPreviewUrl(r.previewUrl);
      setShowPreview(true);
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setPreviewBusy(false);
    }
  }

  // --- final render ----------------------------------------------------------
  // Hand the final render off to the background queue and return immediately.
  // High/Max renders take minutes; rather than pin the user to this page with a
  // long poll, we enqueue and point them at the Asset Library, where the job
  // shows as "Rendering" and the finished asset drops in when it completes.
  async function runFinalize() {
    if (!sku || !sceneUrl || !placement) return;
    setError(null);
    setQueued(false);
    setQueuedJobId(null);
    setFinalAssetId(null);
    setFinalStatus(null);
    setFinalizing(true);
    try {
      const { jobId } = await finalizeShot({
        sku,
        sceneUrl,
        placement,
        name: `${sku} app shot`,
        renderQuality,
      });
      setQueuedJobId(jobId);
      setQueued(true);
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setFinalizing(false);
    }
  }

  async function download(format: "png" | "avif" | "psd") {
    if (!finalAssetId) return;
    try {
      const blob = await apiBlob(`/api/assets/${finalAssetId}/files/${format}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${sku ?? "app-shot"}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(formatErr(e));
    }
  }

  function startOver() {
    pendingCutout.current = null;
    resetForNewScene("");
    setSceneUrl(null);
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0 }}>3D App-Shot Studio</h2>
          <div className="muted">
            Drag the real fixture into place like a layer, then render it in
            Blender with true light, shadow and reflections.
          </div>
        </div>
        {editing && (
          <button className="secondary" onClick={startOver}>
            Start over
          </button>
        )}
      </div>

      {fixturesErr && <div className="alert error">{fixturesErr}</div>}
      {error && <div className="alert error">{error}</div>}

      {!editing ? (
        <SetupPanel
          fixtures={fixtures}
          fixturesErr={fixturesErr}
          fixtureQuery={fixtureQuery}
          setFixtureQuery={setFixtureQuery}
          fixtureBrand={fixtureBrand}
          setFixtureBrand={setFixtureBrand}
          fixtureBrands={fixtureBrands}
          fixturesTotal={fixturesTotal}
          sku={sku}
          setSku={setSku}
          fixture={fixture}
          sceneUrl={sceneUrl}
          sceneSource={sceneSource}
          setSceneSource={setSceneSource}
          prompt={prompt}
          setPrompt={setPrompt}
          aspectRatio={aspectRatio}
          setAspectRatio={setAspectRatio}
          imageSize={imageSize}
          setImageSize={setImageSize}
          sceneBusy={sceneBusy}
          placing={placing}
          onFile={handleFile}
          onGenerate={handleGenerateScene}
          onReplaceScene={() => setSceneUrl(null)}
          onPlace={runPlace}
        />
      ) : (
        <EditPanel
          sceneUrl={sceneUrl!}
          placement={placement!}
          viewerMode={viewerMode}
          onSwitchMode={(m) => void switchViewerMode(m)}
          glbUrl={glb?.url ?? null}
          glbBusy={glbBusy}
          cutout={cutout}
          cutoutBusy={cutoutBusy}
          previewUrl={previewUrl}
          showPreview={showPreview}
          setShowPreview={setShowPreview}
          previewBusy={previewBusy}
          finalizing={finalizing}
          finalStatus={finalStatus}
          finalAssetId={finalAssetId}
          queued={queued}
          queuedJobId={queuedJobId}
          mountLabel={fixture ? MOUNT_LABELS[fixture.mount] : ""}
          onPatch={patchPlacement}
          onPatchPose={patchPose}
          onRePlaceAi={() => void runPlace(true)}
          onTestRender={runTestRender}
          onFinalize={runFinalize}
          onDownload={download}
          renderControls={
            <QualityPicker
              quality={renderQuality}
              onChange={(q) => {
                setRenderQuality(q);
                setShowPreview(false);
              }}
              disabled={previewBusy || finalizing}
            />
          }
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ setup -- */

interface SetupProps {
  fixtures: ShotFixture[];
  fixturesErr: string | null;
  fixtureQuery: string;
  setFixtureQuery: (s: string) => void;
  fixtureBrand: string;
  setFixtureBrand: (s: string) => void;
  fixtureBrands: string[];
  fixturesTotal: number;
  sku: string | null;
  setSku: (s: string) => void;
  fixture: ShotFixture | null;
  sceneUrl: string | null;
  sceneSource: "upload" | "generate";
  setSceneSource: (s: "upload" | "generate") => void;
  prompt: string;
  setPrompt: (s: string) => void;
  aspectRatio: GeminiAspectRatio;
  setAspectRatio: (a: GeminiAspectRatio) => void;
  imageSize: GeminiImageSize;
  setImageSize: (s: GeminiImageSize) => void;
  sceneBusy: boolean;
  placing: boolean;
  onFile: (f: File) => void;
  onGenerate: () => void;
  onReplaceScene: () => void;
  onPlace: (useAi: boolean) => void;
}

function SetupPanel(p: SetupProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const canPlace = Boolean(p.sku && p.sceneUrl) && !p.placing;
  return (
    <div className="grid-2" style={{ gap: 16, alignItems: "start" }}>
      <div className="card col" style={{ gap: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>1 · Fixture</h3>
          <div className="muted">Search the fixture library by name, brand, or SKU.</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input
            type="search"
            placeholder="Search name, brand, or SKU…"
            value={p.fixtureQuery}
            onChange={(e) => p.setFixtureQuery(e.target.value)}
            style={{ flex: 1 }}
          />
          {p.fixtureBrands.length > 0 && (
            <select
              value={p.fixtureBrand}
              onChange={(e) => p.setFixtureBrand(e.target.value)}
              style={{ maxWidth: 170 }}
            >
              <option value="">All brands</option>
              {p.fixtureBrands.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          )}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))",
            gap: 10,
            maxHeight: 440,
            overflowY: "auto",
            paddingRight: 4,
          }}
        >
          {p.fixtures.map((f) => {
            const selected = f.options.some((o) => o.fixtureKey === p.sku);
            return (
              <button
                key={f.sku}
                type="button"
                className={"product-card" + (selected ? " selected" : "")}
                onClick={() => p.setSku(f.options[0]!.fixtureKey)}
                title={f.name ?? f.sku}
              >
                <FixtureThumb
                  fixtureKey={f.options[0]!.fixtureKey}
                  mount={f.mount}
                  imageUrl={f.thumbnailUrl}
                  allow3d
                />
                <div className="product-meta">
                  <div className="product-name" title={f.name ?? f.sku}>
                    {f.name ?? f.sku}
                  </div>
                  {f.brand ? (
                    <div className="muted product-brand">{f.brand}</div>
                  ) : null}
                  <div className="muted product-sku">{f.sku}</div>
                  <div className="muted product-dims">
                    {formatDimensions(f.dimensions ?? {})}
                  </div>
                  {(f.finish || f.options.length > 1) && (
                    <div
                      className="row"
                      style={{ gap: 4, flexWrap: "wrap", marginTop: 2 }}
                    >
                      {f.finish ? (
                        <span className="tag" style={{ fontWeight: 600 }}>
                          {f.finish}
                        </span>
                      ) : null}
                      {f.options.length > 1 ? (
                        <span className="tag">{f.options.length} scenes</span>
                      ) : null}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
          {p.fixtures.length === 0 && !p.fixturesErr && (
            <span className="muted">
              {p.fixtureQuery.trim() || p.fixtureBrand ? (
                "No fixtures match that search."
              ) : (
                <>
                  <span className="spinner" /> loading fixtures…
                </>
              )}
            </span>
          )}
        </div>
        {p.fixturesTotal > p.fixtures.length && (
          <div className="muted" style={{ fontSize: 12 }}>
            Showing {p.fixtures.length} of {p.fixturesTotal} — refine your search.
          </div>
        )}
        {p.fixture && p.fixture.options.length > 1 && (
          <div className="col" style={{ gap: 6 }}>
            <div className="muted" style={{ fontSize: 12 }}>
              Scene — pick by form
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))",
                gap: 10,
              }}
            >
              {p.fixture.options.map((o) => (
                <button
                  key={o.fixtureKey}
                  type="button"
                  className={"product-card" + (p.sku === o.fixtureKey ? " selected" : "")}
                  onClick={() => p.setSku(o.fixtureKey)}
                >
                  <FixtureThumb fixtureKey={o.fixtureKey} mount={p.fixture!.mount} allow3d />
                  <div className="product-meta">
                    <div className="product-name">{o.label}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
        {p.fixture && (
          <div className="muted" style={{ fontSize: 12 }}>
            Mount: {MOUNT_LABELS[p.fixture.mount]}
            {p.fixture.dimensions
              ? ` · ${formatDimensions(p.fixture.dimensions)}`
              : ""}
          </div>
        )}
      </div>

      <div className="card col" style={{ gap: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>2 · Room</h3>
          <div className="muted">
            Generate a furnished room or upload your own.
          </div>
        </div>

        {p.sceneUrl ? (
          <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
            <img
              src={p.sceneUrl}
              alt="room"
              style={{
                width: 200,
                height: "auto",
                borderRadius: 8,
                border: "1px solid var(--border)",
              }}
            />
            <button className="secondary" onClick={p.onReplaceScene}>
              Replace room
            </button>
          </div>
        ) : (
          <>
            <div className="row" style={{ gap: 6 }}>
              <button
                type="button"
                className={"tag" + (p.sceneSource === "generate" ? " tag-selected" : "")}
                onClick={() => p.setSceneSource("generate")}
              >
                Generate with AI
              </button>
              <button
                type="button"
                className={"tag" + (p.sceneSource === "upload" ? " tag-selected" : "")}
                onClick={() => p.setSceneSource("upload")}
              >
                Upload
              </button>
            </div>

            {p.sceneSource === "generate" ? (
              <div className="col" style={{ gap: 10 }}>
                <textarea
                  rows={3}
                  placeholder="e.g. a warm modern dining room with concrete walls and a wood table"
                  value={p.prompt}
                  onChange={(e) => p.setPrompt(e.target.value)}
                />
                <div className="grid-2">
                  <div>
                    <label>Aspect ratio</label>
                    <select
                      value={p.aspectRatio}
                      onChange={(e) =>
                        p.setAspectRatio(e.target.value as GeminiAspectRatio)
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
                      value={p.imageSize}
                      onChange={(e) =>
                        p.setImageSize(e.target.value as GeminiImageSize)
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
                <button
                  onClick={p.onGenerate}
                  disabled={p.sceneBusy || !p.prompt.trim()}
                >
                  {p.sceneBusy ? <span className="spinner" /> : null}
                  Generate room
                </button>
              </div>
            ) : (
              <div
                className="dropzone"
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files?.[0];
                  if (file) p.onFile(file);
                }}
              >
                {p.sceneBusy ? (
                  <span className="spinner" />
                ) : (
                  <span className="muted">
                    Drag a room image here, or click to choose a file
                  </span>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) p.onFile(file);
                    e.target.value = "";
                  }}
                />
              </div>
            )}
          </>
        )}

        <div className="row" style={{ gap: 8 }}>
          <button onClick={() => p.onPlace(true)} disabled={!canPlace}>
            {p.placing ? <span className="spinner" /> : null}
            Place with AI
          </button>
          <button
            className="secondary"
            onClick={() => p.onPlace(false)}
            disabled={!canPlace}
            title="Skip AI and start from a centered placement"
          >
            Place manually
          </button>
        </div>
      </div>
    </div>
  );
}
