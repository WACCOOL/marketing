/**
 * Room-box calibration: solve the photo's camera AND the room's actual box
 * geometry from six user-dragged corners (the "fix the corners of a cube"
 * room-match step for the 3D App-Shot — successor to the line-tracing
 * roomcalib flow, whose vanishing-point machinery this reuses).
 *
 * The user drags the back-wall quad plus the two front floor corners:
 *
 *        backTopLeft ────────── backTopRight
 *             │                      │
 *        backBottomLeft ──── backBottomRight
 *            /                        \
 *      frontBottomLeft           frontBottomRight
 *
 * Those six points generate the three orthogonal edge families (back-wall
 * horizontals = world X, verticals = world Z, floor seams = world Y/depth), so
 * the camera solve is exactly the roomcalib vanishing-point problem — but the
 * corners ALSO pin down where the walls/floor/ceiling actually are. Anchored by
 * a real ceiling height (user input, default 9 ft), the solve becomes METRIC:
 * camera height in meters, wall positions in meters, so fixtures can render
 * true-to-scale and lights fall off over real distances.
 *
 * World frame (shared with roomcalib/Blender): Z-up, floor at z=0, ceiling at
 * z=H, camera at (0, 0, cameraHeightM). +X runs along the back wall toward
 * screen-right, +Y is room depth away from the camera (back wall at y=yBack>0).
 *
 * Pure math, no DOM/Blender deps. `surfaceToWorld` is ported to Python in
 * apps/render-worker/blender/roombox.py — keep the two in sync via the shared
 * fixture table in roombox.fixtures.json.
 */

import {
  type AxisLines,
  type Pt,
  type Vec3,
  solveRoomCalibration,
  vanishingPoint,
} from "./roomcalib.js";

export type RoomBoxCornerId =
  | "backTopLeft"
  | "backTopRight"
  | "backBottomLeft"
  | "backBottomRight"
  | "frontBottomLeft"
  | "frontBottomRight";

/** The six dragged corners, in normalized image coords (0..1, y down; handles
 * may sit off-frame within -0.5..1.5). */
export type RoomBoxCorners = Record<RoomBoxCornerId, Pt>;

/** The eight box corners (six dragged + two derived front-top), for display. */
export type RoomBoxDisplayCornerId = RoomBoxCornerId | "frontTopLeft" | "frontTopRight";

/** A mountable room surface. Left/right are in WORLD terms (xMin/xMax walls),
 * which match screen left/right because the solve fixes +X to screen-right. */
export type RoomSurfaceKind = "ceiling" | "wall-back" | "wall-left" | "wall-right" | "floor";

/** Solved box extents, meters. Camera sits at (0,0) in plan; back wall at
 * y=yBack, front (open) side at y=yFront (may be ≤0, i.e. behind the camera). */
export interface RoomBoxExtents {
  xMin: number;
  xMax: number;
  yBack: number;
  yFront: number;
  /** Ceiling height — equals the ceilingHeightM anchor. */
  height: number;
}

export interface RoomBoxInput {
  corners: RoomBoxCorners;
  /** Room photo width / height. */
  imageAspect: number;
  /** Metric anchor: real-world ceiling height in meters (default 2.74 = 9 ft). */
  ceilingHeightM?: number;
  /** One-point-perspective fallback FOV (degrees along the larger image
   * dimension). Used only when the corners can't recover focal length (back
   * wall drawn as a plain rectangle — X and Z edges parallel in the image). */
  assumedFovDeg?: number;
}

export interface RoomBoxSolved {
  ok: boolean;
  /** Why the solve failed (degenerate corners), when !ok. */
  reason?: string;
  /** "two-point": focal recovered from converging edges; "one-point": focal
   * taken from assumedFovDeg because the box edges are parallel in the image. */
  mode: "one-point" | "two-point";
  /** FOV along the larger image dimension, degrees (Blender camera.angle). */
  fovDeg: number;
  /** Focal length in image-height-fraction units (roomcalib convention). */
  focal: number;
  /** Camera axes in WORLD coords (camera-to-world), roomcalib convention. */
  cameraBasis: { right: Vec3; up: Vec3; forward: Vec3 };
  worldUp: Vec3;
  /** Camera height above the floor, meters. */
  cameraHeightM: number;
  box: RoomBoxExtents;
  imageAspect: number;
  /** 1 = corners perfectly consistent with a rectangular box; falls toward 0 as
   * the per-corner estimates disagree. Heuristic — drive a UI warning, not math. */
  quality: number;
  warnings: string[];
}

