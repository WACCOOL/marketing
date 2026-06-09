import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppShotPlacement,
  GeminiAspectRatio,
  RenderQuality,
  RenderStyle,
} from "@wac/shared";
import { uploadImage } from "../lib/uploads.js";
import { apiBlob } from "../lib/api.js";
import {
  cutoutShot,
  finalizeShot,
  glbShot,
  listFixtures,
  previewShot,
  type ShotFixture,
} from "../lib/appshot.js";
import {
  BACKGROUND_PRESETS,
  isHexColor,
  makeBackgroundPlate,
  plateLongEdge,
  type BackgroundChoice,
} from "../lib/background.js";
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
 * Cam Solve studio.
 *
 * The 3D App-Shot experience, but the fixture is staged over a plain backdrop
 * (transparent or a solid color) instead of a room. We reuse the same fixture
 * picker, 3D placement editor and render pipeline; only the background changes.
 * The backdrop is generated client-side as a PNG plate, uploaded, and fed in as
 * the scene, so the entire App-Shot pipeline works unchanged. The render style
 * (clean cutout / clean + drop shadow / studio lit backdrop) controls how the
 * fixture is composited onto it. Both the background and render style can be
 * changed live in the editor; the plate is regenerated on the fly.
 */

const STORAGE_KEY = "wac.camsolve.v1";

const ASPECT_RATIOS: { value: GeminiAspectRatio; label: string }[] = [
  { value: "1:1", label: "1:1 — square" },
  { value: "4:3", label: "4:3 — classic" },
  { value: "3:2", label: "3:2 — photo" },
  { value: "16:9", label: "16:9 — wide" },
];

const RENDER_STYLES: { value: RenderStyle; label: string; hint: string }[] = [
  { value: "clean", label: "Clean cutout", hint: "Fixture only — keeps transparency" },
  { value: "cleanShadow", label: "Clean + shadow", hint: "Adds a soft drop shadow" },
  { value: "studio", label: "Studio", hint: "Lit backdrop with contact shadow" },
];

// Cam Solve starts the fixture centered and sized to fill the plate — there's no
// room to compose against, so the fixture is the subject. coverage is the
// fixture's box as a fraction of the plate height (1 = full height); the slider
// goes higher so the fixture can overflow and clip past the edges if wanted.
const CAM_MAX_COVERAGE = 2.5;
const DEFAULT_PLACEMENT: AppShotPlacement = {
  xPct: 0.5,
  yPct: 0.5,
  coverage: 1,
  brightness: 25,
  lightOutput: 25,
  warm: 0.45,
  pose: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 0, fovDeg: 36, distanceFactor: 1, marginFactor: 1.25 },
};

/** A centered manual placement; angled a touch by mount so it reads as 3D. */
function defaultPlacementFor(mount: string | undefined): AppShotPlacement {
  if (mount === "ceiling" || mount === "recessed") {
    return { ...DEFAULT_PLACEMENT, pose: { ...DEFAULT_PLACEMENT.pose, elevationDeg: -18 } };
  }
  if (mount === "wall") {
    return { ...DEFAULT_PLACEMENT, pose: { ...DEFAULT_PLACEMENT.pose, azimuthDeg: -8, fovDeg: 30 } };
  }
  return DEFAULT_PLACEMENT;
}

interface Cutout {
  url: string;
  coverageRef: number;
}

interface Glb {
  sku: string;
  url: string;
}

