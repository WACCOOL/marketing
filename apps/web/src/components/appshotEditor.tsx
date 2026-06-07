import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import "@google/model-viewer";
import type { ModelViewerElement } from "@google/model-viewer";
import type { AppShotPlacement, RenderQuality, RenderStyle } from "@wac/shared";

/**
 * Render-quality tiers surfaced in both studios. The tier bundles Cycles
 * samples, refractive caustics, and output resolution (see the generator's
 * `qualityProfile`); higher tiers are slower but catalog-grade.
 */
export const RENDER_QUALITIES: {
  value: RenderQuality;
  label: string;
  hint: string;
}[] = [
  { value: "draft", label: "Draft", hint: "Fastest — no caustics, low res" },
  { value: "standard", label: "Standard", hint: "Balanced (default)" },
  { value: "high", label: "High", hint: "Caustics on, hi-res — slow" },
  { value: "max", label: "Max", hint: "CG-grade, max samples & res — slowest" },
];

interface QualityPickerProps {
  quality: RenderQuality;
  onChange: (q: RenderQuality) => void;
  /** Disable interaction (e.g. while a render is in flight). */
  disabled?: boolean;
}

/** Render-quality tier selector (Draft / Standard / High / Max). */
export function QualityPicker(p: QualityPickerProps) {
  const active = RENDER_QUALITIES.find((q) => q.value === p.quality);
  return (
    <div className="col" style={{ gap: 6 }}>
      <label style={{ margin: 0 }}>Render quality</label>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {RENDER_QUALITIES.map((q) => (
          <button
            key={q.value}
            type="button"
            className={"tag" + (p.quality === q.value ? " tag-selected" : "")}
            onClick={() => p.onChange(q.value)}
            disabled={p.disabled}
            title={q.hint}
          >
            {q.label}
          </button>
        ))}
      </div>
      {active && (
        <div className="muted" style={{ fontSize: 12 }}>
          {active.hint}
        </div>
      )}
    </div>
  );
}

/**
 * Shared 3D placement editor for the App-Shot and Cam Solve studios.
 *
 * Both flows differ only in what produces the background `sceneUrl` (a room vs a
 * plain backdrop plate); the placement experience — 3D viewer, classic overlay,
 * the size/pose/light sliders, and the test/final render actions — is identical,
 * so it lives here and is consumed by both pages.
 */

/** Which placement canvas is active. */
export type ViewerMode = "viewer" | "overlay";

const RAD2DEG = 180 / Math.PI;

/**
 * Map an AppShotPlacement pose to a model-viewer `camera-orbit` string. The
 * viewer azimuth (theta) is our azimuthDeg; its polar angle (phi) is measured
 * from the top, so phi = 90 - elevationDeg (elevation negative = looking up from
 * below). Radius is "auto" so changing the lens (FOV) re-frames instead of
 * zooming — the on-screen size is set by the element box (= coverage).
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
 */
function viewerFovDeg(pose: AppShotPlacement["pose"], coverage: number): number {
  const fov = pose.fovDeg ?? 35;
  const df = pose.distanceFactor ?? 1;
  const s = (Math.sin(((fov * Math.PI) / 180) / 2) * coverage) / Math.max(df, 0.01);
  const clamped = Math.min(0.9999, Math.max(0.0001, s));
  const deg = (2 * Math.asin(clamped) * 180) / Math.PI;
  return Math.min(60, Math.max(6, deg));
}

// model-viewer auto-framing fills its element with the fixture's silhouette up to
// this fraction (measured empirically and stable across fixtures/poses).
const MV_FILL = 0.918;

/**
 * Size of the square placement box (as a fraction of the room *height*) so the
 * fixture renders at EXACTLY the size Blender will produce. Projects the model's
 * bounding box under Blender's exact camera to get the true on-screen silhouette
 * size, then sizes the box to that / MV_FILL so auto-framing reproduces it.
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
  const frac = Math.max(projH, projW * aspect) / MV_FILL;
  // Cap generously so the fixture can be pushed to fill the frame and clip past
  // its edges (Cam Solve), not just sit comfortably inside it.
  return Math.min(3, Math.max(0.02, frac));
}

/** Default upper bound for the fixture-size slider (overridable per studio). */
const DEFAULT_MAX_COVERAGE = 0.9;

