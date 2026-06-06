import { useCallback, useEffect, useRef, useState } from "react";
import "@google/model-viewer";
import type { ModelViewerElement } from "@google/model-viewer";
import type {
  AppShotPlacement,
  GeminiAspectRatio,
  GeminiImageSize,
} from "@wac/shared";
import { isAllowedImageType, uploadImage } from "../lib/uploads.js";
import { generateScene } from "../lib/scenes.js";
import { apiBlob } from "../lib/api.js";
import { pollJob } from "../lib/jobs.js";
import {
  cutoutShot,
  finalizeShot,
  glbShot,
  listFixtures,
  placeShot,
  previewShot,
  type ShotFixture,
} from "../lib/appshot.js";
import { MOUNT_LABELS } from "../lib/fixtureKind.js";

/** Which placement canvas is active. */
type ViewerMode = "viewer" | "overlay";

const RAD2DEG = 180 / Math.PI;

/**
 * Map an AppImageModelPose to a model-viewer `camera-orbit` string. The viewer
 * azimuth (theta) is our azimuthDeg; its polar angle (phi) is measured from the
 * top, so phi = 90 - elevationDeg (elevation negative = looking up from below).
 * Radius is "auto" so changing the lens (FOV) re-frames instead of zooming —
 * the on-screen size is set by the element box (= coverage), matching the render.
 */
function poseToOrbit(pose: AppShotPlacement["pose"]): string {
  const az = pose.azimuthDeg ?? 0;
  const phi = 90 - (pose.elevationDeg ?? 0);
  return `${az}deg ${phi}deg auto`;
}

/**
 * The viewer's perspective must match the Blender render's. In `place_camera` the
 * camera distance is `radius / sin(fov/2) * marginFactor` with `marginFactor =
 * 1/coverage`, so the fixture's bounding sphere subtends a half-angle α where
 * `sin(α) = sin(fov/2) * coverage / distanceFactor`. With model-viewer auto-
 * framing (radius = R/sin(FOV/2)), setting the viewer field-of-view to `2α`
 * reproduces the exact same distance/size ratio — i.e. the same foreshortening.
 * (Using the raw fovDeg instead made the viewer a close-up while the render was a
 * far/flat shot — the perspective mismatch.)
 */
function viewerFovDeg(pose: AppShotPlacement["pose"], coverage: number): number {
  const fov = pose.fovDeg ?? 35;
  const df = pose.distanceFactor ?? 1;
  const s = (Math.sin(((fov * Math.PI) / 180) / 2) * coverage) / Math.max(df, 0.01);
  const clamped = Math.min(0.9999, Math.max(0.0001, s));
  const deg = (2 * Math.asin(clamped) * 180) / Math.PI;
  // Keep within a range model-viewer frames reliably (very tiny FOV needs a huge
  // auto radius that can get clamped, hiding the model).
  return Math.min(60, Math.max(6, deg));
}

// model-viewer auto-framing fills its element with the fixture's silhouette up to
// this fraction (measured empirically and stable across fixtures/poses).
const MV_FILL = 0.918;

/**
 * Size of the square placement box (as a fraction of the room *height*) so the
 * fixture renders at EXACTLY the size Blender will produce.
 *
 * Blender's `place_camera` puts the camera at D = R/sin(fovH/2)/coverage and frames
 * the fixture's bounding SPHERE relative to frame WIDTH; the fixture's projected
 * height ends up different from `coverage`. model-viewer instead auto-fits the
 * fixture's silhouette to its element, so if we sized the box to raw `coverage`
 * the fixture comes out ~25% too small and "grows" on Test render. Here we project
 * the model's bounding box under Blender's exact camera to get the true on-screen
 * silhouette size, then size the box to that / MV_FILL so auto-framing reproduces
 * it. Verified in-browser: yields 34.0% vs Blender's 33.3% for the chandelier.
 */
