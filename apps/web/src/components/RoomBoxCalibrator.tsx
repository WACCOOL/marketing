import { useMemo, useRef, useState } from "react";
import {
  DEFAULT_ASSUMED_FOV_DEG,
  DEFAULT_CEILING_M,
  defaultRoomBoxCorners,
  projectBoxCorners,
  solveRoomBox,
  type Pt,
  type RoomBoxCornerId,
  type RoomBoxCorners,
  type RoomGeometry,
} from "@wac/shared";

/**
 * Room match by "fixing the corners of a cube": a wireframe room box is drawn
 * over the photo and the user drags its six handles (back-wall quad + the two
 * front floor corners) until the box hugs the room. Solving the corners
 * recovers the photo's camera AND the room's metric box (anchored by the
 * ceiling-height input), so the render can light real walls at real distances
 * and fixtures can hang true-to-scale. Replaces the line-tracing RoomCalibrator.
 */

interface Props {
  sceneUrl: string;
  value?: RoomGeometry;
  onChange: (geometry: RoomGeometry | undefined) => void;
}

const HANDLES: { id: RoomBoxCornerId; label: string }[] = [
  { id: "backTopLeft", label: "back wall — top left" },
  { id: "backTopRight", label: "back wall — top right" },
  { id: "backBottomLeft", label: "back wall — bottom left" },
  { id: "backBottomRight", label: "back wall — bottom right" },
  { id: "frontBottomLeft", label: "floor — front left" },
  { id: "frontBottomRight", label: "floor — front right" },
];

/** Box edges drawn from the DRAGGED corners (solid, axis-coloured). */
const DRAGGED_EDGES: [RoomBoxCornerId, RoomBoxCornerId, string][] = [
  ["backTopLeft", "backTopRight", "#ff5d73"], // back wall horizontals (X)
  ["backBottomLeft", "backBottomRight", "#ff5d73"],
  ["backTopLeft", "backBottomLeft", "#ffc83d"], // back wall verticals (Z)
  ["backTopRight", "backBottomRight", "#ffc83d"],
  ["backBottomLeft", "frontBottomLeft", "#3cc6ff"], // floor seams (Y/depth)
  ["backBottomRight", "frontBottomRight", "#3cc6ff"],
];

const M_PER_FT = 0.3048;

