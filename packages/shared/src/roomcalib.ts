/**
 * Single-image room calibration from user-drawn edge lines (the "Cam Solve"
 * room-match step for the 3D App-Shot).
 *
 * The user traces a few edges of the room along its orthogonal axes (two
 * horizontal wall/ceiling/floor directions, optionally the verticals). Each axis
 * group is a bundle of parallel world lines, so its image lines meet at a
 * VANISHING POINT. Two orthogonal vanishing points recover the camera's focal
 * length and orientation (classic Hartley-Zisserman calibration), which tells us
 * the photo's true perspective — so a Blender render can place the camera + the
 * ceiling/wall/floor planes to match the photo and light them for real.
 *
 * Pure math, no DOM/Blender deps, so it lives here with tests and is shared by
 * the web drawing UI and any server consumer.
 *
 * Coordinate conventions (fixed + covered by the round-trip test):
 *  - Image points are normalized [0,1], origin top-left, y increasing DOWN.
 *  - We work in CENTERED, SQUARE-PIXEL coords: u = (nx-0.5)*aspect, v = ny-0.5,
 *    with aspect = imageWidth/imageHeight, principal point at the origin. Units
 *    are fractions of image height; focal length `f` is in the same units.
 *  - Camera frame: +x right, +y DOWN, +z forward (into the scene). A world
 *    direction D=(X,Y,Z) in camera coords projects to the vanishing point
 *    (f·X/Z, f·Y/Z), so the 3D ray toward a VP at (u,v) is (u, v, f).
 */

export interface Pt {
  /** Normalized image x (0..1, left→right). */
  x: number;
  /** Normalized image y (0..1, top→bottom). */
  y: number;
}

/** A drawn edge segment in normalized image coordinates. */
export interface Seg {
  a: Pt;
  b: Pt;
}

/**
 * Which orthogonal room axis a bundle of edges runs along. The two horizontals
 * are the room's floor-plane directions (e.g. left↔right wall run vs.
 * near↔far depth run); `vertical` is the up axis (wall corners, door jambs).
 */
export type RoomAxis = "horizontalA" | "horizontalB" | "vertical";

