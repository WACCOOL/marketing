import { useMemo, useRef, useState } from "react";
import {
  type AxisLines,
  type RoomAxis,
  type RoomGeometry,
  type Seg,
  solveRoomCalibration,
} from "@wac/shared";

/**
 * Cam Solve room-match. The user traces a few of the room's edges along its
 * orthogonal axes; extending each axis's edges to a vanishing point recovers the
 * photo's true camera + the ceiling/wall/floor planes, so the Blender render can
 * match the photo's perspective and light the real surfaces (instead of a
 * camera-facing billboard). We solve on the client (instant feedback) and hand
 * the parent the full RoomGeometry to attach to the placement.
 */

interface Props {
  sceneUrl: string;
  value?: RoomGeometry;
  onChange: (geometry: RoomGeometry | undefined) => void;
}

type AxisMap = Record<RoomAxis, Seg[]>;

const AXES: { axis: RoomAxis; label: string; hint: string; color: string }[] = [
  {
    axis: "horizontalA",
    label: "Floor / ceiling — left↔right",
    hint: "Trace edges running side to side (e.g. the wall–ceiling line).",
    color: "#ff5d73",
  },
  {
    axis: "horizontalB",
    label: "Floor / ceiling — into depth",
    hint: "Trace edges receding away from you (e.g. floor–wall, side walls).",
    color: "#3cc6ff",
  },
  {
    axis: "vertical",
    label: "Verticals",
    hint: "Trace upright edges (wall corners, door jambs). Optional.",
    color: "#ffc83d",
  },
];

function emptyAxes(value?: RoomGeometry): AxisMap {
  const map: AxisMap = { horizontalA: [], horizontalB: [], vertical: [] };
  for (const group of value?.axes ?? []) map[group.axis] = group.lines.slice();
  return map;
}

/** Map the per-axis segments to the solver's AxisLines[] (non-empty groups). */
function toAxisLines(map: AxisMap): AxisLines[] {
  return (Object.keys(map) as RoomAxis[])
    .filter((ax) => map[ax].length > 0)
    .map((ax) => ({ axis: ax, lines: map[ax] }));
}

export function RoomCalibrator(p: Props) {
  const [axes, setAxes] = useState<AxisMap>(() => emptyAxes(p.value));
  const [active, setActive] = useState<RoomAxis>("horizontalA");
  const [aspect, setAspect] = useState<number>(p.value?.imageAspect ?? 16 / 9);
  const [drag, setDrag] = useState<Seg | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Re-solve whenever the lines change; push the result (or clear) to the parent.
  const solution = useMemo(() => {
    const lines = toAxisLines(axes);
    const finiteAxes = lines.length;
    if (finiteAxes < 2) return { ok: false as const, reason: "Draw at least two axes (≥2 lines each).", lines };
    const calib = solveRoomCalibration(lines, aspect);
    return { ...calib, lines };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axes, aspect]);

  // Emit upward as a side-effect of render is discouraged; do it on commit below.
  function commit(next: AxisMap) {
    setAxes(next);
    const lines = toAxisLines(next);
    if (lines.length >= 2) {
      const calib = solveRoomCalibration(lines, aspect);
      if (calib.ok) {
        p.onChange({
          imageAspect: aspect,
          axes: lines,
          camera: {
            fovDeg: calib.fovDeg,
            right: calib.cameraBasis.right,
            up: calib.cameraBasis.up,
            forward: calib.cameraBasis.forward,
            worldUp: calib.worldUp,
          },
        });
        return;
      }
    }
    p.onChange(undefined); // not enough / not solvable yet → no room-match
  }

  function pointerToNorm(e: React.PointerEvent): { x: number; y: number } | null {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }

  function onPointerDown(e: React.PointerEvent) {
    const pt = pointerToNorm(e);
    if (!pt) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ a: pt, b: pt });
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const pt = pointerToNorm(e);
    if (pt) setDrag({ a: drag.a, b: pt });
  }
  function onPointerUp() {
    if (!drag) return;
    const d = Math.hypot(drag.b.x - drag.a.x, drag.b.y - drag.a.y);
    if (d > 0.02) commit({ ...axes, [active]: [...axes[active], drag] });
    setDrag(null);
  }

  function clearAxis(ax: RoomAxis) {
    commit({ ...axes, [ax]: [] });
  }
  function clearAll() {
    commit({ horizontalA: [], horizontalB: [], vertical: [] });
  }
  function undoActive() {
    commit({ ...axes, [active]: axes[active].slice(0, -1) });
  }

  const colorFor = (ax: RoomAxis) => AXES.find((a) => a.axis === ax)!.color;
  const total = axes.horizontalA.length + axes.horizontalB.length + axes.vertical.length;

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {AXES.map((a) => (
          <button
            key={a.axis}
            type="button"
            className={"tag" + (active === a.axis ? " tag-selected" : "")}
            onClick={() => setActive(a.axis)}
            title={a.hint}
            style={{ borderLeft: `3px solid ${a.color}` }}
          >
            {a.label} ({axes[a.axis].length})
          </button>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {AXES.find((a) => a.axis === active)!.hint} Click-drag to draw an edge.
      </div>

      <div
        ref={boxRef}
        style={{ position: "relative", width: "100%", userSelect: "none", touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
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
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "crosshair" }}
        >
          {(Object.keys(axes) as RoomAxis[]).flatMap((ax) =>
            axes[ax].map((seg, i) => (
              <line
                key={`${ax}-${i}`}
                x1={seg.a.x * 100}
                y1={seg.a.y * 100}
                x2={seg.b.x * 100}
                y2={seg.b.y * 100}
                stroke={colorFor(ax)}
                strokeWidth={ax === active ? 0.8 : 0.5}
                opacity={ax === active ? 1 : 0.65}
                vectorEffect="non-scaling-stroke"
              />
            )),
          )}
          {drag && (
            <line
              x1={drag.a.x * 100}
              y1={drag.a.y * 100}
              x2={drag.b.x * 100}
              y2={drag.b.y * 100}
              stroke={colorFor(active)}
              strokeWidth={1}
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>

      <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <button className="secondary slim" onClick={undoActive} disabled={axes[active].length === 0}>
          Undo last
        </button>
        <button className="secondary slim" onClick={() => clearAxis(active)} disabled={axes[active].length === 0}>
          Clear this axis
        </button>
        <button className="secondary slim" onClick={clearAll} disabled={total === 0}>
          Clear all
        </button>
      </div>

      <div style={{ fontSize: 13 }}>
        {solution.ok ? (
          <span style={{ color: "var(--accent)" }}>
            ✓ Room matched — camera FOV ≈ {Math.round(solution.fovDeg)}°. The render will light the real
            ceiling/wall/floor.
          </span>
        ) : (
          <span className="muted">{("reason" in solution && solution.reason) || "Trace the room edges to solve the camera."}</span>
        )}
      </div>
    </div>
  );
}