function projectedBoxFrac(
  dims: { x: number; y: number; z: number },
  pose: AppShotPlacement["pose"],
  coverage: number,
  aspect: number, // room width / height
): number {
  const RAD = Math.PI / 180;
  const fovH = (pose.fovDeg ?? 36) * RAD;
  const df = pose.distanceFactor ?? 1;
  const az = (pose.azimuthDeg ?? 0) * RAD;
  const el = (pose.elevationDeg ?? 0) * RAD;
  type Vec = [number, number, number];
  const R = 0.5 * Math.hypot(dims.x, dims.y, dims.z);
  const D = (R / Math.sin(fovH / 2) / Math.max(coverage, 0.01)) * df;
  const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: Vec, b: Vec): Vec => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const norm = (a: Vec): Vec => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  // Camera at distance D along the orbit direction, looking at the model center.
  const dir: Vec = [
    Math.cos(el) * Math.sin(az),
    -Math.cos(el) * Math.cos(az),
    Math.sin(el),
  ];
  const C: Vec = [dir[0] * D, dir[1] * D, dir[2] * D];
  const f = norm(sub([0, 0, 0], C)); // forward
  const right = norm(cross(f, [0, 0, 1])); // screen right (world Z up)
  const up = cross(right, f); // screen up
  const fovV = 2 * Math.atan(Math.tan(fovH / 2) / Math.max(aspect, 0.01));
  const hx = dims.x / 2,
    hy = dims.y / 2,
    hz = dims.z / 2;
  let minY = Infinity,
    maxY = -Infinity,
    minX = Infinity,
    maxX = -Infinity;
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const v = sub([sx * hx, sy * hy, sz * hz], C);
        const depth = dot(v, f);
        if (depth <= 1e-4) continue;
        const ndcx = dot(v, right) / depth / Math.tan(fovH / 2);
        const ndcy = dot(v, up) / depth / Math.tan(fovV / 2);
        if (ndcy < minY) minY = ndcy;
        if (ndcy > maxY) maxY = ndcy;
        if (ndcx < minX) minX = ndcx;
        if (ndcx > maxX) maxX = ndcx;
      }
  const projH = (maxY - minY) / 2; // fraction of frame HEIGHT
  const projW = (maxX - minX) / 2; // fraction of frame WIDTH
  // Square box (height-based): model-viewer fits the larger silhouette dimension.
  const frac = Math.max(projH, projW * aspect) / MV_FILL;
  return Math.min(1.6, Math.max(0.02, frac));
}

/**
 * Inverse of poseToOrbit: read the viewer camera back into pose degrees. Zoom is
 * disabled, so the FOV never changes from user interaction — we only read back
 * the orbit (azimuth/elevation) and leave pose.fovDeg (the render's frame FOV)
 * untouched.
 */