export const DEFAULT_CEILING_M = 2.74; // 9 ft
export const DEFAULT_ASSUMED_FOV_DEG = 55;

// --- small vector helpers (local; roomcalib doesn't export its own) ----------

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const norm = (a: Vec3): number => Math.sqrt(dot(a, a));
const normalize = (a: Vec3): Vec3 => scale(a, 1 / (norm(a) || 1));

/** The three orthogonal edge families generated by the six corners. */
export function boxAxisLines(corners: RoomBoxCorners): AxisLines[] {
  const c = corners;
  return [
    // World X: the back wall's horizontal edges.
    {
      axis: "horizontalA",
      lines: [
        { a: c.backTopLeft, b: c.backTopRight },
        { a: c.backBottomLeft, b: c.backBottomRight },
      ],
    },
    // World Y (depth): the floor seams running from the back corners forward.
    {
      axis: "horizontalB",
      lines: [
        { a: c.backBottomLeft, b: c.frontBottomLeft },
        { a: c.backBottomRight, b: c.frontBottomRight },
      ],
    },
    // World Z: the back wall's vertical edges.
    {
      axis: "vertical",
      lines: [
        { a: c.backTopLeft, b: c.backBottomLeft },
        { a: c.backTopRight, b: c.backBottomRight },
      ],
    },
  ];
}

/** Normalized image point → centered square-pixel coords (roomcalib convention). */
const toCentered = (p: Pt, aspect: number) => ({ u: (p.x - 0.5) * aspect, v: p.y - 0.5 });

/** World-space ray direction from the camera through a normalized image point. */
function pixelRay(solved: Pick<RoomBoxSolved, "cameraBasis" | "focal" | "imageAspect">, p: Pt): Vec3 {
  const { u, v } = toCentered(p, solved.imageAspect);
  const { right, up, forward } = solved.cameraBasis;
  // Camera frame is x-right / y-DOWN / z-forward; image v grows downward.
  return add(add(scale(right, u), scale(up, -v)), scale(forward, solved.focal));
}

const fail = (reason: string): RoomBoxSolved => ({
  ok: false,
  reason,
  mode: "two-point",
  fovDeg: 0,
  focal: 0,
  cameraBasis: {
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    forward: { x: 0, y: 1, z: 0 },
  },
  worldUp: { x: 0, y: 0, z: 1 },
  cameraHeightM: 0,
  box: { xMin: -1, xMax: 1, yBack: 1, yFront: 0, height: DEFAULT_CEILING_M },
  imageAspect: 1,
  quality: 0,
  warnings: [],
});

/**
 * Camera orientation + focal from the box edges. Tries the full roomcalib
 * vanishing-point solve first (two-point perspective); falls back to the
 * assumed-FOV one-point construction when the edges are parallel in the image.
 */