interface Persisted {
  sku: string | null;
  choice: BackgroundChoice;
  aspect: GeminiAspectRatio;
  renderStyle: RenderStyle;
  renderQuality: RenderQuality;
  sceneUrl: string | null;
  placement: AppShotPlacement | null;
  cutout: Cutout | null;
  glb: Glb | null;
  viewerMode: ViewerMode | null;
  previewUrl: string | null;
  finalAssetId: string | null;
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

export function CamSolve() {
  const saved = useRef<Persisted | null>(loadPersisted());

  // Boot the render worker while the editor is open so the first Test/Final
  // render skips the cold-container boot (kernels are already cached).
  usePrewarmWorker();

  const [fixtures, setFixtures] = useState<ShotFixture[]>([]);
  const [fixturesErr, setFixturesErr] = useState<string | null>(null);
  const [fixtureQuery, setFixtureQuery] = useState("");
  const [fixtureBrand, setFixtureBrand] = useState("");
  const [fixtureBrands, setFixtureBrands] = useState<string[]>([]);
  const [fixturesTotal, setFixturesTotal] = useState(0);
  const [sku, setSku] = useState<string | null>(saved.current?.sku ?? null);

  const [choice, setChoice] = useState<BackgroundChoice>(
    saved.current?.choice ?? { kind: "transparent" },
  );
  const [hex, setHex] = useState<string>(
    saved.current?.choice?.kind === "color" ? (saved.current.choice.color ?? "#808080") : "#808080",
  );
  const [aspect, setAspect] = useState<GeminiAspectRatio>(saved.current?.aspect ?? "1:1");
  const [renderStyle, setRenderStyle] = useState<RenderStyle>(
    saved.current?.renderStyle ?? "clean",
  );
  const [renderQuality, setRenderQuality] = useState<RenderQuality>(
    saved.current?.renderQuality ?? "standard",
  );

  const [sceneUrl, setSceneUrl] = useState<string | null>(saved.current?.sceneUrl ?? null);
  const [plateBusy, setPlateBusy] = useState(false);

  const [placement, setPlacement] = useState<AppShotPlacement | null>(
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

  const [error, setError] = useState<string | null>(null);

  const poseTimer = useRef<number | null>(null);
  const bgTimer = useRef<number | null>(null);
  const cutoutBusyRef = useRef(false);
  const pendingCutout = useRef<AppShotPlacement | null>(null);

  // `sku` holds the selected fixtureKey (a scene option); find its fixture group.
  const fixture =
    fixtures.find((f) => f.options.some((o) => o.fixtureKey === sku)) ?? null;
  const placementReady =
    viewerMode === "viewer" ? Boolean(glb && glb.sku === sku) : Boolean(cutout);
  const editing = Boolean(placement && sceneUrl && placementReady);
  const transparentBg = choice.kind === "transparent";

  // Studio (lit backdrop) needs a surface for light/shadow; a transparent plate
  // has none, so force a clean style whenever transparent is selected.
  const effectiveStyle: RenderStyle =
    transparentBg && renderStyle === "studio" ? "clean" : renderStyle;

  // Browse the fixtures registry, debounced on the search box. Auto-select the
  // first result only when nothing is picked yet.
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

  useEffect(() => {
    const snap: Persisted = {
      sku,
      choice,
      aspect,
      renderStyle,
      renderQuality,
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
  }, [
    sku,
    choice,
    aspect,
    renderStyle,
    renderQuality,
    sceneUrl,
    placement,
    cutout,
    glb,
    viewerMode,
    previewUrl,
    finalAssetId,
  ]);

  useEffect(() => {
    return () => {
      if (poseTimer.current) window.clearTimeout(poseTimer.current);
      if (bgTimer.current) window.clearTimeout(bgTimer.current);
    };
  }, []);

  /** The plate is square-ish; render the cutout to match its aspect. */
  function sceneRenderSize(): Promise<{ width: number; height: number }> {
    return new Promise((resolve) => {
      if (!sceneUrl) return resolve({ width: 1024, height: 1024 });
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || 1024;
        const h = img.naturalHeight || 1024;
        const longEdge = 800;
        const s = Math.min(1, longEdge / Math.max(w, h));
        resolve({
          width: Math.max(8, Math.round(w * s)),
          height: Math.max(8, Math.round(h * s)),
        });
      };
      img.onerror = () => resolve({ width: 1024, height: 1024 });
      img.src = sceneUrl;
    });
  }

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
    [sku, sceneUrl],
  );

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

  function resetForNewPlate() {
    setPlacement(null);
    setCutout(null);
    setPreviewUrl(null);
    setShowPreview(false);
    setFinalAssetId(null);
    setFinalStatus(null);
    setQueued(false);
    setQueuedJobId(null);
  }

  /** Build + upload a backdrop plate for the current choice/aspect/quality. The
   * plate resolution scales with the quality tier (it caps the clean-cutout
   * output size). */
  async function buildPlate(
    activeChoice: BackgroundChoice,
    quality: RenderQuality = renderQuality,
  ): Promise<string> {
    const file = await makeBackgroundPlate({
      choice: activeChoice,
      aspect,
      longEdge: plateLongEdge(quality),
    });
    const { url } = await uploadImage(file);
    return url;
  }

  // Generate the backdrop plate, upload it as the scene, then drop the fixture in
  // at a centered manual placement (no AI vision — a blank plate has nothing to
  // analyze) and load whatever the active placement mode needs.
  async function placeFixture() {
    if (!sku) return;
    setError(null);
    setPlacing(true);
    setPlateBusy(true);
    try {
      const activeChoice: BackgroundChoice =
        choice.kind === "color" ? { kind: "color", color: hex } : { kind: "transparent" };
      const url = await buildPlate(activeChoice);
      setSceneUrl(url);
      resetForNewPlate();
      const next = defaultPlacementFor(fixture?.mount);
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
      setPlateBusy(false);
    }
  }

  // --- live background edits (regenerate the plate without leaving the editor) -
  async function regenBackground(
    next: BackgroundChoice,
    quality: RenderQuality = renderQuality,
  ) {
    if (!sku) return;
    setError(null);
    setPlateBusy(true);
    try {
      const url = await buildPlate(next, quality);
      setSceneUrl(url);
      // A new backdrop invalidates the last test render.
      setPreviewUrl(null);
      setShowPreview(false);
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setPlateBusy(false);
    }
  }

  function scheduleBackground(next: BackgroundChoice) {
    if (bgTimer.current) window.clearTimeout(bgTimer.current);
    bgTimer.current = window.setTimeout(() => void regenBackground(next), 350);
  }

  /** Apply a background choice; regenerate the plate live when already editing. */
  function applyChoice(next: BackgroundChoice, regen: boolean) {
    setChoice(next);
    if (next.kind === "color" && next.color) setHex(next.color);
    if (regen) scheduleBackground(next);
  }

  /** Apply a typed/picked hex; switch to a color background when valid. */
  function applyHex(value: string, regen: boolean) {
    setHex(value);
    if (isHexColor(value)) {
      const next: BackgroundChoice = { kind: "color", color: value };
      setChoice(next);
      if (regen) scheduleBackground(next);
    }
  }

  function changeRenderStyle(next: RenderStyle) {
    setRenderStyle(next);
    // Style affects the render, not the live overlay; just drop the stale preview.
    setShowPreview(false);
  }

  // The quality tier also sets the plate resolution (the clean-cutout output
  // size), so regenerate the plate live when it changes mid-edit.
  function changeQuality(next: RenderQuality) {
    if (next === renderQuality) return;
    setRenderQuality(next);
    setShowPreview(false);
    if (sceneUrl) void regenBackground(currentChoice(), next);
  }

  /** The background choice currently in effect (color uses the live hex). */
  function currentChoice(): BackgroundChoice {
    return choice.kind === "color" ? { kind: "color", color: hex } : { kind: "transparent" };
  }

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

  function patchPlacement(patch: Partial<AppShotPlacement>) {
    setPlacement((p) => (p ? { ...p, ...patch } : p));
    setShowPreview(false);
  }

  function patchPose(patch: Partial<AppShotPlacement["pose"]>, rerender = true) {
    setPlacement((p) => {
      if (!p) return p;
      const next = { ...p, pose: { ...p.pose, ...patch } };
      if (rerender && viewerMode === "overlay") {
        if (poseTimer.current) window.clearTimeout(poseTimer.current);
        poseTimer.current = window.setTimeout(() => void refreshCutout(next), 400);
      }
      return next;
    });
    setShowPreview(false);
  }

  // Reset size / position / angle / light back to the centered defaults.
  function resetPlacement() {
    const next = defaultPlacementFor(fixture?.mount);
    setPlacement(next);
    setShowPreview(false);
    if (viewerMode === "overlay") void refreshCutout(next);
  }

  async function runTestRender() {
    if (!sku || !sceneUrl || !placement) return;
    setError(null);
    setPreviewBusy(true);
    try {
      const r = await previewShot({
        sku,
        sceneUrl,
        placement,
        renderStyle: effectiveStyle,
        renderQuality,
      });
      setPreviewUrl(r.previewUrl);
      setShowPreview(true);
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setPreviewBusy(false);
    }
  }

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
        name: `${sku} cam solve`,
        renderStyle: effectiveStyle,
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
      a.download = `${sku ?? "cam-solve"}.${format}`;
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
    resetForNewPlate();
    setSceneUrl(null);
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0 }}>Cam Solve</h2>
          <div className="muted">
            Stage the real fixture over a transparent or solid-color background,
            then render it as a clean cutout, with a drop shadow, or on a lit
            studio backdrop.
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
          choice={choice}
          hex={hex}
          onChoiceChange={(c) => applyChoice(c, false)}
          onHexInput={(v) => applyHex(v, false)}
          aspect={aspect}
          setAspect={setAspect}
          renderStyle={renderStyle}
          onRenderStyle={setRenderStyle}
          renderQuality={renderQuality}
          onRenderQuality={setRenderQuality}
          transparentBg={transparentBg}
          plateBusy={plateBusy}
          placing={placing}
          onPlace={placeFixture}
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
          onTestRender={runTestRender}
          onFinalize={runFinalize}
          onDownload={download}
          transparentBg={transparentBg}
          renderStyle={effectiveStyle}
          maxCoverage={CAM_MAX_COVERAGE}
          onReset={resetPlacement}
          renderControls={
            <>
              <BackgroundPicker
                choice={choice}
                hex={hex}
                onChoiceChange={(c) => applyChoice(c, true)}
                onHexInput={(v) => applyHex(v, true)}
                busy={plateBusy}
              />
              <RenderStylePicker
                renderStyle={renderStyle}
                onRenderStyle={changeRenderStyle}
                transparentBg={transparentBg}
              />
              <QualityPicker
                quality={renderQuality}
                onChange={changeQuality}
                disabled={plateBusy}
              />
            </>
          }
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- pickers -- */

