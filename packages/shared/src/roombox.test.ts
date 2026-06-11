import { describe, expect, it } from "vitest";
import type { Pt } from "./roomcalib.js";
import {
  type RoomBoxCorners,
  type RoomBoxExtents,
  type RoomSurfaceKind,
  defaultRoomBoxCorners,
  projectBoxCorners,
  raycastSurface,
  roomBoxWorldCorners,
  solveRoomBox,
  surfaceForMount,
  surfaceToWorld,
  worldToImage,
} from "./roombox.js";
import parityFixtures from "./roombox.fixtures.json";

// --- a synthetic pinhole camera (same pattern as roomcalib.test.ts) ----------
//
// World frame matches the solver's: Z-up, floor z=0, ceiling z=H, camera at
// (0,0,cz). We project a ground-truth box's six handle corners through a known
// camera and expect the solver to recover the camera AND the box, metrically.

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
  rx: V; // camera right (world)
  ry: V; // camera down (world)
  rz: V; // camera forward (world)
  f: number;
  aspect: number;
}

function makeCamera(pos: V, target: V, f: number, aspect: number): Cam {
  const fwd = normV(subV(target, pos));
  const right = normV(crossV(fwd, [0, 0, 1]));
  const up = crossV(right, fwd);
  return { pos, rx: right, ry: [-up[0], -up[1], -up[2]], rz: fwd, f, aspect };
}

function project(cam: Cam, p: V): Pt {
  const d = subV(p, cam.pos);
  const cx = dotV(d, cam.rx);
  const cy = dotV(d, cam.ry);
  const cz = dotV(d, cam.rz);
  expect(cz).toBeGreaterThan(0); // test geometry must keep corners in front
  const u = (cam.f * cx) / cz;
  const v = (cam.f * cy) / cz;
  return { x: u / cam.aspect + 0.5, y: v + 0.5 };
}

/** Project a ground-truth box's six handle corners through the camera. */
function cornersFor(cam: Cam, box: RoomBoxExtents): RoomBoxCorners {
  const { xMin, xMax, yBack, yFront, height: H } = box;
  return {
    backTopLeft: project(cam, [xMin, yBack, H]),
    backTopRight: project(cam, [xMax, yBack, H]),
    backBottomLeft: project(cam, [xMin, yBack, 0]),
    backBottomRight: project(cam, [xMax, yBack, 0]),
    frontBottomLeft: project(cam, [xMin, yFront, 0]),
    frontBottomRight: project(cam, [xMax, yFront, 0]),
  };
}

const fovOf = (cam: Cam): number => {
  const halfLarger = cam.aspect >= 1 ? cam.aspect / 2 : 0.5;
  return (2 * Math.atan(halfLarger / cam.f) * 180) / Math.PI;
};

