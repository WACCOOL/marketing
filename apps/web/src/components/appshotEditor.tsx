import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  raycastSurface,
  type AppShotPlacement,
  type AppShotSurface,
  type RenderQuality,
  type RenderStyle,
  type RoomBoxView,
  type RoomSurfaceKind,
} from "@wac/shared";
import { FixtureScene, MultiFixtureScene } from "../lib/fixtureScene.js";
import { FixtureThumb } from "./fixtureThumb.js";

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

/** Default upper bound for the fixture-size slider (overridable per studio). */
const DEFAULT_MAX_COVERAGE = 0.9;

/** Lower bound for the fixture-size slider/scroll (1% of the frame). */
export const MIN_COVERAGE = 0.01;

/** Wrap a degree value into [-180, 180] (orbit can drag past the slider range). */
function wrapDeg(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
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

/** One placed fixture of a multi-fixture layout, as the editor needs it. */
export interface EditorFixture {
  id: string;
  /** fixtureKey — used for the list thumbnail. */
  sku: string;
  /** Display name (catalog name, falls back to the SKU). */
  label: string;
  placement: AppShotPlacement;
  cutout: { url: string; coverageRef: number } | null;
  glbUrl: string | null;
}

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
  /** Multi-fixture layout (App Shot only; Cam Solve never passes these). List
   * order = back-to-front z-order. Sliders/canvas interactions still target
   * `placement` (the SELECTED fixture, passed as before). */
  fixtures?: EditorFixture[];
  selectedId?: string | null;
  onSelectFixture?: (id: string) => void;
  onRemoveFixture?: (id: string) => void;
  /** Open the fixture picker to add another fixture to the layout. */
  onAddFixture?: () => void;
  /** Solved room box (App Shot's corner-drag room match). When present AND the
   * selected fixture carries a `surface`, the editor switches to MATCHED mode:
   * the photo's camera frames the scene, fixtures sit on their mount surfaces
   * at true scale, and the position/size controls become surface-relative. */
  roomBox?: RoomBoxView | null;
}

/** Surface-relative slider labels per mount surface. */
const SURFACE_AXIS_LABELS: Record<RoomSurfaceKind, { u: string; v: string }> = {
  ceiling: { u: "Left / right", v: "Near / far" },
  floor: { u: "Left / right", v: "Near / far" },
  "wall-back": { u: "Left / right", v: "Floor / ceiling" },
  "wall-left": { u: "Near / far", v: "Floor / ceiling" },
  "wall-right": { u: "Near / far", v: "Floor / ceiling" },
};

const SURFACE_LABELS: Record<RoomSurfaceKind, string> = {
  ceiling: "Ceiling",
  "wall-back": "Back wall",
  "wall-left": "Left wall",
  "wall-right": "Right wall",
  floor: "Floor",
};

const RENDER_STYLE_LABELS: Record<RenderStyle, string> = {
  clean: "Clean cutout",
  cleanShadow: "Clean + drop shadow",
  studio: "Studio (lit backdrop)",
};