export interface AxisLines {
  axis: RoomAxis;
  /** ≥1 segment; ≥2 gives a robust least-squares vanishing point. */
  lines: Seg[];
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A vanishing point in centered square-pixel coords, or a direction if at ∞. */
export interface Vanishing {
  /** Finite VP location (centered coords), null when the axis is parallel (VP at ∞). */
  point: { u: number; v: number } | null;
  /** Unit image direction of the axis (always set); the VP "at infinity" direction. */
  dir: { u: number; v: number };
  atInfinity: boolean;
}

export interface RoomCalibration {
  ok: boolean;
  /** Why calibration failed (degenerate lines / non-orthogonal axes), when !ok. */
  reason?: string;
  /** Camera field of view along the LARGER image dimension, in degrees (Blender's
   * `camera.angle` convention). */
  fovDeg: number;
  /** Focal length in image-height-fraction units (centered-coord space). */
  focal: number;
  /** Camera basis expressed in WORLD/room coordinates (camera-to-world). Blender
   * builds the matched camera from these: it looks along `forward`, `up` is up. */
  cameraBasis: { right: Vec3; up: Vec3; forward: Vec3 };
  /** The room's vertical (ceiling/floor normal) in world coords — here, (0,0,1). */
  worldUp: Vec3;
  /** Recovered vanishing points (image-space), for the live overlay. */
  vanishing: Partial<Record<RoomAxis, Vanishing>>;
}

// --- small vector helpers -------------------------------------------------

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function norm(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}
function normalize(a: Vec3): Vec3 {
  const n = norm(a) || 1;
  return { x: a.x / n, y: a.y / n, z: a.z / n };
}
function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/** Normalized (nx,ny) → centered square-pixel coords (u right, v down). */
function toCentered(p: Pt, aspect: number): { u: number; v: number } {
  return { u: (p.x - 0.5) * aspect, v: p.y - 0.5 };
}

/**
 * Least-squares vanishing point of a bundle of parallel edges. Each segment
 * gives a homogeneous line a·u + b·v + c = 0 (a²+b²=1). We minimise
 * Σ(a·u+b·v+c)² over the finite point (u,v) via the 2×2 normal equations; a
 * near-singular system means the lines are parallel in the image → the VP is at
 * infinity and we return its direction instead.
 */
export function vanishingPoint(lines: Seg[], aspect: number): Vanishing {
  let Saa = 0,
    Sab = 0,
    Sbb = 0,
    Sac = 0,
    Sbc = 0;
  let dirU = 0,
    dirV = 0;
  for (const seg of lines) {
    const a = toCentered(seg.a, aspect);
    const b = toCentered(seg.b, aspect);
    // Line through a,b as [A,B,C] with A²+B²=1.
    let A = a.v - b.v;
    let B = b.u - a.u;
    const len = Math.hypot(A, B) || 1;
    A /= len;
    B /= len;
    const C = -(A * a.u + B * a.v);
    Saa += A * A;
    Sab += A * B;
    Sbb += B * B;
    Sac += A * C;
    Sbc += B * C;
    // Accumulate edge direction (perpendicular to the line normal), sign-folded
    // so opposing segments don't cancel.
    let du = b.u - a.u;
    let dv = b.v - a.v;
    const dl = Math.hypot(du, dv) || 1;
    du /= dl;
    dv /= dl;
    if (du < 0 || (du === 0 && dv < 0)) {
      du = -du;
      dv = -dv;
    }
    dirU += du;
    dirV += dv;
  }
  const dl = Math.hypot(dirU, dirV) || 1;
  const dir = { u: dirU / dl, v: dirV / dl };

  const det = Saa * Sbb - Sab * Sab;
  // Condition the determinant against the matrix scale so a faint-but-real
  // intersection isn't mistaken for parallel.
  const scaleTr = Saa + Sbb || 1;
  if (Math.abs(det) < 1e-9 * scaleTr * scaleTr) {
    return { point: null, dir, atInfinity: true };
  }
  const u = (Sab * Sbc - Sbb * Sac) / det;
  const v = (Sab * Sac - Saa * Sbc) / det;
  return { point: { u, v }, dir, atInfinity: false };
}

/** Camera-frame ray (x right, y down, z forward) toward a finite VP. */
function vpRay(vp: { u: number; v: number }, f: number): Vec3 {
  return normalize({ x: vp.u, y: vp.v, z: f });
}

/**
 * Solve the camera from the drawn room edges. Needs at least two axes with
 * FINITE vanishing points (the usual case: the two horizontal room directions —
 * verticals are commonly parallel/at-∞ for a level camera and only refine the
 * up axis). Returns `ok:false` with a reason for degenerate / non-orthogonal
 * input rather than throwing, so the UI can prompt the user to redraw.
 */
export function solveRoomCalibration(
  axes: AxisLines[],
  aspect: number,
): RoomCalibration {
  const fail = (reason: string): RoomCalibration => ({
    ok: false,
    reason,
    fovDeg: 0,
    focal: 0,
    cameraBasis: {
      right: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      forward: { x: 0, y: 1, z: 0 },
    },
    worldUp: { x: 0, y: 0, z: 1 },
    vanishing: {},
  });

  const vps: Partial<Record<RoomAxis, Vanishing>> = {};
  for (const group of axes) {
    if (group.lines.length >= 1) {
      vps[group.axis] = vanishingPoint(group.lines, aspect);
    }
  }

  const finite = (["horizontalA", "horizontalB", "vertical"] as RoomAxis[])
    .map((ax) => ({ ax, vp: vps[ax] }))
    .filter((e): e is { ax: RoomAxis; vp: Vanishing } => !!e.vp && !e.vp.atInfinity);

  if (finite.length < 2) {
    return fail(
      "need at least two room axes with converging (non-parallel) edge lines",
    );
  }

  // Focal length from the most-orthogonal finite VP pair: for two orthogonal
  // world axes, f² = −(vpA · vpB) in centered coords (square pixels, principal
  // point at centre). Picking the most-orthogonal pair maximises conditioning.
  let bestF2 = -Infinity;
  for (let i = 0; i < finite.length; i++) {
    for (let j = i + 1; j < finite.length; j++) {
      const va = finite[i]!.vp.point!;
      const vb = finite[j]!.vp.point!;
      bestF2 = Math.max(bestF2, -(va.u * vb.u + va.v * vb.v));
    }
  }
  if (bestF2 <= 1e-6) {
    return fail(
      "the drawn axes are not perpendicular enough to recover the camera",
    );
  }

  const f = Math.sqrt(bestF2);

  // Camera-frame rays toward each available (finite) axis VP.
  const ray = (ax: RoomAxis): Vec3 | null => {
    const vp = vps[ax];
    return vp && !vp.atInfinity ? vpRay(vp.point!, f) : null;
  };
  const dHA = ray("horizontalA");
  const dHB = ray("horizontalB");
  const dV = ray("vertical");

  // WORLD UP (ceiling/floor normal). Use the user's `vertical` axis when it has a
  // finite VP; otherwise it's the cross of the two horizontal floor directions.
  // (Never the cross of a horizontal+vertical pair, which would mislabel up.)
  let upCam = dV ?? (dHA && dHB ? normalize(cross(dHA, dHB)) : null);
  const hRef = dHA ?? dHB; // a horizontal reference direction for the floor frame
  if (!upCam || !hRef) {
    return fail(
      "draw the two horizontal floor directions (or one horizontal + the verticals)",
    );
  }
  // Orient world-up to point UP on screen (camera +y is down, so up has y<0).
  if (upCam.y > 0) upCam = scale(upCam, -1);

  // Orthonormal, right-handed world basis in camera coords, with Z = up.
  const Z = upCam;
  let X = sub(hRef, scale(Z, dot(hRef, Z))); // horizontal ⟂ up
  if (norm(X) < 1e-6) {
    return fail("the horizontal and vertical directions are too close to separate");
  }
  X = normalize(X);
  const Y = cross(Z, X); // right-handed: X × Y = Z

  // Columns [X,Y,Z] are the world axes in camera coords (R_cw, world→camera).
  // Camera axis e_k in world coords = row k of R_cw, giving camera right/up/
  // forward in WORLD coords (what Blender builds the matched camera from).
  const right: Vec3 = { x: X.x, y: Y.x, z: Z.x }; // camera +x (right) in world
  const downCam: Vec3 = { x: X.y, y: Y.y, z: Z.y }; // camera +y (down) in world
  const forward: Vec3 = { x: X.z, y: Y.z, z: Z.z }; // camera +z (forward) in world
  const up = scale(downCam, -1); // world-space camera up

  // FOV along the larger image dimension (Blender camera.angle convention).
  const halfLarger = aspect >= 1 ? aspect / 2 : 0.5;
  const fovDeg = (2 * Math.atan(halfLarger / f) * 180) / Math.PI;

  return {
    ok: true,
    fovDeg,
    focal: f,
    cameraBasis: {
      right: normalize(right),
      up: normalize(up),
      forward: normalize(forward),
    },
    worldUp: { x: 0, y: 0, z: 1 },
    vanishing: vps,
  };
}