function orbitToPose(
  thetaRad: number,
  phiRad: number,
): Partial<AppShotPlacement["pose"]> {
  return {
    azimuthDeg: thetaRad * RAD2DEG,
    elevationDeg: 90 - phiRad * RAD2DEG,
  };
}

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
  pose: { azimuthDeg: 0, elevationDeg: -18, fovDeg: 36, distanceFactor: 1, marginFactor: 1.25 },
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
      pose: { azimuthDeg: -8, elevationDeg: 2, fovDeg: 30, distanceFactor: 1, marginFactor: 1.25 },
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
      pose: { azimuthDeg: 0, elevationDeg: -5, fovDeg: 35, distanceFactor: 1, marginFactor: 1.25 },
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
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
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
  const [finalStatus, setFinalStatus] = useState<string | null>(null);
  const [finalAssetId, setFinalAssetId] = useState<string | null>(
    saved.current?.finalAssetId ?? null,
  );

  const [error, setError] = useState<string | null>(null);

  const poseTimer = useRef<number | null>(null);
  // Serialize cutout renders: at most ONE Blender render in flight at a time, and
  // coalesce rapid changes to the latest. Concurrent GPU renders are what froze
  // the machine, so this guard is load-bearing, not just an optimization.
  const cutoutBusyRef = useRef(false);
  const pendingCutout = useRef<AppShotPlacement | null>(null);

  const fixture = fixtures.find((f) => f.sku === sku) ?? null;
  // The viewer path needs a loaded GLB; the overlay (fallback) needs a cutout.
  const placementReady =
    viewerMode === "viewer" ? Boolean(glb && glb.sku === sku) : Boolean(cutout);
  const editing = Boolean(placement && sceneUrl && placementReady);
  const straightOn = viewerMode === "viewer";

  useEffect(() => {
    listFixtures()
      .then((list) => {
        setFixtures(list);
        if (list[0]) setSku((cur) => cur ?? list[0]!.sku);
      })
      .catch((e) => setFixturesErr(formatErr(e)));
  }, []);

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
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
    } catch {
      // storage full / unavailable — non-fatal
    }
  }, [sku, sceneUrl, placement, cutout, glb, viewerMode, previewUrl, finalAssetId]);

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
      const r = await previewShot({ sku, sceneUrl, placement, straightOn });
      setPreviewUrl(r.previewUrl);
      setShowPreview(true);
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setPreviewBusy(false);
    }
  }

  // --- final render ----------------------------------------------------------
  async function runFinalize() {
    if (!sku || !sceneUrl || !placement) return;
    setError(null);
    setFinalizing(true);
    setFinalAssetId(null);
    setFinalStatus("queued…");
    try {
      const { jobId } = await finalizeShot({
        sku,
        sceneUrl,
        placement,
        name: `${sku} app shot`,
        straightOn,
      });
      const job = await pollJob(jobId, {
        intervalMs: 3000,
        timeoutMs: 12 * 60_000,
        onUpdate: (j) => setFinalStatus(j.status),
      });
      if (job.status === "succeeded" && job.assetId) {
        setFinalAssetId(job.assetId);
        setFinalStatus("succeeded");
      } else {
        throw new Error(job.error ?? "final render failed");
      }
    } catch (e) {
      setError(formatErr(e));
      setFinalStatus("failed");
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
          mountLabel={fixture ? MOUNT_LABELS[fixture.mount] : ""}
          onPatch={patchPlacement}
          onPatchPose={patchPose}
          onRePlaceAi={() => void runPlace(true)}
          onTestRender={runTestRender}
          onFinalize={runFinalize}
          onDownload={download}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ setup -- */

interface SetupProps {
  fixtures: ShotFixture[];
  fixturesErr: string | null;
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
          <div className="muted">Pick the product to stage.</div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {p.fixtures.map((f) => (
            <button
              key={f.sku}
              type="button"
              className={"tag" + (p.sku === f.sku ? " tag-selected" : "")}
              onClick={() => p.setSku(f.sku)}
            >
              {f.fixtureType} · {f.sku}
            </button>
          ))}
          {p.fixtures.length === 0 && !p.fixturesErr && (
            <span className="muted">
              <span className="spinner" /> loading fixtures…
            </span>
          )}
        </div>
        {p.fixture && (
          <div className="muted" style={{ fontSize: 12 }}>
            Mount: {MOUNT_LABELS[p.fixture.mount]}
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

/* ------------------------------------------------------------------- edit -- */

interface EditProps {
  sceneUrl: string;
  placement: AppShotPlacement;
  viewerMode: ViewerMode;
  onSwitchMode: (m: ViewerMode) => void;
  glbUrl: string | null;
  glbBusy: boolean;
  cutout: Cutout | null;
  cutoutBusy: boolean;
  previewUrl: string | null;
  showPreview: boolean;
  setShowPreview: (b: boolean) => void;
  previewBusy: boolean;
  finalizing: boolean;
  finalStatus: string | null;
  finalAssetId: string | null;
  mountLabel: string;
  onPatch: (patch: Partial<AppShotPlacement>) => void;
  onPatchPose: (patch: Partial<AppShotPlacement["pose"]>, rerender?: boolean) => void;
  onRePlaceAi: () => void;
  onTestRender: () => void;
  onFinalize: () => void;
  onDownload: (f: "png" | "avif" | "psd") => void;
}

function EditPanel(p: EditProps) {
  const viewer = p.viewerMode === "viewer";
  return (
    <div className="col" style={{ gap: 14 }}>
      {/* top bar: placement method + edit/test toggle + render actions */}
      <div className="card row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div className="row" style={{ gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>Placement:</span>
          <button
            type="button"
            className={"tag" + (viewer ? " tag-selected" : "")}
            onClick={() => p.onSwitchMode("viewer")}
            title="Real-time 3D viewer (recommended)"
          >
            3D viewer
          </button>
          <button
            type="button"
            className={"tag" + (!viewer ? " tag-selected" : "")}
            onClick={() => p.onSwitchMode("overlay")}
            title="Classic flat cutout overlay (fallback)"
          >
            Classic overlay
          </button>
        </div>

        {p.previewUrl && (
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className={"tag" + (!p.showPreview ? " tag-selected" : "")}
              onClick={() => p.setShowPreview(false)}
            >
              Edit
            </button>
            <button
              type="button"
              className={"tag" + (p.showPreview ? " tag-selected" : "")}
              onClick={() => p.setShowPreview(true)}
            >
              Test render
            </button>
          </div>
        )}
        <div style={{ flex: 1 }} />
        <button className="secondary" onClick={p.onRePlaceAi} title="Let the AI re-pick the spot">
          Re-place with AI
        </button>
        <button onClick={p.onTestRender} disabled={p.previewBusy}>
          {p.previewBusy ? <span className="spinner" /> : null}
          Test render
        </button>
        <button onClick={p.onFinalize} disabled={p.finalizing}>
          {p.finalizing ? <span className="spinner" /> : null}
          {p.finalizing ? `Rendering… (${p.finalStatus})` : "Final render"}
        </button>
      </div>

      {p.finalAssetId && (
        <div className="alert good col" style={{ gap: 8 }}>
          <div>Final render complete — download:</div>
          <div className="row" style={{ gap: 8 }}>
            <button className="secondary" onClick={() => p.onDownload("png")}>PNG</button>
            <button className="secondary" onClick={() => p.onDownload("avif")}>AVIF</button>
            <button className="secondary" onClick={() => p.onDownload("psd")}>PSD</button>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Also saved to your Asset Library. Tweak and render again for a new
            version.
          </div>
        </div>
      )}

      {/* two columns: controls on the left, the room/fixture canvas on the right */}
      <div className="appshot-edit">
        <div className="col appshot-controls" style={{ gap: 14 }}>
          <div className="card col" style={{ gap: 10 }}>
            <h3 style={{ margin: 0 }}>Size & position</h3>
            <div className="muted" style={{ fontSize: 12 }}>
              {viewer
                ? "Drag the move bar to reposition · scroll over the fixture (or the slider) to resize."
                : "Drag the fixture on the image to move it · scroll over it (or the slider) to resize."}
            </div>
            <Slider
              label="Fixture size"
              min={0.08}
              max={0.9}
              step={0.005}
              value={p.placement.coverage}
              onChange={(v) => p.onPatch({ coverage: v })}
              fmt={(v) => `${Math.round(v * 100)}%`}
            />
            <div className="row" style={{ gap: 8 }}>
              <button className="secondary" onClick={() => p.onPatch({ coverage: clamp(p.placement.coverage * 0.9, 0.08, 0.9) })}>– smaller</button>
              <button className="secondary" onClick={() => p.onPatch({ coverage: clamp(p.placement.coverage * 1.1, 0.08, 0.9) })}>+ larger</button>
            </div>
          </div>

          <div className="card col" style={{ gap: 10 }}>
            <h3 style={{ margin: 0 }}>Angle & lens</h3>
            <div className="muted" style={{ fontSize: 12 }}>
              {viewer ? (
                "Rotate/tilt the fixture by dragging it directly, or use the sliders — instant."
              ) : (
                <>
                  Changing the angle re-renders the fixture (a moment).
                  {p.cutoutBusy && (
                    <>
                      {" "}
                      <span className="spinner" /> updating…
                    </>
                  )}
                </>
              )}
            </div>
            <Slider
              label="Rotate"
              min={-180}
              max={180}
              step={1}
              value={p.placement.pose.azimuthDeg ?? 0}
              onChange={(v) => p.onPatchPose({ azimuthDeg: v })}
              fmt={(v) => `${Math.round(v)}°`}
            />
            <Slider
              label="Tilt"
              min={-40}
              max={70}
              step={1}
              value={p.placement.pose.elevationDeg ?? 0}
              onChange={(v) => p.onPatchPose({ elevationDeg: v })}
              fmt={(v) => `${Math.round(v)}°`}
            />
            <Slider
              label="Lens (FOV)"
              min={15}
              max={60}
              step={1}
              value={p.placement.pose.fovDeg ?? 32}
              onChange={(v) => p.onPatchPose({ fovDeg: v })}
              fmt={(v) => `${Math.round(v)}°`}
            />
          </div>

          <div className="card col" style={{ gap: 10 }}>
            <h3 style={{ margin: 0 }}>Light</h3>
            <div className="muted" style={{ fontSize: 12 }}>
              Applies on Test / Final render.
            </div>
            <Slider
              label="Fixture brightness"
              min={0}
              max={100}
              step={1}
              value={p.placement.brightness}
              onChange={(v) => p.onPatch({ brightness: v })}
              fmt={(v) => `${Math.round(v)}`}
            />
            <div className="muted" style={{ fontSize: 11, marginTop: -4 }}>
              How bright the fixture's own bulbs/diffusers glow.
            </div>
            <Slider
              label="Light output"
              min={0}
              max={100}
              step={1}
              value={p.placement.lightOutput}
              onChange={(v) => p.onPatch({ lightOutput: v })}
              fmt={(v) => `${Math.round(v)}`}
            />
            <div className="muted" style={{ fontSize: 11, marginTop: -4 }}>
              How much light it casts into the room (wall wash, glow, shadows).
            </div>
            <Slider
              label="Warmth"
              min={0}
              max={1}
              step={0.05}
              value={p.placement.warm}
              onChange={(v) => p.onPatch({ warm: v })}
              fmt={(v) => `${Math.round(v * 100)}%`}
            />
          </div>

          <div className="muted" style={{ fontSize: 12 }}>
            {p.mountLabel && <>Mount: {p.mountLabel}. </>}
            Use <strong>Test render</strong> to check true light and glass, then{" "}
            <strong>Final render</strong> for the layered export.
          </div>
        </div>

        <div className="appshot-canvas-col">
          {viewer ? (
            <ModelViewerCanvas
              sceneUrl={p.sceneUrl}
              placement={p.placement}
              glbUrl={p.glbUrl}
              glbBusy={p.glbBusy}
              previewUrl={p.previewUrl}
              showPreview={p.showPreview}
              previewBusy={p.previewBusy}
              onPatch={p.onPatch}
              onPatchPose={p.onPatchPose}
            />
          ) : p.cutout ? (
            <ShotCanvas
              sceneUrl={p.sceneUrl}
              placement={p.placement}
              cutout={p.cutout}
              cutoutBusy={p.cutoutBusy}
              previewUrl={p.previewUrl}
              showPreview={p.showPreview}
              previewBusy={p.previewBusy}
              onPatch={p.onPatch}
            />
          ) : (
            <div className="card" style={{ padding: 24, textAlign: "center" }}>
              <span className="spinner" /> preparing overlay…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- viewer canvas -- */

interface ViewerCanvasProps {
  sceneUrl: string;
  placement: AppShotPlacement;
  glbUrl: string | null;
  glbBusy: boolean;
  previewUrl: string | null;
  showPreview: boolean;
  previewBusy: boolean;
  onPatch: (patch: Partial<AppShotPlacement>) => void;
  onPatchPose: (patch: Partial<AppShotPlacement["pose"]>, rerender?: boolean) => void;
}

/**
 * Real-time 3D placement: a transparent <model-viewer> sits in a square box over
 * the room (box side = coverage of the room height = how the Blender render sizes
 * it). Orbit (drag) rotates/tilts the fixture; the move bar drags its position;
 * scroll resizes. The camera maps 1:1 to the pose Blender renders from, so Test
 * render lands at the exact same angle/size/position — no jump.
 */
function ModelViewerCanvas(p: ViewerCanvasProps) {
  const roomRef = useRef<HTMLDivElement | null>(null);
  const mvRef = useRef<ModelViewerElement | null>(null);
  const drag = useRef<{ x: number; y: number; xPct: number; yPct: number } | null>(
    null,
  );
  // Skip the pose->camera sync when the change CAME from the camera (user orbit),
  // so we don't fight the live interaction.
  const fromCamera = useRef(false);
  // The fixture's bounding-box dims (model units, from model-viewer once loaded)
  // and the room aspect — together they let us size the box so the fixture matches
  // the Blender render exactly (see projectedBoxFrac).
  const [modelDims, setModelDims] = useState<{ x: number; y: number; z: number } | null>(
    null,
  );
  const [roomAspect, setRoomAspect] = useState(16 / 9);

  const pose = p.placement.pose;

  // Capture the fixture's true bounding-box size once the GLB loads.
  useEffect(() => {
    const mv = mvRef.current;
    if (!mv) return;
    setModelDims(null);
    const onLoad = () => {
      try {
        const d = mv.getDimensions();
        if (d && d.x > 0 && d.y > 0) setModelDims({ x: d.x, y: d.y, z: d.z });
      } catch {
        /* dims unavailable */
      }
    };
    mv.addEventListener("load", onLoad);
    return () => mv.removeEventListener("load", onLoad);
  }, [p.glbUrl]);

  // Box size (fraction of room height): match the Blender-projected fixture size
  // once we know the model dims; until then fall back to raw coverage.
  const boxFrac =
    modelDims != null
      ? projectedBoxFrac(modelDims, pose, p.placement.coverage, roomAspect)
      : p.placement.coverage;

  // Sync sliders -> viewer camera (skip when the pose update came from the camera).
  useEffect(() => {
    const mv = mvRef.current;
    if (!mv) return;
    if (fromCamera.current) {
      fromCamera.current = false;
      return;
    }
    mv.cameraOrbit = poseToOrbit(pose);
    mv.fieldOfView = `${viewerFovDeg(pose, p.placement.coverage)}deg`;
  }, [pose.azimuthDeg, pose.elevationDeg, pose.fovDeg, p.placement.coverage]);

  // Viewer camera -> sliders/pose on user interaction.
  useEffect(() => {
    const mv = mvRef.current;
    if (!mv) return;
    const onCam = (e: Event) => {
      const detail = (e as CustomEvent<{ source?: string }>).detail;
      if (detail?.source !== "user-interaction") return;
      const o = mv.getCameraOrbit();
      fromCamera.current = true;
      p.onPatchPose(orbitToPose(o.theta, o.phi), false);
    };
    mv.addEventListener("camera-change", onCam);
    return () => mv.removeEventListener("camera-change", onCam);
  }, [p.glbUrl, p.onPatchPose]);

  function onMovePointerDown(e: React.PointerEvent) {
    if (p.showPreview) return;
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      xPct: p.placement.xPct,
      yPct: p.placement.yPct,
    };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onMovePointerMove(e: React.PointerEvent) {
    const d = drag.current;
    const rect = roomRef.current?.getBoundingClientRect();
    if (!d || !rect || rect.width === 0 || rect.height === 0) return;
    const dx = (e.clientX - d.x) / rect.width;
    const dy = (e.clientY - d.y) / rect.height;
    p.onPatch({ xPct: clamp(d.xPct + dx, 0, 1), yPct: clamp(d.yPct + dy, 0, 1) });
  }
  function endMove(e: React.PointerEvent) {
    if (drag.current) {
      drag.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    }
  }
  function onWheel(e: React.WheelEvent) {
    if (p.showPreview) return;
    const factor = e.deltaY > 0 ? 0.95 : 1.05;
    p.onPatch({ coverage: clamp(p.placement.coverage * factor, 0.08, 0.9) });
  }

  return (
    <div
      style={{
        position: "sticky",
        top: 12,
        zIndex: 5,
        display: "flex",
        justifyContent: "center",
        background: "var(--bg-muted, #0d1117)",
        borderRadius: "var(--radius)",
        padding: 8,
      }}
    >
      <div
        ref={roomRef}
        className="placement-canvas"
        style={{ position: "relative", width: "100%" }}
        onWheel={onWheel}
      >
        <img
          src={p.sceneUrl}
          alt="room"
          draggable={false}
          onLoad={(e) => {
            const im = e.currentTarget;
            if (im.naturalWidth > 0 && im.naturalHeight > 0) {
              setRoomAspect(im.naturalWidth / im.naturalHeight);
            }
          }}
          style={{ width: "100%", height: "auto", display: "block" }}
        />

        {/* live 3D fixture (hidden while showing the test render).
            IMPORTANT: never set min/max-camera-orbit with a radius bound here —
            it disables model-viewer's "auto" radius framing, leaving the model
            off-frame (invisible). Constrain only the FOV (min 1deg so the narrow
            telephoto FOV that matches the render isn't clamped to the 12deg
            default). */}
        {!p.showPreview && p.glbUrl && (
          <div
            style={{
              position: "absolute",
              left: `${p.placement.xPct * 100}%`,
              top: `${p.placement.yPct * 100}%`,
              height: `${boxFrac * 100}%`,
              aspectRatio: "1 / 1",
              transform: "translate(-50%, -50%)",
              touchAction: "none",
            }}
          >
            <model-viewer
              ref={mvRef as never}
              src={p.glbUrl}
              alt="fixture"
              camera-controls=""
              disable-zoom=""
              disable-pan=""
              disable-tap=""
              interaction-prompt="none"
              tone-mapping="neutral"
              shadow-intensity="0"
              exposure="1"
              camera-orbit={poseToOrbit(pose)}
              field-of-view={`${viewerFovDeg(pose, p.placement.coverage)}deg`}
              min-field-of-view="1deg"
              max-field-of-view="65deg"
              style={{
                width: "100%",
                height: "100%",
                backgroundColor: "transparent",
                ["--poster-color" as never]: "transparent",
              }}
            />
            {/* drag-to-move handle (orbit owns the model body) */}
            <div
              onPointerDown={onMovePointerDown}
              onPointerMove={onMovePointerMove}
              onPointerUp={endMove}
              onPointerCancel={endMove}
              title="Drag to move"
              style={{
                position: "absolute",
                top: -10,
                left: "50%",
                transform: "translateX(-50%)",
                cursor: "move",
                background: "rgba(0,0,0,0.6)",
                color: "#fff",
                fontSize: 11,
                lineHeight: 1,
                padding: "4px 10px",
                borderRadius: 999,
                userSelect: "none",
                whiteSpace: "nowrap",
                touchAction: "none",
              }}
            >
              ✥ move
            </div>
          </div>
        )}

        {/* in-Blender test render overlay */}
        {p.showPreview && p.previewUrl && (
          <img
            src={p.previewUrl}
            alt="test render"
            draggable={false}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "fill",
              pointerEvents: "none",
            }}
          />
        )}

        {(p.glbBusy || p.previewBusy) && (
          <div
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              background: "rgba(0,0,0,0.65)",
              color: "#fff",
              padding: "4px 10px",
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            <span className="spinner" /> {p.previewBusy ? "rendering…" : "loading 3D…"}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- canvas -- */

interface CanvasProps {
  sceneUrl: string;
  placement: AppShotPlacement;
  cutout: Cutout;
  cutoutBusy: boolean;
  previewUrl: string | null;
  showPreview: boolean;
  previewBusy: boolean;
  onPatch: (patch: Partial<AppShotPlacement>) => void;
}

function ShotCanvas(p: CanvasProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; xPct: number; yPct: number } | null>(
    null,
  );

  const scale = p.placement.coverage / (p.cutout.coverageRef || 0.5);
  const tx = (p.placement.xPct - 0.5) * 100;
  const ty = (p.placement.yPct - 0.5) * 100;

  function onPointerDown(e: React.PointerEvent) {
    if (p.showPreview) return;
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      xPct: p.placement.xPct,
      yPct: p.placement.yPct,
    };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    const rect = ref.current?.getBoundingClientRect();
    if (!d || !rect || rect.width === 0 || rect.height === 0) return;
    const dx = (e.clientX - d.x) / rect.width;
    const dy = (e.clientY - d.y) / rect.height;
    p.onPatch({
      xPct: clamp(d.xPct + dx, 0, 1),
      yPct: clamp(d.yPct + dy, 0, 1),
    });
  }

  function endDrag(e: React.PointerEvent) {
    if (drag.current) {
      drag.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    }
  }

  function onWheel(e: React.WheelEvent) {
    if (p.showPreview) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.95 : 1.05;
    p.onPatch({ coverage: clamp(p.placement.coverage * factor, 0.08, 0.9) });
  }

  return (
    <div
      style={{
        position: "sticky",
        top: 12,
        zIndex: 5,
        display: "flex",
        justifyContent: "center",
        background: "var(--bg-muted, #0d1117)",
        borderRadius: "var(--radius)",
        padding: 8,
      }}
    >
      <div
        ref={ref}
        className="placement-canvas"
        style={{ cursor: p.showPreview ? "default" : "grab", maxHeight: "72vh" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
      >
        <img src={p.sceneUrl} alt="room" draggable={false} style={{ maxHeight: "72vh", width: "auto" }} />

        {/* live draggable fixture overlay (hidden while showing the test render) */}
        {!p.showPreview && (
          <img
            src={p.cutout.url}
            alt="fixture"
            draggable={false}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "fill",
              pointerEvents: "none",
              transformOrigin: "50% 50%",
              transform: `translate(${tx}%, ${ty}%) scale(${scale})`,
            }}
          />
        )}

        {/* in-Blender test render overlay */}
        {p.showPreview && p.previewUrl && (
          <img
            src={p.previewUrl}
            alt="test render"
            draggable={false}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "fill",
              pointerEvents: "none",
            }}
          />
        )}

        {(p.cutoutBusy || p.previewBusy) && (
          <div
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              background: "rgba(0,0,0,0.65)",
              color: "#fff",
              padding: "4px 10px",
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            <span className="spinner" /> {p.previewBusy ? "rendering…" : "updating fixture…"}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- slider -- */

interface SliderProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  fmt: (v: number) => string;
}

function Slider({ label, min, max, step, value, onChange, fmt }: SliderProps) {
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <label style={{ margin: 0 }}>{label}</label>
        <span className="muted" style={{ fontSize: 12 }}>
          {fmt(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%" }}
      />
    </div>
  );
}
