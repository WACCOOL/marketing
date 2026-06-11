import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  raycastSurface,
  solvedFromGeometry,
  surfaceForMount,
  surfaceImagePoint,
  type AppShotPlacement,
  type GeminiAspectRatio,
  type GeminiImageSize,
  type RenderQuality,
  type RoomGeometry,
} from "@wac/shared";
import { isAllowedImageType, uploadImage } from "../lib/uploads.js";
import { generateScene } from "../lib/scenes.js";
import { api, apiBlob } from "../lib/api.js";
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
  clamp,
  EditPanel,
  QualityPicker,
  type ViewerMode,
} from "../components/appshotEditor.js";
import { FixtureThumb } from "../components/fixtureThumb.js";
import { RoomBoxCalibrator } from "../components/RoomBoxCalibrator.js";

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

const STORAGE_KEY = "wac.appshot.v4";
/** Pre-multi-fixture snapshot — migrated to v4 on load, then superseded. */
const LEGACY_STORAGE_KEY = "wac.appshot.v3";

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
  brightness: 50,
  lightOutput: 50,
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
      brightness: 50,
      lightOutput: 50,
      warm: 0.45,
      pose: { azimuthDeg: -8, elevationDeg: 2, rollDeg: 0, fovDeg: 30, distanceFactor: 1, marginFactor: 1.25 },
    };
  }
  if (mount === "floor") {
    return {
      xPct: 0.5,
      yPct: 0.6,
      coverage: 0.4,
      brightness: 50,
      lightOutput: 50,
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

/** One fixture placed in the layout. List order = back-to-front render order. */
interface PlacedFixture {
  /** Stable client id — selection, cutout queueing, and job round-trips. */
  id: string;
  /** fixtureKey (a scene option of a catalog fixture). */
  sku: string;
  placement: AppShotPlacement;
  cutout: Cutout | null;
  glb: Glb | null;
}

interface Persisted {
  v: 4;
  sceneUrl: string | null;
  fixtures: PlacedFixture[];
  selectedId: string | null;
  viewerMode: ViewerMode | null;
  previewUrl: string | null;
  finalAssetId: string | null;
  renderQuality: RenderQuality;
}

/** The single-fixture (v3) snapshot shape, migrated on load. */
interface PersistedV3 {
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

/** Backfill fields added since the snapshot was written (e.g. lightOutput) so
 * newer sliders never bind to `undefined`. */
function backfillFixture(f: PlacedFixture): PlacedFixture {
  return { ...f, placement: { ...DEFAULT_PLACEMENT, ...f.placement } };
}

/**
 * Convert a brightness/lightOutput value from the OLD linear scale (25 =
 * neutral, the team exported at ~1) to the new curve (50 = the old "1" look,
 * squared response). Equating the intensities gives v_new = 50·√v_old — e.g.
 * old 1 → 50, old 4 → 100. Without this, migrated/restored layouts carry old
 * values like 1 that the new curve renders as ~zero (fixture looks OFF).
 */
function migrateLightValue(v: number): number {
  return Math.max(0, Math.min(100, Math.round(50 * Math.sqrt(Math.max(0, v)))));
}

function migrateLegacyPlacement(p: AppShotPlacement): AppShotPlacement {
  return {
    ...p,
    brightness: migrateLightValue(p.brightness),
    lightOutput: migrateLightValue(p.lightOutput),
  };
}

function loadPersisted(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Persisted;
      return { ...p, fixtures: (p.fixtures ?? []).map(backfillFixture) };
    }
    // Migrate a pre-multi-fixture snapshot: the single fixture becomes a
    // one-element layout.
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacy) return null;
    const v3 = JSON.parse(legacy) as PersistedV3;
    const fixtures: PlacedFixture[] =
      v3.sku && v3.placement
        ? [
            backfillFixture({
              id: crypto.randomUUID(),
              sku: v3.sku,
              // v3 light values are on the old linear scale — convert.
              placement: migrateLegacyPlacement(v3.placement),
              cutout: v3.cutout ?? null,
              glb: v3.glb ?? null,
            }),
          ]
        : [];
    return {
      v: 4,
      sceneUrl: v3.sceneUrl,
      fixtures,
      selectedId: fixtures[0]?.id ?? null,
      viewerMode: v3.viewerMode,
      previewUrl: v3.previewUrl,
      finalAssetId: v3.finalAssetId,
      renderQuality: v3.renderQuality ?? "standard",
    };
  } catch {
    return null;
  }
}