export function EditPanel(p: EditProps) {
  const viewer = p.viewerMode === "viewer";
  const maxCoverage = p.maxCoverage ?? DEFAULT_MAX_COVERAGE;
  // Matched mode: a solved room box + a surface-attached selection.
  const surface = (p.roomBox && p.placement.surface) || null;
  // Multi-fixture canvases kick in past one fixture; a single fixture keeps the
  // exact single-fixture code paths (incl. Cam Solve, which never passes fixtures)
  // — EXCEPT in matched mode, whose room camera lives in the multi scene.
  const multi =
    p.fixtures && (p.fixtures.length > 1 || (surface && viewer)) ? p.fixtures : null;
  const patchSurface = (patch: Partial<AppShotSurface>) => {
    if (surface) p.onPatch({ surface: { ...surface, ...patch } });
  };
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
            Track progress in your{" "}
            <Link
              to={
                p.queuedJobId
                  ? `/render-queue?job=${p.queuedJobId}`
                  : "/render-queue"
              }
            >
              Render Queue
            </Link>
            ; finished renders land in your Asset Library. Tweak and render
            again for another version anytime.
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
          {p.fixtures && (
            <div className="card col" style={{ gap: 8 }}>
              <div className="slider-section-title">Fixtures</div>
              {p.fixtures.map((f, i) => {
                const selected =
                  f.id === (p.selectedId ?? p.fixtures![0]!.id);
                return (
                  <div
                    key={f.id}
                    className="row"
                    style={{ gap: 8, alignItems: "center" }}
                  >
                    <button
                      type="button"
                      className={"product-card" + (selected ? " selected" : "")}
                      style={{
                        flex: 1,
                        display: "flex",
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        padding: 6,
                        textAlign: "left",
                      }}
                      onClick={() => p.onSelectFixture?.(f.id)}
                      title={
                        p.fixtures!.length > 1
                          ? "Select — the sliders and drag controls edit this fixture"
                          : f.label
                      }
                    >
                      <div style={{ width: 44, flexShrink: 0 }}>
                        <FixtureThumb fixtureKey={f.sku} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div
                          className="product-name"
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {i + 1} · {f.label}
                        </div>
                      </div>
                    </button>
                    {p.fixtures!.length > 1 && p.onRemoveFixture && (
                      <button
                        type="button"
                        className="secondary slim"
                        onClick={() => p.onRemoveFixture?.(f.id)}
                        title="Remove this fixture from the layout"
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
              {p.onAddFixture && (
                <button
                  type="button"
                  className="secondary"
                  onClick={p.onAddFixture}
                >
                  + Add fixture
                </button>
              )}
              {p.fixtures.length > 1 && (
                <div className="muted" style={{ fontSize: 11 }}>
                  Later fixtures render in front of earlier ones.
                  {p.roomBox
                    ? " Room matched: all fixtures render together in one scene with realistic combined lighting."
                    : p.fixtures.length > 4
                      ? " Renders run one fixture at a time, so test/final time grows with each fixture — Standard quality is recommended for large layouts."
                      : ""}
                </div>
              )}
            </div>
          )}
          {p.renderControls && (
            <div className="card col" style={{ gap: 12 }}>{p.renderControls}</div>
          )}
          <div className="card col appshot-sliders">
            {surface ? (
              <div className="slider-section">
                <div className="slider-section-title">Mount & position</div>
                <div className="row" style={{ gap: 6, alignItems: "center" }}>
                  <label style={{ margin: 0, fontSize: 12 }}>Mounted on</label>
                  <select
                    value={surface.kind}
                    onChange={(e) =>
                      patchSurface({ kind: e.target.value as RoomSurfaceKind })
                    }
                  >
                    {(Object.keys(SURFACE_LABELS) as RoomSurfaceKind[]).map((k) => (
                      <option key={k} value={k}>
                        {SURFACE_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <Slider
                  label="True size ×"
                  min={0.25}
                  max={4}
                  step={0.05}
                  value={surface.scale}
                  onChange={(v) => patchSurface({ scale: v })}
                  fmt={(v) => `×${v.toFixed(2)}`}
                />
                <Slider
                  label={SURFACE_AXIS_LABELS[surface.kind].u}
                  min={0}
                  max={1}
                  step={0.005}
                  value={surface.u}
                  onChange={(v) => patchSurface({ u: v })}
                  fmt={(v) => `${Math.round(v * 100)}%`}
                />
                <Slider
                  label={SURFACE_AXIS_LABELS[surface.kind].v}
                  min={0}
                  max={1}
                  step={0.005}
                  value={surface.v}
                  onChange={(v) => patchSurface({ v })}
                  fmt={(v) => `${Math.round(v * 100)}%`}
                />
                <Slider
                  label="Spin"
                  min={-180}
                  max={180}
                  step={1}
                  value={surface.lightYawDeg}
                  onChange={(v) => patchSurface({ lightYawDeg: v })}
                  fmt={(v) => `${Math.round(v)}°`}
                />
                <div className="muted" style={{ fontSize: 11 }}>
                  Room matched: the camera is the photo's, and ×1 is the
                  fixture's true physical size in the room.
                </div>
              </div>
            ) : (
              <>
                <div className="slider-section">
                  <div className="slider-section-title">Size & position</div>
                  <Slider
                    label="Fixture size"
                    min={MIN_COVERAGE}
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
                    <button className="secondary slim" onClick={() => p.onPatch({ coverage: clamp(p.placement.coverage * 0.9, MIN_COVERAGE, maxCoverage) })}>– smaller</button>
                    <button className="secondary slim" onClick={() => p.onPatch({ coverage: clamp(p.placement.coverage * 1.1, MIN_COVERAGE, maxCoverage) })}>+ larger</button>
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
                    min={-180}
                    max={180}
                    step={1}
                    value={p.placement.pose.elevationDeg ?? 0}
                    onChange={(v) => p.onPatchPose({ elevationDeg: v })}
                    fmt={(v) => `${Math.round(v)}°`}
                  />
                  <Slider
                    label="Tilt (l/r)"
                    min={-180}
                    max={180}
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
              </>
            )}

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
            multi ? (
              <MultiViewerCanvas
                sceneUrl={p.sceneUrl}
                placement={p.placement}
                fixtures={multi}
                selectedId={p.selectedId ?? multi[0]!.id}
                glbBusy={p.glbBusy}
                previewUrl={p.previewUrl}
                showPreview={p.showPreview}
                previewBusy={p.previewBusy}
                onPatch={p.onPatch}
                onPatchPose={p.onPatchPose}
                transparentBg={p.transparentBg}
                maxCoverage={maxCoverage}
                roomBox={p.roomBox}
              />
            ) : (
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
            )
          ) : p.cutout || multi || (p.showPreview && p.previewUrl) ? (
            // Render the canvas even while the SELECTED fixture's cutout is
            // still baking: other fixtures' cutouts (multi) and — critically —
            // a finished Test render must never be masked by the placeholder.
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
              fixtures={multi ?? undefined}
              selectedId={p.selectedId ?? undefined}
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
 * Real-time 3D placement: a transparent WebGL canvas spans the whole room image
 * and renders the fixture through a three.js camera configured IDENTICALLY to the
 * Blender render (render.py `place_camera` + composite.py fixture offset). Drag on
 * the canvas orbits (rotate/tilt), the move bar drags its screen position, scroll
 * resizes. Because the preview camera/FOV/roll/offset are 1:1 with the render,
 * Test render lands at the exact same angle/size/position — no jump, no mirror.
 */
function ModelViewerCanvas(p: ViewerCanvasProps) {
  const roomRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<FixtureScene | null>(null);
  const move = useRef<{ x: number; y: number; xPct: number; yPct: number } | null>(
    null,
  );
  const orbit = useRef<{ x: number; y: number; az: number; el: number } | null>(
    null,
  );
  const [roomAspect, setRoomAspect] = useState(16 / 9);

  const pose = p.placement.pose;

  // Create the WebGL scene once, sizing it to the room overlay via a ResizeObserver.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = roomRef.current;
    if (!canvas || !container) return;
    const scene = new FixtureScene(canvas);
    sceneRef.current = scene;
    const syncSize = () => {
      const r = container.getBoundingClientRect();
      scene.setSize(r.width, r.height);
    };
    const ro = new ResizeObserver(syncSize);
    ro.observe(container);
    syncSize();
    return () => {
      ro.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // Load (or swap) the fixture GLB whenever the URL changes.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !p.glbUrl) return;
    scene.loadModel(p.glbUrl).catch(() => {
      /* a newer load supersedes this one, or the URL 404s — non-fatal */
    });
  }, [p.glbUrl]);

  // Push the live pose/placement into the scene (cheap; renders one frame).
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.update({
      pose,
      coverage: p.placement.coverage,
      xPct: p.placement.xPct,
      yPct: p.placement.yPct,
      aspect: roomAspect,
    });
  }, [
    pose.azimuthDeg,
    pose.elevationDeg,
    pose.rollDeg,
    pose.fovDeg,
    pose.distanceFactor,
    p.placement.coverage,
    p.placement.xPct,
    p.placement.yPct,
    roomAspect,
  ]);

  function onOrbitDown(e: React.PointerEvent) {
    if (p.showPreview) return;
    orbit.current = {
      x: e.clientX,
      y: e.clientY,
      az: pose.azimuthDeg ?? 0,
      el: pose.elevationDeg ?? 0,
    };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onOrbitMove(e: React.PointerEvent) {
    const o = orbit.current;
    if (!o) return;
    const dx = e.clientX - o.x;
    const dy = e.clientY - o.y;
    p.onPatchPose(
      {
        azimuthDeg: wrapDeg(o.az + dx * 0.4),
        elevationDeg: clamp(o.el - dy * 0.4, -180, 180),
      },
      false,
    );
  }
  function endOrbit(e: React.PointerEvent) {
    if (orbit.current) {
      orbit.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    }
  }

  function onMovePointerDown(e: React.PointerEvent) {
    if (p.showPreview) return;
    e.stopPropagation();
    move.current = {
      x: e.clientX,
      y: e.clientY,
      xPct: p.placement.xPct,
      yPct: p.placement.yPct,
    };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onMovePointerMove(e: React.PointerEvent) {
    const d = move.current;
    const rect = roomRef.current?.getBoundingClientRect();
    if (!d || !rect || rect.width === 0 || rect.height === 0) return;
    e.stopPropagation();
    const dx = (e.clientX - d.x) / rect.width;
    const dy = (e.clientY - d.y) / rect.height;
    p.onPatch({ xPct: clamp(d.xPct + dx, 0, 1), yPct: clamp(d.yPct + dy, 0, 1) });
  }
  function endMove(e: React.PointerEvent) {
    if (move.current) {
      move.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    }
  }
  function onWheel(e: React.WheelEvent) {
    if (p.showPreview) return;
    const factor = e.deltaY > 0 ? 0.95 : 1.05;
    p.onPatch({
      coverage: clamp(p.placement.coverage * factor, MIN_COVERAGE, p.maxCoverage ?? DEFAULT_MAX_COVERAGE),
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

        {/* Full-frame WebGL fixture overlay (matches the render frame exactly). */}
        <canvas
          ref={canvasRef}
          onPointerDown={onOrbitDown}
          onPointerMove={onOrbitMove}
          onPointerUp={endOrbit}
          onPointerCancel={endOrbit}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            display: p.showPreview ? "none" : "block",
            cursor: orbit.current ? "grabbing" : "grab",
            touchAction: "none",
          }}
        />

        {!p.showPreview && p.glbUrl && (
          <div
            onPointerDown={onMovePointerDown}
            onPointerMove={onMovePointerMove}
            onPointerUp={endMove}
            onPointerCancel={endMove}
            title="Drag to move"
            style={{
              position: "absolute",
              left: `${p.placement.xPct * 100}%`,
              top: `${p.placement.yPct * 100}%`,
              transform: "translate(-50%, -50%)",
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

/* ------------------------------------------------- multi-fixture 3D canvas -- */

interface MultiViewerCanvasProps {
  sceneUrl: string;
  /** The SELECTED fixture's placement — drag / wheel / move edit this one. */
  placement: AppShotPlacement;
  fixtures: EditorFixture[];
  selectedId: string;
  glbBusy: boolean;
  previewUrl: string | null;
  showPreview: boolean;
  previewBusy: boolean;
  onPatch: (patch: Partial<AppShotPlacement>) => void;
  onPatchPose: (patch: Partial<AppShotPlacement["pose"]>, rerender?: boolean) => void;
  transparentBg?: boolean;
  maxCoverage?: number;
  /** Solved room box — switches the scene & interactions to MATCHED mode. */
  roomBox?: RoomBoxView | null;
}

/**
 * Real-time 3D placement for a multi-fixture layout: every fixture's GLB in one
 * WebGL scene behind a single fixed camera (see MultiFixtureScene for the
 * camera-conjugation math). Dragging orbits the SELECTED fixture's pose, the
 * move badge drags its position, scroll resizes it — identical interactions to
 * the single-fixture viewer, just scoped to the selection.
 */
function MultiViewerCanvas(p: MultiViewerCanvasProps) {
  const roomRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<MultiFixtureScene | null>(null);
  const loadedUrls = useRef<Map<string, string>>(new Map());
  const move = useRef<{ x: number; y: number; xPct: number; yPct: number } | null>(
    null,
  );
  const orbit = useRef<{ x: number; y: number; az: number; el: number } | null>(
    null,
  );
  // Matched-mode drag: slide the selected fixture along its mount surface.
  const slide = useRef<{ x: number; y: number; u: number; v: number } | null>(null);
  const [roomAspect, setRoomAspect] = useState(16 / 9);

  const pose = p.placement.pose;
  const surface = (p.roomBox && p.placement.surface) || null;

  /** Pointer event → normalized image coords inside the room overlay. */
  function pointerToNorm(e: React.PointerEvent): { x: number; y: number } | null {
    const rect = roomRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  }

  /** Matched mode: drag deltas in surface (u,v) space — raycast the pointer's
   * start and current image points onto the mount surface and move by the
   * difference, so the fixture follows the cursor along the real plane. */
  function slideTo(e: React.PointerEvent) {
    const s = slide.current;
    if (!s || !p.roomBox || !surface) return;
    const start = raycastSurface(p.roomBox, { x: s.x, y: s.y }, surface.kind);
    const now = pointerToNorm(e);
    const cur = now && raycastSurface(p.roomBox, now, surface.kind);
    if (!start || !cur) return;
    p.onPatch({
      surface: {
        ...surface,
        u: clamp(s.u + (cur.u - start.u), 0, 1),
        v: clamp(s.v + (cur.v - start.v), 0, 1),
      },
    });
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = roomRef.current;
    if (!canvas || !container) return;
    const scene = new MultiFixtureScene(canvas);
    sceneRef.current = scene;
    loadedUrls.current = new Map();
    const syncSize = () => {
      const r = container.getBoundingClientRect();
      scene.setSize(r.width, r.height);
    };
    const ro = new ResizeObserver(syncSize);
    ro.observe(container);
    syncSize();
    return () => {
      ro.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // Load / swap / remove fixture GLBs as the layout changes.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const ids = new Set(p.fixtures.map((f) => f.id));
    for (const id of [...loadedUrls.current.keys()]) {
      if (!ids.has(id)) {
        loadedUrls.current.delete(id);
        scene.removeModel(id);
      }
    }
    for (const f of p.fixtures) {
      if (!f.glbUrl || loadedUrls.current.get(f.id) === f.glbUrl) continue;
      loadedUrls.current.set(f.id, f.glbUrl);
      scene.loadModel(f.id, f.glbUrl).catch(() => {
        // a newer load supersedes this one, or the URL 404s — non-fatal
        loadedUrls.current.delete(f.id);
      });
    }
  }, [p.fixtures]);

  // Push the live placements into the scene (cheap; renders one frame).
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.update({
      instances: p.fixtures.map((f) => ({
        id: f.id,
        pose: f.placement.pose,
        coverage: f.placement.coverage,
        xPct: f.placement.xPct,
        yPct: f.placement.yPct,
        surface: f.placement.surface,
      })),
      selectedId: p.selectedId,
      aspect: roomAspect,
      room: p.roomBox,
    });
  }, [p.fixtures, p.selectedId, roomAspect, p.roomBox]);

  function onOrbitDown(e: React.PointerEvent) {
    if (p.showPreview) return;
    if (surface) {
      // Matched mode: the camera is the photo's — dragging the canvas slides
      // the selected fixture along its mount surface instead of orbiting.
      const pt = pointerToNorm(e);
      if (!pt) return;
      slide.current = { ...pt, u: surface.u, v: surface.v };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      return;
    }
    orbit.current = {
      x: e.clientX,
      y: e.clientY,
      az: pose.azimuthDeg ?? 0,
      el: pose.elevationDeg ?? 0,
    };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onOrbitMove(e: React.PointerEvent) {
    if (slide.current) {
      slideTo(e);
      return;
    }
    const o = orbit.current;
    if (!o) return;
    const dx = e.clientX - o.x;
    const dy = e.clientY - o.y;
    p.onPatchPose(
      {
        azimuthDeg: wrapDeg(o.az + dx * 0.4),
        elevationDeg: clamp(o.el - dy * 0.4, -180, 180),
      },
      false,
    );
  }
  function endOrbit(e: React.PointerEvent) {
    if (orbit.current || slide.current) {
      orbit.current = null;
      slide.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    }
  }

  function onMovePointerDown(e: React.PointerEvent) {
    if (p.showPreview) return;
    e.stopPropagation();
    if (surface) {
      const pt = pointerToNorm(e);
      if (!pt) return;
      slide.current = { ...pt, u: surface.u, v: surface.v };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      return;
    }
    move.current = {
      x: e.clientX,
      y: e.clientY,
      xPct: p.placement.xPct,
      yPct: p.placement.yPct,
    };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onMovePointerMove(e: React.PointerEvent) {
    if (slide.current) {
      e.stopPropagation();
      slideTo(e);
      return;
    }
    const d = move.current;
    const rect = roomRef.current?.getBoundingClientRect();
    if (!d || !rect || rect.width === 0 || rect.height === 0) return;
    e.stopPropagation();
    const dx = (e.clientX - d.x) / rect.width;
    const dy = (e.clientY - d.y) / rect.height;
    p.onPatch({ xPct: clamp(d.xPct + dx, 0, 1), yPct: clamp(d.yPct + dy, 0, 1) });
  }
  function endMove(e: React.PointerEvent) {
    if (move.current || slide.current) {
      move.current = null;
      slide.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    }
  }
  function onWheel(e: React.WheelEvent) {
    if (p.showPreview) return;
    const factor = e.deltaY > 0 ? 0.95 : 1.05;
    if (surface) {
      p.onPatch({
        surface: { ...surface, scale: clamp(surface.scale * factor, 0.25, 4) },
      });
      return;
    }
    p.onPatch({
      coverage: clamp(p.placement.coverage * factor, MIN_COVERAGE, p.maxCoverage ?? DEFAULT_MAX_COVERAGE),
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

        {/* Full-frame WebGL overlay with every fixture (matches the render frame). */}
        <canvas
          ref={canvasRef}
          onPointerDown={onOrbitDown}
          onPointerMove={onOrbitMove}
          onPointerUp={endOrbit}
          onPointerCancel={endOrbit}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            display: p.showPreview ? "none" : "block",
            cursor: orbit.current ? "grabbing" : "grab",
            touchAction: "none",
          }}
        />

        {!p.showPreview && (
          <div
            onPointerDown={onMovePointerDown}
            onPointerMove={onMovePointerMove}
            onPointerUp={endMove}
            onPointerCancel={endMove}
            title="Drag to move the selected fixture"
            style={{
              position: "absolute",
              left: `${p.placement.xPct * 100}%`,
              top: `${p.placement.yPct * 100}%`,
              transform: "translate(-50%, -50%)",
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
  /** Null while the selected fixture's cutout is still rendering. */
  cutout: { url: string; coverageRef: number } | null;
  cutoutBusy: boolean;
  previewUrl: string | null;
  showPreview: boolean;
  previewBusy: boolean;
  onPatch: (patch: Partial<AppShotPlacement>) => void;
  transparentBg?: boolean;
  maxCoverage?: number;
  /** Multi-fixture: every fixture's cutout is stacked in list (z) order; drag /
   * wheel still edit `placement` (the selected fixture). */
  fixtures?: EditorFixture[];
  selectedId?: string;
}

/** CSS transform that places a cutout at its placement (scale + center shift). */
function cutoutTransform(
  placement: AppShotPlacement,
  coverageRef: number,
): string {
  const scale = placement.coverage / (coverageRef || 0.5);
  const tx = (placement.xPct - 0.5) * 100;
  const ty = (placement.yPct - 0.5) * 100;
  return `translate(${tx}%, ${ty}%) scale(${scale})`;
}

function ShotCanvas(p: CanvasProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; xPct: number; yPct: number } | null>(
    null,
  );

  // Single-fixture (and Cam Solve) renders exactly one overlay; multi-fixture
  // stacks every fixture that has a cutout, selected one outlined. A fixture
  // whose cutout is still baking simply isn't drawn yet.
  const overlays = p.fixtures
    ? p.fixtures
        .filter((f) => f.cutout)
        .map((f) => ({
          key: f.id,
          url: f.cutout!.url,
          transform: cutoutTransform(f.placement, f.cutout!.coverageRef),
          selected: f.id === (p.selectedId ?? p.fixtures![0]!.id),
        }))
    : p.cutout
      ? [
          {
            key: "single",
            url: p.cutout.url,
            transform: cutoutTransform(p.placement, p.cutout.coverageRef),
            selected: false, // no selection ring when there's nothing to choose
          },
        ]
      : [];

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
      coverage: clamp(p.placement.coverage * factor, MIN_COVERAGE, p.maxCoverage ?? DEFAULT_MAX_COVERAGE),
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

        {!p.showPreview &&
          overlays.map((o) => (
            <img
              key={o.key}
              src={o.url}
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
                transform: o.transform,
                // A soft halo marks the SELECTED fixture (the one the sliders
                // and drag edit) without covering any of its pixels.
                filter: o.selected
                  ? "drop-shadow(0 0 6px var(--accent))"
                  : undefined,
              }}
            />
          ))}

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