function solveCamera(
  corners: RoomBoxCorners,
  aspect: number,
  assumedFovDeg: number,
): {
  ok: boolean;
  reason?: string;
  mode: "one-point" | "two-point";
  focal: number;
  fovDeg: number;
  basis: { right: Vec3; up: Vec3; forward: Vec3 };
  warnings: string[];
} {
  const warnings: string[] = [];
  const axes = boxAxisLines(corners);
  const halfLarger = aspect >= 1 ? aspect / 2 : 0.5;
  const camFail = (reason: string) => ({
    ok: false as const,
    reason,
    mode: "one-point" as const,
    focal: 0,
    fovDeg: 0,
    basis: fail("").cameraBasis,
    warnings,
  });

  // Focal length: from the converging edges when they converge (the roomcalib
  // VP solve), else the assumed lens. A sloppy box can put a "finite" VP
  // absurdly far out and solve to an extreme lens; treat that as
  // not-really-converging and fall back too.
  const calib = solveRoomCalibration(axes, aspect);
  let mode: "one-point" | "two-point";
  let focal: number;
  let fovDeg: number;
  if (calib.ok && calib.fovDeg >= 15 && calib.fovDeg <= 120) {
    mode = "two-point";
    focal = calib.focal;
    fovDeg = calib.fovDeg;
  } else {
    if (calib.ok) {
      warnings.push(
        `solved lens looks implausible (${calib.fovDeg.toFixed(0)}° fov) — using the assumed lens instead`,
      );
    }
    mode = "one-point";
    fovDeg = assumedFovDeg;
    focal = halfLarger / Math.tan((fovDeg * Math.PI) / 180 / 2);
  }

  // Build the world frame DIRECTLY from this box's vanishing points (not from
  // solveRoomCalibration's basis, whose X-gauge follows whichever family it
  // used as reference — we need X = back wall, Y = depth, unconditionally).
  const vpX = vanishingPoint(axes[0]!.lines, aspect);
  const vpY = vanishingPoint(axes[1]!.lines, aspect);
  const vpZ = vanishingPoint(axes[2]!.lines, aspect);

  // World +Y (depth, into the scene) in camera coords: the ray toward the floor
  // seams' VP. Required — without it depth (and the metric solve) is gone.
  if (vpY.atInfinity || !vpY.point) {
    return camFail(
      "the floor corners don't converge — drag the front corners outward so the floor edges recede into the room",
    );
  }
  const yCam = normalize({ x: vpY.point.u, y: vpY.point.v, z: focal });

  // World up in camera coords. Camera +y is image-down, so up must have y<0.
  const upSign = (v: Vec3): Vec3 => (v.y > 0 ? scale(v, -1) : v);
  let zCam: Vec3;
  if (!vpZ.atInfinity && vpZ.point) {
    zCam = upSign(normalize({ x: vpZ.point.u, y: vpZ.point.v, z: focal }));
  } else if (!vpX.atInfinity && vpX.point) {
    // Level camera (verticals parallel): up = X × Y of the two horizontal rays.
    const xRay = normalize({ x: vpX.point.u, y: vpX.point.v, z: focal });
    zCam = upSign(normalize(cross(xRay, yCam)));
  } else {
    // One-point: up from the back wall's image-vertical edge direction (a VP at
    // infinity means the world direction is image-parallel: (du, dv, 0)).
    zCam = upSign(normalize({ x: vpZ.dir.u, y: vpZ.dir.v, z: 0 }));
  }

  // Orthogonalize depth against up, derive X right-handed (X × Y = Z).
  let yOrtho = sub(yCam, scale(zCam, dot(yCam, zCam)));
  if (norm(yOrtho) < 1e-6) {
    return camFail("the box edges are too degenerate to orient the camera — adjust the corners");
  }
  yOrtho = normalize(yOrtho);
  const xCam = cross(yOrtho, zCam);
  // Camera axes in world coords = rows of the [X Y Z] world-axes-in-camera matrix.
  const right: Vec3 = { x: xCam.x, y: yOrtho.x, z: zCam.x };
  const down: Vec3 = { x: xCam.y, y: yOrtho.y, z: zCam.y };
  const forward: Vec3 = { x: xCam.z, y: yOrtho.z, z: zCam.z };
  return {
    ok: true,
    mode,
    focal,
    fovDeg,
    basis: { right: normalize(right), up: normalize(scale(down, -1)), forward: normalize(forward) },
    warnings,
  };
}

/** Flip the world X/Y gauge (a 180° azimuth turn, still right-handed) applied
 * to camera-basis vectors: world components (x,y) negate, z stays. */
const flipGauge = (v: Vec3): Vec3 => ({ x: -v.x, y: -v.y, z: v.z });