export function RoomBoxCalibrator(p: Props) {
  const [corners, setCorners] = useState<RoomBoxCorners>(
    () => p.value?.box?.corners ?? defaultRoomBoxCorners(),
  );
  const [ceilingFt, setCeilingFt] = useState<number>(() => {
    const m = p.value?.box?.ceilingHeightM ?? DEFAULT_CEILING_M;
    return Math.round((m / M_PER_FT) * 4) / 4;
  });
  const [fovDeg, setFovDeg] = useState<number>(
    () => p.value?.box?.assumedFovDeg ?? DEFAULT_ASSUMED_FOV_DEG,
  );
  const [aspect, setAspect] = useState<number>(p.value?.imageAspect ?? 16 / 9);
  const drag = useRef<RoomBoxCornerId | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const solved = useMemo(
    () =>
      solveRoomBox({
        corners,
        imageAspect: aspect,
        ceilingHeightM: ceilingFt * M_PER_FT,
        assumedFovDeg: fovDeg,
      }),
    [corners, aspect, ceilingFt, fovDeg],
  );

  // The derived (not draggable) front-top corners that complete the cube.
  const derived = useMemo(() => {
    if (!solved.ok) return null;
    const proj = projectBoxCorners(solved);
    return proj.frontTopLeft && proj.frontTopRight
      ? { frontTopLeft: proj.frontTopLeft, frontTopRight: proj.frontTopRight }
      : null;
  }, [solved]);

  /** Push the current state up — only ever a SOLVED box (or an explicit clear),
   * so a mid-drag invalid box never wipes a previously good room match. */
  function commit(
    next: RoomBoxCorners,
    nextCeilingFt = ceilingFt,
    nextFovDeg = fovDeg,
  ) {
    const s = solveRoomBox({
      corners: next,
      imageAspect: aspect,
      ceilingHeightM: nextCeilingFt * M_PER_FT,
      assumedFovDeg: nextFovDeg,
    });
    if (!s.ok) return;
    p.onChange({
      imageAspect: aspect,
      box: {
        corners: next,
        ceilingHeightM: nextCeilingFt * M_PER_FT,
        assumedFovDeg: s.mode === "one-point" ? nextFovDeg : undefined,
        solved: {
          mode: s.mode,
          fovDeg: s.fovDeg,
          cameraHeightM: s.cameraHeightM,
          box: s.box,
        },
      },
      camera: {
        fovDeg: s.fovDeg,
        right: s.cameraBasis.right,
        up: s.cameraBasis.up,
        forward: s.cameraBasis.forward,
        worldUp: s.worldUp,
      },
    });
  }

  function pointerToNorm(e: React.PointerEvent): Pt | null {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    // Handles may drag past the frame (front floor corners usually live below
    // it) — clamp to the schema's -0.5..1.5 instead of the visible 0..1.
    return {
      x: Math.min(1.5, Math.max(-0.5, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1.5, Math.max(-0.5, (e.clientY - rect.top) / rect.height)),
    };
  }

  function onPointerDown(id: RoomBoxCornerId) {
    return (e: React.PointerEvent) => {
      e.stopPropagation();
      drag.current = id;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    };
  }
  function onPointerMove(e: React.PointerEvent) {
    const id = drag.current;
    if (!id) return;
    const pt = pointerToNorm(e);
    if (pt) setCorners((c) => ({ ...c, [id]: pt }));
  }
  function onPointerUp() {
    if (!drag.current) return;
    drag.current = null;
    commit(corners);
  }

  function reset() {
    const next = defaultRoomBoxCorners();
    setCorners(next);
    commit(next);
  }

  const line = (a: Pt, b: Pt, stroke: string, dashed = false, key?: string) => (
    <line
      key={key}
      x1={a.x * 100}
      y1={a.y * 100}
      x2={b.x * 100}
      y2={b.y * 100}
      stroke={stroke}
      strokeWidth={dashed ? 0.45 : 0.6}
      strokeDasharray={dashed ? "1.6 1.6" : undefined}
      opacity={dashed ? 0.7 : 0.95}
      vectorEffect="non-scaling-stroke"
    />
  );

  const cameraFt = solved.ok ? solved.cameraHeightM / M_PER_FT : 0;

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="muted" style={{ fontSize: 12 }}>
        Drag the six dots so the box hugs the room: the red/yellow quad onto the
        <strong> back wall</strong> (its corners on the real wall corners) and the
        two blue dots along the <strong>floor edges</strong> toward you. Corners
        can go past the photo's edges.
      </div>

      <div
        ref={boxRef}
        style={{
          position: "relative",
          width: "100%",
          userSelect: "none",
          touchAction: "none",
          // Breathing room so off-frame handles stay reachable.
          padding: 0,
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          src={p.sceneUrl}
          alt="room"
          style={{ display: "block", width: "100%", borderRadius: "var(--radius)" }}
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth && img.naturalHeight) {
              setAspect(img.naturalWidth / img.naturalHeight);
            }
          }}
        />
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            overflow: "visible",
          }}
        >
          {DRAGGED_EDGES.map(([a, b, color], i) =>
            line(corners[a], corners[b], color, false, `e${i}`),
          )}
          {derived && (
            <>
              {line(corners.frontBottomLeft, derived.frontTopLeft, "#ffc83d", true, "d0")}
              {line(corners.frontBottomRight, derived.frontTopRight, "#ffc83d", true, "d1")}
              {line(corners.backTopLeft, derived.frontTopLeft, "#3cc6ff", true, "d2")}
              {line(corners.backTopRight, derived.frontTopRight, "#3cc6ff", true, "d3")}
              {line(derived.frontTopLeft, derived.frontTopRight, "#ff5d73", true, "d4")}
            </>
          )}
          {HANDLES.map((h) => (
            <circle
              key={h.id}
              cx={corners[h.id].x * 100}
              cy={corners[h.id].y * 100}
              r={1.4}
              fill={solved.ok ? "var(--accent)" : "#ff5d73"}
              stroke="#fff"
              strokeWidth={0.35}
              style={{ cursor: "grab" }}
              vectorEffect="non-scaling-stroke"
              onPointerDown={onPointerDown(h.id)}
            >
              <title>{h.label}</title>
            </circle>
          ))}
        </svg>
      </div>

      <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label className="row" style={{ gap: 6, alignItems: "center", margin: 0, fontSize: 13 }}>
          Ceiling height
          <input
            type="number"
            min={6}
            max={20}
            step={0.25}
            value={ceilingFt}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) {
                setCeilingFt(v);
                commit(corners, v, fovDeg);
              }
            }}
            style={{ width: 70 }}
          />
          ft
        </label>
        {solved.ok && solved.mode === "one-point" && (
          <label className="row" style={{ gap: 6, alignItems: "center", margin: 0, fontSize: 13 }}>
            Camera lens
            <input
              type="range"
              min={25}
              max={100}
              step={1}
              value={fovDeg}
              onChange={(e) => {
                const v = Number(e.target.value);
                setFovDeg(v);
                commit(corners, ceilingFt, v);
              }}
            />
            <span className="muted">{fovDeg}°</span>
          </label>
        )}
        <button className="secondary slim" onClick={reset}>
          Reset box
        </button>
        {p.value && (
          <button className="secondary slim" onClick={() => p.onChange(undefined)}>
            Remove room match
          </button>
        )}
      </div>

      <div style={{ fontSize: 13 }}>
        {solved.ok ? (
          <span style={{ color: "var(--accent)" }}>
            ✓ Room matched — lens ≈ {Math.round(solved.fovDeg)}°, camera{" "}
            {cameraFt.toFixed(1)} ft above the floor, room ≈{" "}
            {((solved.box.xMax - solved.box.xMin) / M_PER_FT).toFixed(0)} ft wide.
            {solved.mode === "one-point" &&
              " Straight-on photo: set the lens slider if the depth looks off."}
            {solved.warnings.length > 0 && (
              <span className="muted"> {solved.warnings.join("; ")}.</span>
            )}
          </span>
        ) : (
          <span className="muted">{solved.reason ?? "Adjust the corners to match the room."}</span>
        )}
      </div>
    </div>
  );
}
