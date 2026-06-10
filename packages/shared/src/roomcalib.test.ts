import { describe, expect, it } from "vitest";
import {
  type AxisLines,
  type Pt,
  type Seg,
  solveRoomCalibration,
  vanishingPoint,
} from "./roomcalib.js";

// --- a synthetic pinhole camera to generate faithful test data ---------------
//
// World frame is Z-up. We build a camera looking into the room (slightly up at a
// ceiling fixture), project world points through it, and feed the resulting
// image lines back into the solver. The solver should recover the same fov and
// the same camera tilt (azimuth is a free gauge, so we test tilt-vs-vertical).

type V = [number, number, number];

const subV = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dotV = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normV = (a: V): V => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

interface Cam {
  pos: V;
  // camera-from-world rows (x=right, y=down, z=forward), in world coords.
  rx: V;
  ry: V;
  rz: V;
  f: number; // focal in image-height units
  aspect: number;
}

function makeCamera(pos: V, target: V, f: number, aspect: number): Cam {
  const fwd = normV(subV(target, pos)); // camera forward (world)
  const right = normV(crossV(fwd, [0, 0, 1])); // right = fwd × worldUp
  const up = crossV(right, fwd); // camera up (world), already unit
  const down: V = [-up[0], -up[1], -up[2]];
  return { pos, rx: right, ry: down, rz: fwd, f, aspect };
}

/** Project a world point to normalized image coords (0..1, y down). */
function project(cam: Cam, p: V): Pt {
  const d = subV(p, cam.pos);
  const cx = dotV(d, cam.rx);
  const cy = dotV(d, cam.ry);
  const cz = dotV(d, cam.rz);
  const u = (cam.f * cx) / cz; // centered coords
  const v = (cam.f * cy) / cz;
  return { x: u / cam.aspect + 0.5, y: v + 0.5 };
}

/** Two world lines along `dir` (through two base points) → two image segments. */
function axisLines(cam: Cam, dir: V, bases: V[], t = 1.2): Seg[] {
  return bases.map((base) => ({
    a: project(cam, [base[0] - dir[0] * t, base[1] - dir[1] * t, base[2] - dir[2] * t]),
    b: project(cam, [base[0] + dir[0] * t, base[1] + dir[1] * t, base[2] + dir[2] * t]),
  }));
}

const angleBetween = (a: V, b: V): number =>
  (Math.acos(Math.min(1, Math.max(-1, dotV(normV(a), normV(b))))) * 180) / Math.PI;

describe("vanishingPoint", () => {
  it("intersects two converging lines at their meeting point", () => {
    // Two lines meeting at normalized (0.5, 0.5) → centered (0,0).
    const lines: Seg[] = [
      { a: { x: 0.5, y: 0.5 }, b: { x: 0.2, y: 0.2 } },
      { a: { x: 0.5, y: 0.5 }, b: { x: 0.8, y: 0.2 } },
    ];
    const vp = vanishingPoint(lines, 1);
    expect(vp.atInfinity).toBe(false);
    expect(vp.point!.u).toBeCloseTo(0, 4);
    expect(vp.point!.v).toBeCloseTo(0, 4);
  });

  it("reports parallel lines as a vanishing point at infinity", () => {
    const lines: Seg[] = [
      { a: { x: 0.2, y: 0.1 }, b: { x: 0.2, y: 0.9 } },
      { a: { x: 0.7, y: 0.1 }, b: { x: 0.7, y: 0.9 } },
    ];
    const vp = vanishingPoint(lines, 1.5);
    expect(vp.atInfinity).toBe(true);
  });
});