export function solveRoomBox(input: RoomBoxInput): RoomBoxSolved {
  const aspect = input.imageAspect;
  if (!(aspect > 0) || !Number.isFinite(aspect)) return fail("invalid image aspect");
  const H = input.ceilingHeightM ?? DEFAULT_CEILING_M;
  if (!(H > 0.5) || !(H < 10)) return fail("ceiling height must be between 0.5 and 10 meters");

  const cam = solveCamera(input.corners, aspect, input.assumedFovDeg ?? DEFAULT_ASSUMED_FOV_DEG);
  if (!cam.ok) return { ...fail(cam.reason ?? "could not solve the camera"), mode: cam.mode };
  let basis = cam.basis;

  // Fix the azimuth gauge so world +X points screen-right (then +Y, which is
  // Z×X, points into the scene for any forward-facing camera). This is what
  // makes "wall-left" mean the wall on the LEFT of the photo.
  // X in camera coords is the x-components of the camera axes in world.
  const xCamX = basis.right.x; // world X · camera right
  if (xCamX < 0) {
    basis = {
      right: flipGauge(basis.right),
      up: flipGauge(basis.up),
      forward: flipGauge(basis.forward),
    };
  }
  // World Y in camera coords' forward component — must point into the scene.
  if (basis.forward.y < 0) {
    return fail("the solved camera faces away from the box — adjust the corners");
  }

  const partial = { cameraBasis: basis, focal: cam.focal, imageAspect: aspect };
  const c = input.corners;

  // --- camera height: each back vertical edge says its top ray (hits z=H) and
  // bottom ray (hits z=0) land at the same plan position → linear in cz. ------
  const eqs: Array<{ d: number; h: number }> = [];
  for (const [topId, botId] of [
    ["backTopLeft", "backBottomLeft"],
    ["backTopRight", "backBottomRight"],
  ] as const) {
    const rt = pixelRay(partial, c[topId]);
    const rb = pixelRay(partial, c[botId]);
    if (Math.abs(rt.z) < 1e-6 || Math.abs(rb.z) < 1e-6) continue; // ray at the horizon
    const at = rt.x / rt.z;
    const ab = rb.x / rb.z;
    const bt = rt.y / rt.z;
    const bb = rb.y / rb.z;
    // (H − cz)·at = −cz·ab  ⇒  (at − ab)·cz = H·at   (same for y components)
    eqs.push({ d: at - ab, h: H * at });
    eqs.push({ d: bt - bb, h: H * bt });
  }
  let num = 0;
  let den = 0;
  for (const e of eqs) {
    num += e.d * e.h;
    den += e.d * e.d;
  }
  if (den < 1e-9) {
    return fail("the back wall's vertical edges are degenerate — spread the corners apart");
  }
  const cz = num / den;
  if (!(cz > 0.05) || cz > H * 1.5) {
    return fail("the corners don't agree on a camera height — straighten the box");
  }
  const warnings = [...cam.warnings];
  if (cz >= H) warnings.push("camera solves above the ceiling — check the ceiling height");

  // --- box extents: intersect each corner ray with its floor/ceiling plane ---
  const camPos: Vec3 = { x: 0, y: 0, z: cz };
  const hit = (id: RoomBoxCornerId, planeZ: number): Vec3 | null => {
    const r = pixelRay(partial, c[id]);
    if (Math.abs(r.z) < 1e-9) return null;
    const t = (planeZ - cz) / r.z;
    if (t <= 0) return null; // corner lands behind the camera — box is inside out
    return add(camPos, scale(r, t));
  };
  const bbl = hit("backBottomLeft", 0);
  const bbr = hit("backBottomRight", 0);
  const btl = hit("backTopLeft", H);
  const btr = hit("backTopRight", H);
  const fbl = hit("frontBottomLeft", 0);
  const fbr = hit("frontBottomRight", 0);
  if (!bbl || !bbr || !btl || !btr) {
    return fail("a back corner points away from its floor/ceiling — drag it back inside the room");
  }
  if (!fbl || !fbr) {
    return fail("a front corner lands behind the camera — drag it down toward the floor");
  }

  const yEst = [bbl.y, bbr.y, btl.y, btr.y];
  const yBack = yEst.reduce((s, v) => s + v, 0) / yEst.length;
  const xlEst = [bbl.x, btl.x, fbl.x];
  const xrEst = [bbr.x, btr.x, fbr.x];
  const xMin = xlEst.reduce((s, v) => s + v, 0) / xlEst.length;
  const xMax = xrEst.reduce((s, v) => s + v, 0) / xrEst.length;
  const yFront = Math.min(fbl.y, fbr.y);

  if (!(xMax > xMin + 0.2)) return fail("the room solves implausibly narrow — widen the box");
  if (!(yBack > 0.2)) return fail("the back wall solves at the camera — push the back corners up");
  if (!(yBack > yFront + 0.05)) return fail("the floor solves deeper than the back wall — adjust the front corners");

  // Quality: how much the redundant per-corner estimates disagree, relative to
  // the room size. 1 = a perfectly consistent rectangular box.
  const spread = (vals: number[]) => Math.max(...vals) - Math.min(...vals);
  const relErr =
    (spread(yEst) / Math.max(yBack - Math.min(yFront, 0), 0.5) +
      spread(xlEst) / Math.max(xMax - xMin, 0.5) +
      spread(xrEst) / Math.max(xMax - xMin, 0.5)) /
    3;
  const quality = Math.max(0, Math.min(1, 1 - 2 * relErr));
  if (quality < 0.5) warnings.push("corners don't quite agree on a rectangular room — nudge them for a tighter match");

  return {
    ok: true,
    mode: cam.mode,
    fovDeg: cam.fovDeg,
    focal: cam.focal,
    cameraBasis: basis,
    worldUp: { x: 0, y: 0, z: 1 },
    cameraHeightM: cz,
    box: { xMin, xMax, yBack, yFront, height: H },
    imageAspect: aspect,
    quality,
    warnings,
  };
}