const SWATCH_CHECKER: React.CSSProperties = {
  backgroundColor: "#fff",
  backgroundImage:
    "linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%, #ccc), linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%, #ccc)",
  backgroundSize: "12px 12px",
  backgroundPosition: "0 0, 6px 6px",
};

function sameChoice(a: BackgroundChoice, b: BackgroundChoice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "color") return (a.color ?? "").toLowerCase() === (b.color ?? "").toLowerCase();
  return true;
}

interface BackgroundPickerProps {
  choice: BackgroundChoice;
  hex: string;
  onChoiceChange: (c: BackgroundChoice) => void;
  onHexInput: (v: string) => void;
  busy?: boolean;
}

function BackgroundPicker(p: BackgroundPickerProps) {
  const hexValid = isHexColor(p.hex);
  return (
    <div className="col" style={{ gap: 8 }}>
      <label style={{ margin: 0 }}>
        Background
        {p.busy && (
          <>
            {" "}
            <span className="spinner" />
          </>
        )}
      </label>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {BACKGROUND_PRESETS.map((preset) => {
          const selected = sameChoice(p.choice, preset.choice);
          const swatchStyle: React.CSSProperties =
            preset.choice.kind === "transparent"
              ? SWATCH_CHECKER
              : { backgroundColor: preset.choice.color };
          return (
            <button
              key={preset.id}
              type="button"
              className={"tag" + (selected ? " tag-selected" : "")}
              onClick={() => p.onChoiceChange(preset.choice)}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  border: "1px solid var(--border)",
                  ...swatchStyle,
                }}
              />
              {preset.label}
            </button>
          );
        })}
      </div>
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="color"
          value={hexValid ? p.hex : "#808080"}
          onChange={(e) => p.onChoiceChange({ kind: "color", color: e.target.value })}
          style={{ width: 40, height: 32, padding: 0, border: "1px solid var(--border)", borderRadius: 6 }}
          title="Pick a custom color"
        />
        <input
          type="text"
          value={p.hex}
          placeholder="#808080"
          onChange={(e) => p.onHexInput(e.target.value)}
          style={{ width: 110 }}
        />
        {!hexValid && <span className="muted" style={{ fontSize: 12 }}>enter #rgb or #rrggbb</span>}
      </div>
    </div>
  );
}