describe("solveRoomBox: two-point perspective round-trip", () => {
  const aspect = 1.5;
  const box: RoomBoxExtents = { xMin: -2.2, xMax: 1.8, yBack: 4.5, yFront: 1.0, height: 2.74 };
  // Camera yawed right and pitched up a touch — every edge family converges.
  const cam = makeCamera([0, 0, 1.4], [1.2, 4, 1.7], 1.2, aspect);
  const solved = solveRoomBox({
    corners: cornersFor(cam, box),
    imageAspect: aspect,
    ceilingHeightM: box.height,
  });

  it("solves in two-point mode", () => {
    expect(solved.ok).toBe(true);
    expect(solved.mode).toBe("two-point");
    expect(solved.warnings).toEqual([]);
  });

  it("recovers the lens", () => {
    expect(solved.focal).toBeCloseTo(cam.f, 3);
    expect(solved.fovDeg).toBeCloseTo(fovOf(cam), 2);
  });

  it("recovers the camera height", () => {
    expect(solved.cameraHeightM).toBeCloseTo(1.4, 3);
  });

  it("recovers the box extents metrically", () => {
    expect(solved.box.xMin).toBeCloseTo(box.xMin, 3);
    expect(solved.box.xMax).toBeCloseTo(box.xMax, 3);
    expect(solved.box.yBack).toBeCloseTo(box.yBack, 3);
    expect(solved.box.yFront).toBeCloseTo(box.yFront, 3);
    expect(solved.box.height).toBe(box.height);
  });

  it("recovers the camera orientation (X gauge = back wall, screen-right)", () => {
    const got = solved.cameraBasis;
    expect(got.forward.x).toBeCloseTo(cam.rz[0], 3);
    expect(got.forward.y).toBeCloseTo(cam.rz[1], 3);
    expect(got.forward.z).toBeCloseTo(cam.rz[2], 3);
    expect(got.right.x).toBeCloseTo(cam.rx[0], 3);
    expect(got.right.y).toBeCloseTo(cam.rx[1], 3);
    expect(got.right.z).toBeCloseTo(cam.rx[2], 3);
  });

  it("rates a consistent box at full quality", () => {
    expect(solved.quality).toBeGreaterThan(0.98);
  });

  it("reprojects the dragged corners back to where they were dragged", () => {
    const reproj = projectBoxCorners(solved);
    const dragged = cornersFor(cam, box);
    for (const id of Object.keys(dragged) as (keyof RoomBoxCorners)[]) {
      expect(reproj[id]).not.toBeNull();
      expect(reproj[id]!.x).toBeCloseTo(dragged[id].x, 3);
      expect(reproj[id]!.y).toBeCloseTo(dragged[id].y, 3);
    }
    // Derived front-top corners exist too (they complete the cube wireframe).
    expect(reproj.frontTopLeft).not.toBeNull();
    expect(reproj.frontTopRight).not.toBeNull();
  });

  it("round-trips surface points: surfaceToWorld → worldToImage → raycastSurface", () => {
    const cases: Array<[RoomSurfaceKind, number, number]> = [
      ["ceiling", 0.3, 0.7],
      ["wall-back", 0.6, 0.55],
      ["wall-left", 0.8, 0.4],
      ["wall-right", 0.7, 0.6],
      ["floor", 0.45, 0.8],
    ];
    for (const [surface, u, v] of cases) {
      const world = surfaceToWorld(solved.box, surface, u, v);
      const img = worldToImage(solved, world);
      expect(img, `${surface} projects`).not.toBeNull();
      const rt = raycastSurface(solved, img!, surface);
      expect(rt, `${surface} raycasts`).not.toBeNull();
      expect(rt!.u).toBeCloseTo(u, 4);
      expect(rt!.v).toBeCloseTo(v, 4);
    }
  });
});

describe("solveRoomBox: one-point perspective with an assumed lens", () => {
  const aspect = 1.6;
  const fovDeg = 55;
  const halfLarger = aspect / 2;
  const f = halfLarger / Math.tan((fovDeg * Math.PI) / 180 / 2);
  const box: RoomBoxExtents = { xMin: -2.5, xMax: 1.5, yBack: 4, yFront: 0.6, height: 2.74 };
  // Level camera looking straight down +Y: back-wall X and Z edges are parallel
  // in the image — the classic one-point room photo.
  const cam = makeCamera([0, 0, 1.5], [0, 5, 1.5], f, aspect);
  const corners = cornersFor(cam, box);

  it("recovers height + extents when given the true lens", () => {
    const solved = solveRoomBox({
      corners,
      imageAspect: aspect,
      ceilingHeightM: box.height,
      assumedFovDeg: fovDeg,
    });
    expect(solved.ok).toBe(true);
    expect(solved.mode).toBe("one-point");
    expect(solved.fovDeg).toBeCloseTo(fovDeg, 5);
    expect(solved.cameraHeightM).toBeCloseTo(1.5, 3);
    expect(solved.box.xMin).toBeCloseTo(box.xMin, 3);
    expect(solved.box.xMax).toBeCloseTo(box.xMax, 3);
    expect(solved.box.yBack).toBeCloseTo(box.yBack, 3);
    expect(solved.box.yFront).toBeCloseTo(box.yFront, 3);
  });

  it("still solves (approximately) with a wrong assumed lens — geometry scales, ok stays true", () => {
    const solved = solveRoomBox({
      corners,
      imageAspect: aspect,
      ceilingHeightM: box.height,
      assumedFovDeg: 70,
    });
    // A wrong lens distorts depth but must not crash or fail the solve: the
    // user sees the wireframe land oddly and adjusts the lens slider.
    expect(solved.ok).toBe(true);
    expect(solved.cameraHeightM).toBeGreaterThan(0);
    expect(solved.box.yBack).toBeGreaterThan(solved.box.yFront);
  });
});