/** The camera's world position in the solved frame. */
export const roomBoxCameraPosition = (solved: Pick<RoomBoxSolved, "cameraHeightM">): Vec3 => ({
  x: 0,
  y: 0,
  z: solved.cameraHeightM,
});

/** World point → normalized image coords; null when behind the camera. */
export function worldToImage(
  solved: Pick<RoomBoxSolved, "cameraBasis" | "focal" | "imageAspect" | "cameraHeightM">,
  p: Vec3,
): Pt | null {
  const d = sub(p, roomBoxCameraPosition(solved));
  const { right, up, forward } = solved.cameraBasis;
  const cz = dot(d, forward);
  if (cz < 1e-6) return null;
  const u = (solved.focal * dot(d, right)) / cz;
  const v = (solved.focal * -dot(d, up)) / cz; // image v grows downward
  return { x: u / solved.imageAspect + 0.5, y: v + 0.5 };
}

/** The eight box corners in world coords. */
export function roomBoxWorldCorners(box: RoomBoxExtents): Record<RoomBoxDisplayCornerId, Vec3> {
  const { xMin, xMax, yBack, yFront, height: H } = box;
  return {
    backTopLeft: { x: xMin, y: yBack, z: H },
    backTopRight: { x: xMax, y: yBack, z: H },
    backBottomLeft: { x: xMin, y: yBack, z: 0 },
    backBottomRight: { x: xMax, y: yBack, z: 0 },
    frontBottomLeft: { x: xMin, y: yFront, z: 0 },
    frontBottomRight: { x: xMax, y: yFront, z: 0 },
    frontTopLeft: { x: xMin, y: yFront, z: H },
    frontTopRight: { x: xMax, y: yFront, z: H },
  };
}

/** Reproject the solved box to image space (for the wireframe overlay).
 * Corners behind the camera come back null. */
export function projectBoxCorners(
  solved: RoomBoxSolved,
): Record<RoomBoxDisplayCornerId, Pt | null> {
  const world = roomBoxWorldCorners(solved.box);
  const out = {} as Record<RoomBoxDisplayCornerId, Pt | null>;
  for (const id of Object.keys(world) as RoomBoxDisplayCornerId[]) {
    out[id] = worldToImage(solved, world[id]);
  }
  return out;
}

/**
 * Surface-local (u,v) → world position. u runs along the surface's first axis,
 * v along its second, both 0..1 of the box extents:
 *   ceiling/floor: u = +X (left→right), v = +Y (front→back)
 *   wall-back:     u = +X (left→right), v = +Z (floor→ceiling)
 *   wall-left/right: u = +Y (front→back), v = +Z (floor→ceiling)
 *
 * PYTHON PARITY: ported in apps/render-worker/blender/roombox.py; both are
 * checked against roombox.fixtures.json — update all three together.
 */
export function surfaceToWorld(
  box: RoomBoxExtents,
  surface: RoomSurfaceKind,
  u: number,
  v: number,
): Vec3 {
  const { xMin, xMax, yBack, yFront, height: H } = box;
  const x = xMin + u * (xMax - xMin);
  const yAlong = yFront + (surface === "wall-left" || surface === "wall-right" ? u : v) * (yBack - yFront);
  switch (surface) {
    case "ceiling":
      return { x, y: yAlong, z: H };
    case "floor":
      return { x, y: yAlong, z: 0 };
    case "wall-back":
      return { x, y: yBack, z: v * H };
    case "wall-left":
      return { x: xMin, y: yAlong, z: v * H };
    case "wall-right":
      return { x: xMax, y: yAlong, z: v * H };
  }
}

/**
 * Image point → surface-local (u,v) by casting the pixel ray onto the surface
 * plane. Returns null when the ray misses (parallel or behind the camera). The
 * result is NOT clamped — callers clamp to 0..1 so drags pin at the edges.
 */