export function AppShot() {
  const saved = useRef<Persisted | null>(loadPersisted());

  // "Edit" restore: /app-shot?restore=<jobId> rehydrates the editor with the
  // fixture/scene/placement that produced a finished render. The job params
  // are written into the same localStorage snapshot the page already loads
  // from, then the page reloads once without the query param so every lazy
  // loader (GLB, cutout) runs its normal hydration path.
  useEffect(() => {
    const jobId = new URLSearchParams(window.location.search).get("restore");
    if (!jobId) return;
    void api<{ params?: { mode?: string; shot?: Record<string, unknown> } }>(
      `/api/jobs/${jobId}`,
    ).then((job) => {
      const shot = job.params?.shot as
        | {
            sku?: string;
            sceneUrl?: string;
            placement?: AppShotPlacement;
            fixtures?: Array<{
              id?: string;
              sku: string;
              placement: AppShotPlacement;
            }>;
            renderQuality?: RenderQuality;
          }
        | undefined;
      if (!shot?.sceneUrl) return;
      // New jobs carry fixtures[]; old single-fixture jobs carry sku+placement
      // with light values on the OLD linear scale — convert those.
      const list = shot.fixtures?.length
        ? shot.fixtures
        : shot.sku
          ? [
              {
                sku: shot.sku,
                // DEFAULT_PLACEMENT is already on the new scale — only convert
                // a placement the old job actually carried.
                placement: shot.placement
                  ? migrateLegacyPlacement(shot.placement)
                  : DEFAULT_PLACEMENT,
              },
            ]
          : [];
      if (!list.length) return;
      const fixtures: PlacedFixture[] = list.map((f) =>
        backfillFixture({
          id: f.id ?? crypto.randomUUID(),
          sku: f.sku,
          placement: f.placement,
          cutout: null,
          glb: null,
        }),
      );
      const persisted: Persisted = {
        v: 4,
        sceneUrl: shot.sceneUrl,
        fixtures,
        selectedId: fixtures[0]?.id ?? null,
        viewerMode: "viewer",
        previewUrl: null,
        finalAssetId: null,
        renderQuality: shot.renderQuality ?? "standard",
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
      window.location.replace("/app-shot");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [fixtures, setFixtures] = useState<ShotFixture[]>([]);
  const [fixturesErr, setFixturesErr] = useState<string | null>(null);
  const [fixtureQuery, setFixtureQuery] = useState("");
  const [fixtureBrand, setFixtureBrand] = useState("");
  const [fixtureBrands, setFixtureBrands] = useState<string[]>([]);
  const [fixturesTotal, setFixturesTotal] = useState(0);
  // The PICKER selection (setup phase + "Add fixture"); placed fixtures carry
  // their own sku.
  const [sku, setSku] = useState<string | null>(
    saved.current?.fixtures[0]?.sku ?? null,
  );

  const [sceneUrl, setSceneUrl] = useState<string | null>(
    saved.current?.sceneUrl ?? null,
  );
  const [sceneSource, setSceneSource] = useState<"upload" | "generate">("generate");
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<GeminiAspectRatio>("16:9");
  const [imageSize, setImageSize] = useState<GeminiImageSize>("2K");
  const [sceneBusy, setSceneBusy] = useState(false);

  // The layout: placed fixtures (list order = back-to-front) + selection.
  const [placed, setPlaced] = useState<PlacedFixture[]>(
    saved.current?.fixtures ?? [],
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    saved.current?.selectedId ?? null,
  );
  // "Add fixture" picker overlay (edit phase only) + its pending pick.
  const [addingFixture, setAddingFixture] = useState(false);
  const [addKey, setAddKey] = useState<string | null>(null);
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
  // coalesce rapid changes to the latest per fixture. Concurrent GPU renders are
  // what froze the machine, so this guard is load-bearing, not an optimization.
  const cutoutBusyRef = useRef(false);
  const pendingCutout = useRef(
    new Map<string, { sku: string; placement: AppShotPlacement }>(),
  );

  // The selected placed fixture (auto-selects the only/first one).
  const selected = placed.find((f) => f.id === selectedId) ?? placed[0] ?? null;
  const placement = selected?.placement ?? null;

  /** The catalog group a fixtureKey belongs to (name / mount / scene options). */
  const groupForKey = useCallback(
    (key: string | null | undefined) =>
      fixtures.find((f) => f.options.some((o) => o.fixtureKey === key)) ?? null,
    [fixtures],
  );

  // Projection view of the scene's room box (corner-drag room match), shared by
  // the matched 3D preview and the surface→screen syncing below.
  const roomSolved = useMemo(
    () =>
      placement?.roomGeometry ? solvedFromGeometry(placement.roomGeometry) : null,
    [placement?.roomGeometry],
  );

  /** Attach (or keep) a fixture's mount surface under `geometry`: the surface
   * kind comes from the catalog mount, and (u,v) is seeded by raycasting the
   * fixture's current screen spot onto that surface — so calibrating the room
   * doesn't visibly teleport an already-placed fixture. Also re-syncs the
   * legacy xPct/yPct to where the surface anchor projects. */
  const withSurface = useCallback(
    (f: PlacedFixture, geometry: RoomGeometry): PlacedFixture => {
      const solved = solvedFromGeometry(geometry);
      if (!solved) {
        return { ...f, placement: { ...f.placement, roomGeometry: geometry } };
      }
      let surface = f.placement.surface;
      if (!surface) {
        const kind = surfaceForMount(groupForKey(f.sku)?.mount);
        const hit = raycastSurface(
          solved,
          { x: f.placement.xPct, y: f.placement.yPct },
          kind,
        );
        surface = {
          kind,
          u: clamp(hit?.u ?? 0.5, 0, 1),
          v: clamp(hit?.v ?? 0.5, 0, 1),
          scale: 1,
          lightYawDeg: 0,
        };
      }
      const img = surfaceImagePoint(solved, surface);
      return {
        ...f,
        placement: {
          ...f.placement,
          roomGeometry: geometry,
          surface,
          ...(img ? { xPct: clamp(img.x, 0, 1), yPct: clamp(img.y, 0, 1) } : null),
        },
      };
    },
    [groupForKey],
  );
  // `sku` holds the PICKER's fixtureKey (a scene option); find its fixture group.
  const fixture = groupForKey(sku);
  const selectedGroup = groupForKey(selected?.sku);
  // Editing once the first fixture has EITHER canvas asset (GLB or cutout); the
  // mode-specific asset self-heals, with the canvas showing a spinner meanwhile.
  const editing = Boolean(
    sceneUrl && placed.length > 0 && (placed[0]!.glb || placed[0]!.cutout),
  );

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
      v: 4,
      sceneUrl,
      fixtures: placed,
      selectedId,
      viewerMode,
      previewUrl,
      finalAssetId,
      renderQuality,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // storage full / unavailable — non-fatal
    }
  }, [sceneUrl, placed, selectedId, viewerMode, previewUrl, finalAssetId, renderQuality]);

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
    setPlaced([]);
    setSelectedId(null);
    setAddingFixture(false);
    pendingCutout.current.clear();
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
  // Always records the latest requested placement PER FIXTURE; if a render is
  // already in flight, it just updates the pending target and returns, so we
  // never spawn a second concurrent Blender process. When the current render
  // finishes it drains the newest pending targets one at a time.
  const refreshCutout = useCallback(
    async (id: string, fixtureSku: string, place: AppShotPlacement) => {
      pendingCutout.current.set(id, { sku: fixtureSku, placement: place });
      if (cutoutBusyRef.current) return;
      cutoutBusyRef.current = true;
      setCutoutBusy(true);
      try {
        while (pendingCutout.current.size > 0) {
          const next = pendingCutout.current.entries().next().value;
          if (!next) break;
          const [targetId, target] = next;
          pendingCutout.current.delete(targetId);
          const { width, height } = await sceneRenderSize();
          const r = await cutoutShot({
            sku: target.sku,
            pose: target.placement.pose,
            coverageRef: target.placement.coverage,
            width,
            height,
          });
          setPlaced((list) =>
            list.map((f) =>
              f.id === targetId
                ? { ...f, cutout: { url: r.cutoutUrl, coverageRef: r.coverageRef } }
                : f,
            ),
          );
        }
      } catch (e) {
        setError(formatErr(e));
        pendingCutout.current.clear();
      } finally {
        cutoutBusyRef.current = false;
        setCutoutBusy(false);
      }
    },
    // sceneUrl is read inside sceneRenderSize; refresh when it changes
    [sceneUrl],
  );

  // Overlay mode: every placed fixture needs a cutout (missing right after an
  // add / restore / mode switch). The per-fixture pending map dedupes requests.
  useEffect(() => {
    if (viewerMode !== "overlay") return;
    for (const f of placed) {
      if (!f.cutout) void refreshCutout(f.id, f.sku, f.placement);
    }
  }, [viewerMode, placed, refreshCutout]);

  // --- GLB (one export per SKU; cached in R2 then reused) ---------------------
  // A persisted glb URL (from localStorage) can point at an R2 object that no
  // longer exists (e.g. cache cleared, bucket switched) — model-viewer then 404s
  // and shows nothing. So only trust a URL we've validated *this session*; for
  // anything else, re-ask the server (POST /glb HEADs R2 and is cheap on a hit,
  // re-exporting only when the object is genuinely gone).
  const glbVerified = useRef<Set<string>>(new Set());
  // Guards the self-heal effect against re-firing forever on a failing export.
  const glbTried = useRef<Set<string>>(new Set());
  const ensureGlb = useCallback(
    async (id: string, targetSku: string): Promise<string> => {
      setGlbBusy(true);
      try {
        const { url } = await glbShot({ sku: targetSku });
        glbVerified.current.add(targetSku);
        glbTried.current.delete(id);
        setPlaced((list) =>
          list.map((f) => (f.id === id ? { ...f, glb: { sku: targetSku, url } } : f)),
        );
        return url;
      } finally {
        setGlbBusy(false);
      }
    },
    [],
  );

  /** A fixture's GLB is trusted only when same-origin AND verified this session. */
  const glbValid = useCallback(
    (f: PlacedFixture) =>
      Boolean(f.glb && f.glb.url.startsWith("/") && glbVerified.current.has(f.sku)),
    [],
  );

  // Self-heal the viewer: whenever we're in 3D-viewer mode and any placed
  // fixture lacks a valid (fresh, same-origin) GLB, export/load it — one at a
  // time (glbBusy gates; each completion re-runs the effect for the next).
  useEffect(() => {
    if (viewerMode !== "viewer" || glbBusy) return;
    const missing = placed.find((f) => !glbValid(f) && !glbTried.current.has(f.id));
    if (!missing) return;
    glbTried.current.add(missing.id);
    void ensureGlb(missing.id, missing.sku).catch((e) => setError(formatErr(e)));
  }, [viewerMode, placed, glbBusy, ensureGlb, glbValid]);

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
      const id = crypto.randomUUID();
      setPlaced([{ id, sku, placement: next, cutout: null, glb: null }]);
      setSelectedId(id);
      if (viewerMode === "viewer") {
        await ensureGlb(id, sku);
      } else {
        await refreshCutout(id, sku, next);
      }
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setPlacing(false);
    }
  }

  // Switch placement method mid-edit; the self-heal effects load whatever the
  // new mode is missing (GLBs for the viewer, cutouts for the overlay).
  function switchViewerMode(mode: ViewerMode) {
    if (mode === viewerMode) return;
    setViewerMode(mode);
    setShowPreview(false);
    setError(null);
  }

  // --- layout edits: add / remove / select fixtures ---------------------------
  function addFixture(fixtureKey: string) {
    const group = groupForKey(fixtureKey);
    const id = crypto.randomUUID();
    setPlaced((list) => {
      // Room geometry is scene-level — a new fixture joins the existing room
      // match (and gets a mount surface) when one is active.
      const geometry = list[0]?.placement.roomGeometry;
      let fx: PlacedFixture = {
        id,
        sku: fixtureKey,
        placement: defaultPlacementFor(group?.mount),
        cutout: null,
        glb: null,
      };
      if (geometry) fx = withSurface(fx, geometry);
      return [...list, fx];
    });
    setSelectedId(id);
    setAddingFixture(false);
    setShowPreview(false);
    // The GLB / cutout self-heal effects fetch the new fixture's assets.
  }

  function removeFixture(id: string) {
    setPlaced((list) => {
      const next = list.filter((f) => f.id !== id);
      if (selectedId === id) setSelectedId(next[next.length - 1]?.id ?? null);
      return next;
    });
    pendingCutout.current.delete(id);
    setShowPreview(false);
  }

  // Re-run the AI placement for the SELECTED fixture only.
  async function rePlaceSelected() {
    if (!selected || !sceneUrl) return;
    const { id, sku: fixtureSku } = selected;
    setError(null);
    setPlacing(true);
    setShowPreview(false);
    try {
      const r = await placeShot({ sku: fixtureSku, sceneUrl });
      const next = { ...selected.placement, ...r.placement };
      setPlaced((list) =>
        list.map((f) => (f.id === id ? { ...f, placement: next } : f)),
      );
      if (viewerMode === "overlay") {
        await refreshCutout(id, fixtureSku, next);
      }
    } catch (e) {
      setError(formatErr(e));
    } finally {
      setPlacing(false);
    }
  }

  // --- placement edits (instant; pose re-renders the cutout, debounced) ------
  // Both patch the SELECTED fixture.
  function patchPlacement(patch: Partial<AppShotPlacement>) {
    if (!selected) return;
    const id = selected.id;
    setPlaced((list) =>
      list.map((f) => {
        if (f.id !== id) return f;
        let next = { ...f.placement, ...patch };
        // A surface move re-anchors the legacy screen position so the cutout
        // overlay, the move badge, and no-box render fallbacks stay aligned.
        if (patch.surface && next.roomGeometry) {
          const solved = solvedFromGeometry(next.roomGeometry);
          const img = solved && surfaceImagePoint(solved, patch.surface);
          if (img) {
            next = { ...next, xPct: clamp(img.x, 0, 1), yPct: clamp(img.y, 0, 1) };
          }
        }
        return { ...f, placement: next };
      }),
    );
    setShowPreview(false);
  }

  function patchPose(patch: Partial<AppShotPlacement["pose"]>, rerender = true) {
    if (!selected) return;
    const { id, sku: fixtureSku } = selected;
    setPlaced((list) =>
      list.map((f) => {
        if (f.id !== id) return f;
        const next = { ...f.placement, pose: { ...f.placement.pose, ...patch } };
        // Only the overlay (fallback) path re-renders a Blender cutout per angle.
        // The viewer path updates the live WebGL model from the pose prop — no
        // server round-trip — so angle changes are instant there.
        if (rerender && viewerMode === "overlay") {
          if (poseTimer.current) window.clearTimeout(poseTimer.current);
          poseTimer.current = window.setTimeout(
            () => void refreshCutout(id, fixtureSku, next),
            400,
          );
        }
        return { ...f, placement: next };
      }),
    );
    setShowPreview(false);
  }

  /** Wire payload: legacy scalar shape for one fixture (older backends keep
   * working during a rollout), the fixtures array past one. */
  function shotPayload() {
    if (placed.length === 1) {
      const f = placed[0]!;
      return { sku: f.sku, placement: f.placement };
    }
    return {
      fixtures: placed.map((f) => ({
        id: f.id,
        sku: f.sku,
        placement: f.placement,
      })),
    };
  }

  // --- test render (in-Blender, true light/shadow/glass) ---------------------
  async function runTestRender() {
    if (!sceneUrl || placed.length === 0) return;
    setError(null);
    setPreviewBusy(true);
    try {
      const r = await previewShot({ ...shotPayload(), sceneUrl, renderQuality });
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
    if (!sceneUrl || placed.length === 0) return;
    setError(null);
    setQueued(false);
    setQueuedJobId(null);
    setFinalAssetId(null);
    setFinalStatus(null);
    setFinalizing(true);
    try {
      const skus = [...new Set(placed.map((f) => f.sku))];
      const { jobId } = await finalizeShot({
        ...shotPayload(),
        sceneUrl,
        name: `${skus.join(" + ")} app shot`,
        renderQuality,
        editor: "appshot",
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
      a.download = `${placed[0]?.sku ?? "app-shot"}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(formatErr(e));
    }
  }

  function startOver() {
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
        <>
        {addingFixture && (
          <div className="card col" style={{ gap: 12 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>Add fixture</h3>
              <button className="secondary" onClick={() => setAddingFixture(false)}>
                Cancel
              </button>
            </div>
            <FixturePickerCard
              fixtures={fixtures}
              fixturesErr={fixturesErr}
              fixtureQuery={fixtureQuery}
              setFixtureQuery={setFixtureQuery}
              fixtureBrand={fixtureBrand}
              setFixtureBrand={setFixtureBrand}
              fixtureBrands={fixtureBrands}
              fixturesTotal={fixturesTotal}
              selectedKey={addKey}
              onSelectKey={setAddKey}
              group={groupForKey(addKey)}
            />
            <button disabled={!addKey} onClick={() => addKey && addFixture(addKey)}>
              Add to layout
            </button>
          </div>
        )}
        <EditPanel
          sceneUrl={sceneUrl!}
          placement={placement!}
          viewerMode={viewerMode}
          onSwitchMode={switchViewerMode}
          glbUrl={selected?.glb?.url ?? null}
          glbBusy={glbBusy}
          cutout={selected?.cutout ?? null}
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
          mountLabel={selectedGroup ? MOUNT_LABELS[selectedGroup.mount] : ""}
          roomBox={roomSolved}
          onPatch={patchPlacement}
          onPatchPose={patchPose}
          onRePlaceAi={() => void rePlaceSelected()}
          onTestRender={runTestRender}
          onFinalize={runFinalize}
          onDownload={download}
          fixtures={placed.map((f) => {
            const g = groupForKey(f.sku);
            return {
              id: f.id,
              sku: f.sku,
              label: g?.name ?? g?.sku ?? f.sku,
              placement: f.placement,
              cutout: f.cutout,
              glbUrl: f.glb?.url ?? null,
            };
          })}
          selectedId={selected?.id ?? null}
          onSelectFixture={(id) => {
            setSelectedId(id);
            setShowPreview(false);
          }}
          onRemoveFixture={removeFixture}
          onAddFixture={() => {
            setAddKey(null);
            setAddingFixture(true);
          }}
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
        <details className="card" style={{ marginTop: 12 }} open={!placement!.roomGeometry && placed.length > 1}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>
            Room match: draw the room{placement!.roomGeometry ? " ✓" : ""}
            {!placement!.roomGeometry && placed.length > 1 && (
              <span className="muted" style={{ fontWeight: 400 }}>
                {" "}
                — recommended for multi-fixture shots (realistic combined lighting)
              </span>
            )}
          </summary>
          <div className="muted" style={{ fontSize: 12, margin: "8px 0" }}>
            Fit the box to the room so the render matches the photo's camera, hangs
            fixtures at true size on real walls/ceiling, and casts their combined
            light &amp; shadow onto the actual surfaces. Leave off to use the
            classic backdrop.
          </div>
          <RoomBoxCalibrator
            sceneUrl={sceneUrl!}
            value={placement!.roomGeometry}
            onChange={(geometry) => {
              // Room geometry is scene-level: every fixture carries the same one
              // (and gains/loses its mount-surface attachment with it).
              setPlaced((list) =>
                list.map((f) =>
                  geometry
                    ? withSurface(f, geometry)
                    : {
                        ...f,
                        placement: {
                          ...f.placement,
                          roomGeometry: undefined,
                          surface: undefined,
                        },
                      },
                ),
              );
              setShowPreview(false);
            }}
          />
        </details>
        </>
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
      <FixturePickerCard
        header={
          <div>
            <h3 style={{ margin: 0 }}>1 · Fixture</h3>
            <div className="muted">Search the fixture library by name, brand, or SKU.</div>
          </div>
        }
        fixtures={p.fixtures}
        fixturesErr={p.fixturesErr}
        fixtureQuery={p.fixtureQuery}
        setFixtureQuery={p.setFixtureQuery}
        fixtureBrand={p.fixtureBrand}
        setFixtureBrand={p.setFixtureBrand}
        fixtureBrands={p.fixtureBrands}
        fixturesTotal={p.fixturesTotal}
        selectedKey={p.sku}
        onSelectKey={p.setSku}
        group={p.fixture}
      />

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

/* ----------------------------------------------------------------- picker -- */

interface FixturePickerProps {
  /** Optional heading block (the setup panel's "1 · Fixture" header). */
  header?: React.ReactNode;
  fixtures: ShotFixture[];
  fixturesErr: string | null;
  fixtureQuery: string;
  setFixtureQuery: (s: string) => void;
  fixtureBrand: string;
  setFixtureBrand: (s: string) => void;
  fixtureBrands: string[];
  fixturesTotal: number;
  selectedKey: string | null;
  onSelectKey: (fixtureKey: string) => void;
  /** Catalog group of `selectedKey` (scene options + mount line). */
  group: ShotFixture | null;
}

/** Searchable fixture grid — used by the setup panel and the edit-phase
 * "Add fixture" flow (both bind it to the same catalog browse state). */
function FixturePickerCard(p: FixturePickerProps) {
  return (
    <div className="card col" style={{ gap: 12 }}>
      {p.header}
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
            const selected = f.options.some((o) => o.fixtureKey === p.selectedKey);
            return (
              <button
                key={f.sku}
                type="button"
                className={"product-card" + (selected ? " selected" : "")}
                onClick={() => p.onSelectKey(f.options[0]!.fixtureKey)}
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
      {p.group && p.group.options.length > 1 && (
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
            {p.group.options.map((o) => (
              <button
                key={o.fixtureKey}
                type="button"
                className={"product-card" + (p.selectedKey === o.fixtureKey ? " selected" : "")}
                onClick={() => p.onSelectKey(o.fixtureKey)}
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
      {p.group && (
        <div className="muted" style={{ fontSize: 12 }}>
          Mount: {MOUNT_LABELS[p.group.mount]}
          {p.group.dimensions
            ? ` · ${formatDimensions(p.group.dimensions)}`
            : ""}
        </div>
      )}
    </div>
  );
}