describe("solveRoomBox: defaults and failure modes", () => {
  it("solves the default starting box (symmetric → one-point fallback)", () => {
    const solved = solveRoomBox({ corners: defaultRoomBoxCorners(), imageAspect: 1.5 });
    expect(solved.ok).toBe(true);
    expect(solved.mode).toBe("one-point");
    expect(solved.cameraHeightM).toBeGreaterThan(0);
    expect(solved.cameraHeightM).toBeLessThan(solved.box.height);
    expect(solved.box.yBack).toBeGreaterThan(0);
  });

  it("fails when the corners are degenerate", () => {
    const p = { x: 0.5, y: 0.5 };
    const solved = solveRoomBox({
      corners: {
        backTopLeft: p,
        backTopRight: p,
        backBottomLeft: p,
        backBottomRight: p,
        frontBottomLeft: p,
        frontBottomRight: p,
      },
      imageAspect: 1.5,
    });
    expect(solved.ok).toBe(false);
    expect(solved.reason).toBeTruthy();
  });

  it("fails when the box is inside out (front corners above the back wall)", () => {
    const corners = defaultRoomBoxCorners();
    const flipped: RoomBoxCorners = {
      ...corners,
      frontBottomLeft: { x: 0.3, y: 0.05 },
      frontBottomRight: { x: 0.7, y: 0.05 },
    };
    const solved = solveRoomBox({ corners: flipped, imageAspect: 1.5 });
    expect(solved.ok).toBe(false);
    expect(solved.reason).toBeTruthy();
  });

  it("rejects a silly ceiling height", () => {
    expect(
      solveRoomBox({ corners: defaultRoomBoxCorners(), imageAspect: 1.5, ceilingHeightM: 42 }).ok,
    ).toBe(false);
  });
});

describe("surfaceToWorld parity fixtures (shared with the Python port)", () => {
  for (const c of parityFixtures.cases) {
    it(`${c.surface} u=${c.u} v=${c.v}`, () => {
      const got = surfaceToWorld(c.box as RoomBoxExtents, c.surface as RoomSurfaceKind, c.u, c.v);
      expect(got.x).toBeCloseTo(c.world.x, 9);
      expect(got.y).toBeCloseTo(c.world.y, 9);
      expect(got.z).toBeCloseTo(c.world.z, 9);
    });
  }

  it("world corners cover the box", () => {
    const box: RoomBoxExtents = { xMin: -2, xMax: 2, yBack: 5, yFront: -1, height: 2.74 };
    const corners = roomBoxWorldCorners(box);
    expect(corners.backTopLeft).toEqual({ x: -2, y: 5, z: 2.74 });
    expect(corners.frontBottomRight).toEqual({ x: 2, y: -1, z: 0 });
  });
});

describe("surfaceForMount", () => {
  it("maps fixture mounts to surfaces", () => {
    expect(surfaceForMount("ceiling")).toBe("ceiling");
    expect(surfaceForMount("recessed")).toBe("ceiling");
    expect(surfaceForMount("wall")).toBe("wall-back");
    expect(surfaceForMount("floor")).toBe("floor");
    expect(surfaceForMount(undefined)).toBe("ceiling");
  });
});
