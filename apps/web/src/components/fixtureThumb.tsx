import { useEffect, useRef, useState } from "react";
import { POSE_DEFAULTS, type FixtureMount } from "@wac/shared";
import { fixtureThumbUrl, glbShot } from "../lib/appshot.js";
import { FixtureScene } from "../lib/fixtureScene.js";

/**
 * Picker thumbnail with the agreed fallback chain so you always see what you're
 * about to pick:
 *
 *   1. Sales Layer image  (fixture-level; instant, but identical across scenes)
 *   2. Cached render      (the clean transparent cutout from the last render of
 *                          THIS fixture_key — distinguishes scenes once rendered)
 *   3. 3D form preview    (the GLB rendered one frame via FixtureScene — the
 *                          "non-.blend preview"; shows the form for any scene)
 *   4. Placeholder glyph  (nothing available / 3D failed)
 *
 * Still-image sources are tried first (cheap); the 3D fallback spins up a WebGL
 * context, so only enable it where a few tiles are shown at once (scene picker),
 * not the long fixture list.
 */
export interface FixtureThumbProps {
  fixtureKey: string;
  mount: FixtureMount;
  /** Sales Layer image (highest priority when present). */
  imageUrl?: string | null;
  /** Allow the costlier 3D GLB fallback (use for the selected fixture's scenes). */
  allow3d?: boolean;
  /** Fixed square px size. Omit to fill the parent (e.g. a product-card thumb). */
  size?: number;
}

/** Buffer resolution for the WebGL 3D thumbnail when filling a flexible card. */
const FILL_BUFFER_PX = 200;

/** The image/canvas/placeholder fills the square frame, regardless of size mode. */
const contentStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "contain",
  display: "block",
};

/** Fixed thumbnail height for fill mode (the card stretches the width). */
const FILL_FRAME_PX = 150;

/**
 * A fixed-size white box; children layer absolutely on top.
 *
 * The height is an explicit pixel value rather than `aspect-ratio`, percentage
 * `padding-bottom`, or an intrinsic-ratio spacer. Safari collapsed every one of
 * those to zero height for tiles inside the list's scroll container (flex/grid
 * child sizing bugs), squashing the cards into pills. An explicit height is
 * immune to layout context, so it renders identically everywhere.
 */
function ThumbFrame({
  size,
  children,
}: {
  size?: number;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: "relative",
        width: size ?? "100%",
        height: size ?? FILL_FRAME_PX,
        flex: "0 0 auto",
        borderRadius: size ? 6 : 0,
        overflow: "hidden",
        background: "#fff",
      }}
    >
      {children}
    </div>
  );
}

export function FixtureThumb({
  fixtureKey,
  mount,
  imageUrl,
  allow3d = false,
  size,
}: FixtureThumbProps) {
  // Candidate still-image sources in priority order. onError advances the index;
  // exhausting them drops to the 3D form (when allowed) or a placeholder.
  const candidates = [imageUrl, fixtureThumbUrl(fixtureKey)].filter(
    Boolean,
  ) as string[];
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState<"image" | "3d" | "placeholder">(
    candidates.length ? "image" : allow3d ? "3d" : "placeholder",
  );

  useEffect(() => {
    setIdx(0);
    setMode(candidates.length ? "image" : allow3d ? "3d" : "placeholder");
    // Reset the chain whenever the fixture/source changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixtureKey, imageUrl, allow3d]);

  if (mode === "3d") {
    return (
      <Glb3dThumb
        fixtureKey={fixtureKey}
        mount={mount}
        size={size}
        onFail={() => setMode("placeholder")}
      />
    );
  }

  return (
    <ThumbFrame size={size}>
      {mode === "image" && candidates[idx] ? (
        <img
          src={candidates[idx]}
          alt=""
          loading="lazy"
          style={contentStyle}
          onError={() => {
            if (idx + 1 < candidates.length) setIdx(idx + 1);
            else setMode(allow3d ? "3d" : "placeholder");
          }}
        />
      ) : (
        <PlaceholderGlyph size={size} />
      )}
    </ThumbFrame>
  );
}

// Bound concurrent GLB exports so scrolling the picker doesn't fire a burst of
// render-worker calls. Each acquirer gets a release() to call when its load is
// done (or failed).
let active = 0;
const waiting: Array<() => void> = [];
const MAX_CONCURRENT_GLB = 3;
function acquireGlbSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active--;
        waiting.shift()?.();
      });
    };
    if (active < MAX_CONCURRENT_GLB) grant();
    else waiting.push(grant);
  });
}

/**
 * Render the fixture GLB to a single still frame at a flattering 3/4 pose. The
 * export + WebGL context only kick off once the tile scrolls into view, and a
 * global limiter caps simultaneous exports so browsing stays cheap.
 */
function Glb3dThumb(p: {
  fixtureKey: string;
  mount: FixtureMount;
  size?: number;
  onFail: () => void;
}) {
  const buffer = p.size ?? FILL_BUFFER_PX;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const failRef = useRef(p.onFail);
  failRef.current = p.onFail;
  const [visible, setVisible] = useState(false);

  // Defer all work until the tile is actually on screen.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "100px" },
    );
    io.observe(canvas);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let scene: FixtureScene | null = null;
    let cancelled = false;
    let release: (() => void) | null = null;
    (async () => {
      try {
        release = await acquireGlbSlot();
        if (cancelled) return;
        const { url } = await glbShot({ sku: p.fixtureKey });
        if (cancelled || !canvasRef.current) return;
        scene = new FixtureScene(canvasRef.current);
        scene.setSize(buffer, buffer);
        const dims = await scene.loadModel(url);
        if (cancelled || !dims) return;
        const pose = POSE_DEFAULTS[p.mount];
        scene.update({
          pose: {
            azimuthDeg: pose.azimuthDeg,
            elevationDeg: pose.elevationDeg,
            fovDeg: pose.fovDeg,
            distanceFactor: 1,
          },
          coverage: 0.82,
          xPct: 0.5,
          yPct: 0.5,
          aspect: 1,
        });
      } catch {
        if (!cancelled) failRef.current();
      } finally {
        release?.();
      }
    })();
    return () => {
      cancelled = true;
      release?.();
      scene?.dispose();
    };
  }, [visible, p.fixtureKey, p.mount, buffer]);

  return (
    <ThumbFrame size={p.size}>
      <canvas ref={canvasRef} width={buffer} height={buffer} style={contentStyle} />
    </ThumbFrame>
  );
}

function PlaceholderGlyph({ size }: { size?: number }) {
  const glyph = size ? Math.round(size * 0.5) : 40;
  return (
    <div
      style={{
        ...contentStyle,
        background: "#eef1f5",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#9aa4b2",
      }}
      aria-hidden
    >
      <svg
        width={glyph}
        height={glyph}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 18h6" />
        <path d="M10 22h4" />
        <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z" />
      </svg>
    </div>
  );
}