interface RenderStylePickerProps {
  renderStyle: RenderStyle;
  onRenderStyle: (s: RenderStyle) => void;
  transparentBg: boolean;
}

function RenderStylePicker(p: RenderStylePickerProps) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <label style={{ margin: 0 }}>Render style</label>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {RENDER_STYLES.map((s) => {
          const disabled = s.value === "studio" && p.transparentBg;
          const selected = p.renderStyle === s.value;
          return (
            <button
              key={s.value}
              type="button"
              className={"tag" + (selected ? " tag-selected" : "")}
              onClick={() => p.onRenderStyle(s.value)}
              disabled={disabled}
              title={disabled ? "Studio needs an opaque background" : s.hint}
            >
              {s.label}
            </button>
          );
        })}
      </div>
      {p.transparentBg && p.renderStyle === "studio" && (
        <div className="muted" style={{ fontSize: 12 }}>
          Studio needs an opaque background — a clean style will be used for a
          transparent plate.
        </div>
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
  choice: BackgroundChoice;
  hex: string;
  onChoiceChange: (c: BackgroundChoice) => void;
  onHexInput: (v: string) => void;
  aspect: GeminiAspectRatio;
  setAspect: (a: GeminiAspectRatio) => void;
  renderStyle: RenderStyle;
  onRenderStyle: (s: RenderStyle) => void;
  renderQuality: RenderQuality;
  onRenderQuality: (q: RenderQuality) => void;
  transparentBg: boolean;
  plateBusy: boolean;
  placing: boolean;
  onPlace: () => void;
}

function SetupPanel(p: SetupProps) {
  const canPlace = Boolean(p.sku) && !p.placing;

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
        {/* The grid itself must NOT be the scroll container — WebKit mis-sizes
            grid items inside an overflow:auto grid. Scroll a plain wrapper. */}
        <div style={{ maxHeight: 440, overflowY: "auto", paddingRight: 4 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))",
              gap: 10,
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
                    imageUrl={f.thumbnailUrl}
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
                  <FixtureThumb fixtureKey={o.fixtureKey} />
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
          <h3 style={{ margin: 0 }}>2 · Background &amp; style</h3>
          <div className="muted">
            Choose a backdrop and render style — both can be changed later while
            you place the fixture.
          </div>
        </div>

        <BackgroundPicker
          choice={p.choice}
          hex={p.hex}
          onChoiceChange={p.onChoiceChange}
          onHexInput={p.onHexInput}
          busy={p.plateBusy}
        />

        <div>
          <label>Aspect ratio</label>
          <select
            value={p.aspect}
            onChange={(e) => p.setAspect(e.target.value as GeminiAspectRatio)}
          >
            {ASPECT_RATIOS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>

        <RenderStylePicker
          renderStyle={p.renderStyle}
          onRenderStyle={p.onRenderStyle}
          transparentBg={p.transparentBg}
        />

        <QualityPicker quality={p.renderQuality} onChange={p.onRenderQuality} />

        <div className="row" style={{ gap: 8 }}>
          <button onClick={p.onPlace} disabled={!canPlace}>
            {p.placing || p.plateBusy ? <span className="spinner" /> : null}
            Place fixture
          </button>
        </div>
      </div>
    </div>
  );
}