export function raycastSurface(
  solved: Pick<RoomBoxSolved, "cameraBasis" | "focal" | "imageAspect" | "cameraHeightM" | "box">,
  imagePt: Pt,
  surface: RoomSurfaceKind,
): { u: number; v: number } | null {
  const { xMin, xMax, yBack, yFront, height: H } = solved.box;
  const origin = roomBoxCameraPosition(solved);
  const ray = pixelRay(solved, imagePt);

  let t: number;
  switch (surface) {
    case "ceiling":
      if (Math.abs(ray.z) < 1e-9) return null;
      t = (H - origin.z) / ray.z;
      break;
    case "floor":
      if (Math.abs(ray.z) < 1e-9) return null;
      t = -origin.z / ray.z;
      break;
    case "wall-back":
      if (Math.abs(ray.y) < 1e-9) return null;
      t = (yBack - origin.y) / ray.y;
      break;
    case "wall-left":
      if (Math.abs(ray.x) < 1e-9) return null;
      t = (xMin - origin.x) / ray.x;
      break;
    case "wall-right":
      if (Math.abs(ray.x) < 1e-9) return null;
      t = (xMax - origin.x) / ray.x;
      break;
  }
  if (t <= 1e-6) return null;
  const p = add(origin, scale(ray, t));

  const W = Math.max(xMax - xMin, 1e-6);
  const D = Math.max(yBack - yFront, 1e-6);
  switch (surface) {
    case "ceiling":
    case "floor":
      return { u: (p.x - xMin) / W, v: (p.y - yFront) / D };
    case "wall-back":
      return { u: (p.x - xMin) / W, v: p.z / H };
    case "wall-left":
    case "wall-right":
      return { u: (p.y - yFront) / D, v: p.z / H };
  }
}

/** The minimal solved-room shape the projection helpers need — a RoomBoxSolved,
 * or one reconstructed from a stored RoomGeometry via solvedFromGeometry. */
export type RoomBoxView = Pick<
  RoomBoxSolved,
  "cameraBasis" | "focal" | "imageAspect" | "cameraHeightM" | "box"
>;

/**
 * Rebuild the projection view from a STORED room geometry (no re-solve): the
 * schema persists the camera basis + fov and the solved box/camera-height, and
 * focal follows from fov. Returns null when the geometry has no solved box
 * (legacy line-traced calibrations).
 */
export function solvedFromGeometry(geom: {
  imageAspect: number;
  camera: { fovDeg: number; right: Vec3; up: Vec3; forward: Vec3 };
  box?: { solved: { cameraHeightM: number; box: RoomBoxExtents } } | undefined;
}): RoomBoxView | null {
  if (!geom.box?.solved) return null;
  const aspect = geom.imageAspect;
  const halfLarger = aspect >= 1 ? aspect / 2 : 0.5;
  return {
    cameraBasis: {
      right: geom.camera.right,
      up: geom.camera.up,
      forward: geom.camera.forward,
    },
    focal: halfLarger / Math.tan((geom.camera.fovDeg * Math.PI) / 180 / 2),
    imageAspect: aspect,
    cameraHeightM: geom.box.solved.cameraHeightM,
    box: geom.box.solved.box,
  };
}

/** Where a surface-attached fixture's anchor projects in the image — used to
 * keep the legacy xPct/yPct in sync with a (u,v) surface position. */
export function surfaceImagePoint(
  solved: RoomBoxView,
  surface: { kind: RoomSurfaceKind; u: number; v: number },
): Pt | null {
  return worldToImage(solved, surfaceToWorld(solved.box, surface.kind, surface.u, surface.v));
}

/** A sensible starting box for a fresh photo: back wall spanning the central
 * ~55% of the frame, front floor corners at the lower image corners. */
export function defaultRoomBoxCorners(): RoomBoxCorners {
  return {
    backTopLeft: { x: 0.24, y: 0.18 },
    backTopRight: { x: 0.76, y: 0.18 },
    backBottomLeft: { x: 0.24, y: 0.72 },
    backBottomRight: { x: 0.76, y: 0.72 },
    frontBottomLeft: { x: -0.08, y: 1.06 },
    frontBottomRight: { x: 1.08, y: 1.06 },
  };
}

/** Mount kind → which room surface a fixture attaches to by default. */
export function surfaceForMount(mount: string | undefined): RoomSurfaceKind {
  switch ((mount ?? "ceiling").toLowerCase()) {
    case "wall":
      return "wall-back";
    case "floor":
      return "floor";
    default: // ceiling / recessed / flush
      return "ceiling";
  }
}