describe("solveRoomCalibration round-trip", () => {
  const aspect = 1.5;
  const f = 1.2;
  const cam = makeCamera([0, -4, 1.4], [0, 0, 2.5], f, aspect);

  // Draw the three room axes from a synthetic camera.
  const axes: AxisLines[] = [
    {
      axis: "horizontalA",
      lines: axisLines(cam, [1, 0, 0], [
        [0, 0.3, 2.4],
        [0.2, 1.1, 1.9],
      ]),
    },
    {
      axis: "horizontalB",
      lines: axisLines(cam, [0, 1, 0], [
        [-0.4, 0.6, 2.3],
        [0.5, 0.6, 1.8],
      ]),
    },
    {
      axis: "vertical",
      lines: axisLines(cam, [0, 0, 1], [
        [-0.6, 0.5, 1.8],
        [0.6, 0.9, 1.8],
      ]),
    },
  ];

  const result = solveRoomCalibration(axes, aspect);

  it("succeeds", () => {
    expect(result.ok).toBe(true);
  });

  it("recovers the focal length / fov", () => {
    expect(result.focal).toBeCloseTo(f, 3);
    const trueFovDeg = (2 * Math.atan(aspect / 2 / f) * 180) / Math.PI; // larger dim
    expect(result.fovDeg).toBeCloseTo(trueFovDeg, 2);
  });

  it("returns an orthonormal, right-handed camera basis", () => {
    const { right, up, forward } = result.cameraBasis;
    const r: V = [right.x, right.y, right.z];
    const u: V = [up.x, up.y, up.z];
    const fwd: V = [forward.x, forward.y, forward.z];
    expect(Math.hypot(...r)).toBeCloseTo(1, 6);
    expect(Math.hypot(...u)).toBeCloseTo(1, 6);
    expect(Math.hypot(...fwd)).toBeCloseTo(1, 6);
    expect(dotV(r, u)).toBeCloseTo(0, 5);
    expect(dotV(r, fwd)).toBeCloseTo(0, 5);
    expect(dotV(u, fwd)).toBeCloseTo(0, 5);
    // View-frame convention (matches Blender): forward is the viewing direction
    // and up = -down, so right × up = -forward (equivalently forward = up × right).
    const rxu = crossV(r, u);
    expect(rxu[0]).toBeCloseTo(-fwd[0], 5);
    expect(rxu[1]).toBeCloseTo(-fwd[1], 5);
    expect(rxu[2]).toBeCloseTo(-fwd[2], 5);
  });

  it("recovers the camera tilt relative to vertical (azimuth is a free gauge)", () => {
    const trueForward = cam.rz;
    const recovered: V = [
      result.cameraBasis.forward.x,
      result.cameraBasis.forward.y,
      result.cameraBasis.forward.z,
    ];
    const trueTilt = angleBetween(trueForward, [0, 0, 1]);
    const gotTilt = angleBetween(recovered, [0, 0, 1]);
    expect(gotTilt).toBeCloseTo(trueTilt, 1);
    // camera up should tilt away from world-up by the same amount
    const recUp: V = [result.cameraBasis.up.x, result.cameraBasis.up.y, result.cameraBasis.up.z];
    expect(recUp[2]).toBeGreaterThan(0); // camera up has a positive vertical component
  });

  it("reports world up as +Z", () => {
    expect(result.worldUp).toEqual({ x: 0, y: 0, z: 1 });
  });
});

describe("solveRoomCalibration failure modes", () => {
  it("fails with fewer than two converging axes", () => {
    const aspect = 1.5;
    // Only one axis drawn, and verticals (parallel → VP at ∞).
    const axes: AxisLines[] = [
      {
        axis: "vertical",
        lines: [
          { a: { x: 0.2, y: 0.1 }, b: { x: 0.2, y: 0.9 } },
          { a: { x: 0.7, y: 0.1 }, b: { x: 0.7, y: 0.9 } },
        ],
      },
    ];
    const res = solveRoomCalibration(axes, aspect);
    expect(res.ok).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  it("solves a level 2-point camera (toward a corner, verticals at infinity)", () => {
    const aspect = 1.6;
    const f = 1.4;
    // Level camera yawed toward a corner: both horizontal walls recede to finite
    // VPs (2-point perspective); verticals stay vertical (VP at infinity).
    const cam = makeCamera([-3, -3, 1.3], [0, 0, 1.3], f, aspect);
    const axes: AxisLines[] = [
      {
        axis: "horizontalA",
        lines: axisLines(cam, [1, 0, 0], [
          [0, 0.4, 2.2],
          [0.2, 1.2, 0.6],
        ]),
      },
      {
        axis: "horizontalB",
        lines: axisLines(cam, [0, 1, 0], [
          [-0.4, 0.3, 2.0],
          [0.6, 0.5, 0.8],
        ]),
      },
      {
        axis: "vertical",
        lines: axisLines(cam, [0, 0, 1], [
          [-0.6, 0.4, 1.3],
          [0.7, 0.6, 1.3],
        ]),
      },
    ];
    const res = solveRoomCalibration(axes, aspect);
    expect(res.ok).toBe(true);
    expect(res.focal).toBeCloseTo(f, 2);
    // a level camera looks nearly horizontal: forward has ~zero vertical component
    expect(Math.abs(res.cameraBasis.forward.z)).toBeLessThan(0.05);
  });
});