/** Inverse of poseToOrbit: read the viewer camera back into pose degrees. */
function orbitToPose(
  thetaRad: number,
  phiRad: number,
): Partial<AppShotPlacement["pose"]> {
  return {
    azimuthDeg: thetaRad * RAD2DEG,
    elevationDeg: 90 - phiRad * RAD2DEG,
  };
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * A CSS checkerboard so a transparent backdrop (Cam Solve) reads as "no
 * background" in the live editor rather than blending into the page.
 */
const CHECKERBOARD: React.CSSProperties = {
  backgroundColor: "#fff",
  backgroundImage:
    "linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%, #ccc), linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%, #ccc)",
  backgroundSize: "24px 24px",
  backgroundPosition: "0 0, 12px 12px",
};

/* ------------------------------------------------------------------- edit -- */

export interface EditProps {
  sceneUrl: string;
  placement: AppShotPlacement;
  viewerMode: ViewerMode;
  onSwitchMode: (m: ViewerMode) => void;
  glbUrl: string | null;
  glbBusy: boolean;
  cutout: { url: string; coverageRef: number } | null;
  cutoutBusy: boolean;
  previewUrl: string | null;
  showPreview: boolean;
  setShowPreview: (b: boolean) => void;
  previewBusy: boolean;
  finalizing: boolean;
  finalStatus: string | null;
  finalAssetId: string | null;
  /**
   * Cam Solve / App Shot: a final render was just handed off to the background
   * queue. The Asset Library is the source of truth — the user can leave the
   * page and pick the finished render up there.
   */
  queued?: boolean;
  /** The queued job's id, used to deep-link/highlight it in the Library. */
  queuedJobId?: string | null;
  mountLabel: string;
  onPatch: (patch: Partial<AppShotPlacement>) => void;
  onPatchPose: (patch: Partial<AppShotPlacement["pose"]>, rerender?: boolean) => void;
  onRePlaceAi?: () => void;
  onTestRender: () => void;
  onFinalize: () => void;
  onDownload: (f: "png" | "avif" | "psd") => void;
  /** Cam Solve: show a checkerboard behind a transparent backdrop. */
  transparentBg?: boolean;
  /** Cam Solve: the active render style (shown in the footer hint). */
  renderStyle?: RenderStyle;
  /** Upper bound for the fixture-size slider/scroll (default 0.9). Cam Solve
   * raises this so the fixture can fill the frame and clip past its edges. */
  maxCoverage?: number;
  /** Reset size/position/angle/light back to defaults. Shown when provided. */
  onReset?: () => void;
  /** Extra controls (e.g. Cam Solve's background + render style) rendered above
   * the sliders in the controls column. */
  renderControls?: React.ReactNode;
}

const RENDER_STYLE_LABELS: Record<RenderStyle, string> = {
  clean: "Clean cutout",
  cleanShadow: "Clean + drop shadow",
  studio: "Studio (lit backdrop)",
};

export function EditPanel(p: EditProps) {
  const viewer = p.viewerMode === "viewer";
  const maxCoverage = p.maxCoverage ?? DEFAULT_MAX_COVERAGE;
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
        {p.onRePlaceAi && (
          <button className="secondary" onClick={p.onRePlaceAi} title="Let the AI re-pick the spot">
            Re-place with AI
          </button>
        )}
        {p.onReset && (
          <button
            className="secondary"
            onClick={p.onReset}
            title="Reset size, position, angle & light to defaults"
          >
            Reset
          </button>
        )}
        <button onClick={p.onTestRender} disabled={p.previewBusy}>
          {p.previewBusy ? <span className="spinner" /> : null}
          Test render
        </button>
        <button onClick={p.onFinalize} disabled={p.finalizing}>
          {p.finalizing ? <span className="spinner" /> : null}
          {p.finalizing ? "Queuing…" : "Final render"}
        </button>
      </div>

      {p.queued && (
        <div className="alert good col" style={{ gap: 6 }}>
          <div>
            Added to the render queue. High and Max renders take several minutes
            — you can leave this page and pick it up later.
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            Track progress and download it from your{" "}
            <Link to={p.queuedJobId ? `/library?job=${p.queuedJobId}` : "/library"}>
              Asset Library
            </Link>
            . Tweak and render again for another version anytime.
          </div>
        </div>
      )}

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
        <div className="col appshot-controls" style={{ gap: 10 }}>
          {p.renderControls && (
            <div className="card col" style={{ gap: 12 }}>{p.renderControls}</div>
          )}
          <div className="card col appshot-sliders">
            <div className="slider-section">
              <div className="slider-section-title">Size & position</div>
              <Slider
                label="Fixture size"
                min={0.08}
                max={maxCoverage}
                step={0.005}
                value={p.placement.coverage}
                onChange={(v) => p.onPatch({ coverage: v })}
                fmt={(v) => `${Math.round(v * 100)}%`}
              />
              <Slider
                label="Left / right"
                min={0}
                max={1}
                step={0.01}
                value={p.placement.xPct}
                onChange={(v) => p.onPatch({ xPct: v })}
                fmt={(v) => `${Math.round(v * 100)}%`}
              />
              <Slider
                label="Up / down"
                min={0}
                max={1}
                step={0.01}
                value={1 - p.placement.yPct}
                onChange={(v) => p.onPatch({ yPct: 1 - v })}
                fmt={(v) => `${Math.round(v * 100)}%`}
              />
              <div className="row" style={{ gap: 8 }}>
                <button className="secondary slim" onClick={() => p.onPatch({ coverage: clamp(p.placement.coverage * 0.9, 0.08, maxCoverage) })}>– smaller</button>
                <button className="secondary slim" onClick={() => p.onPatch({ coverage: clamp(p.placement.coverage * 1.1, 0.08, maxCoverage) })}>+ larger</button>
              </div>
            </div>

            <div className="slider-section">
              <div className="slider-section-title">
                Angle & lens
                {!viewer && p.cutoutBusy && (
                  <>
                    {" "}
                    <span className="spinner" />
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
                label="Tilt (f/b)"
                min={-40}
                max={70}
                step={1}
                value={p.placement.pose.elevationDeg ?? 0}
                onChange={(v) => p.onPatchPose({ elevationDeg: v })}
                fmt={(v) => `${Math.round(v)}°`}
              />
              <Slider
                label="Tilt (l/r)"
                min={-45}
                max={45}
                step={1}
                value={p.placement.pose.rollDeg ?? 0}
                onChange={(v) => p.onPatchPose({ rollDeg: v })}
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

            <div className="slider-section">
              <div className="slider-section-title">Light</div>
              <Slider
                label="Brightness"
                min={0}
                max={100}
                step={1}
                value={p.placement.brightness}
                onChange={(v) => p.onPatch({ brightness: v })}
                fmt={(v) => `${Math.round(v)}`}
              />
              <Slider
                label="Light output"
                min={0}
                max={100}
                step={1}
                value={p.placement.lightOutput}
                onChange={(v) => p.onPatch({ lightOutput: v })}
                fmt={(v) => `${Math.round(v)}`}
              />
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
          </div>

          <div className="muted" style={{ fontSize: 11 }}>
            {p.mountLabel && <>Mount: {p.mountLabel}. </>}
            {p.renderStyle && <>Style: {RENDER_STYLE_LABELS[p.renderStyle]}. </>}
            <strong>Test render</strong> checks light & glass; <strong>Final render</strong> exports.
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
              transparentBg={p.transparentBg}
              maxCoverage={maxCoverage}
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
              transparentBg={p.transparentBg}
              maxCoverage={maxCoverage}
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
  transparentBg?: boolean;
  maxCoverage?: number;
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
  const fromCamera = useRef(false);
  const [modelDims, setModelDims] = useState<{ x: number; y: number; z: number } | null>(
    null,
  );
  const [roomAspect, setRoomAspect] = useState(16 / 9);

  const pose = p.placement.pose;

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

  const boxFrac =
    modelDims != null
      ? projectedBoxFrac(modelDims, pose, p.placement.coverage, roomAspect)
      : p.placement.coverage;

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
    p.onPatch({
      coverage: clamp(p.placement.coverage * factor, 0.08, p.maxCoverage ?? DEFAULT_MAX_COVERAGE),
    });
  }

  return (
    <div
      style={{
        position: "sticky",
        top: 12,
        zIndex: 5,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        ref={roomRef}
        className="placement-canvas"
        style={{
          position: "relative",
          width: "100%",
          borderRadius: 0,
          border: "none",
          ...(p.transparentBg ? CHECKERBOARD : null),
        }}
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

        {!p.showPreview && p.glbUrl && (
          <div
            style={{
              position: "absolute",
              left: `${p.placement.xPct * 100}%`,
              top: `${p.placement.yPct * 100}%`,
              height: `${boxFrac * 100}%`,
              aspectRatio: "1 / 1",
              transform: `translate(-50%, -50%) rotate(${pose.rollDeg ?? 0}deg)`,
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
  cutout: { url: string; coverageRef: number };
  cutoutBusy: boolean;
  previewUrl: string | null;
  showPreview: boolean;
  previewBusy: boolean;
  onPatch: (patch: Partial<AppShotPlacement>) => void;
  transparentBg?: boolean;
  maxCoverage?: number;
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
    p.onPatch({
      coverage: clamp(p.placement.coverage * factor, 0.08, p.maxCoverage ?? DEFAULT_MAX_COVERAGE),
    });
  }

  return (
    <div
      style={{
        position: "sticky",
        top: 12,
        zIndex: 5,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        ref={ref}
        className="placement-canvas"
        style={{
          cursor: p.showPreview ? "default" : "grab",
          maxHeight: "72vh",
          borderRadius: 0,
          border: "none",
          ...(p.transparentBg ? CHECKERBOARD : null),
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
      >
        <img src={p.sceneUrl} alt="room" draggable={false} style={{ maxHeight: "72vh", width: "auto" }} />

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

export function Slider({ label, min, max, step, value, onChange, fmt }: SliderProps) {
  return (
    <div className="slider-row">
      <label className="slider-label" style={{ margin: 0 }}>
        {label}
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider-input"
      />
      <span className="slider-value muted">{fmt(value)}</span>
    </div>
  );
}
