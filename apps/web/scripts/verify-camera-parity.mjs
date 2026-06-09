// One-off parity check: does the live three.js preview camera (FixtureScene)
// project a fixture to the SAME screen coordinates as the Blender render
// (render.py place_camera + composite.py offset)?
//
// We independently reimplement the Blender projection (Z-up, FOV along the larger
// sensor dim, roll quaternion, perpendicular xPct/yPct offset) and compare it to
// the ACTUAL three.js PerspectiveCamera configured exactly like FixtureScene.
// Matching NDC for asymmetric points proves: same size, same position, same roll,
// and crucially NO horizontal mirror.
//
// Run from apps/web:  node scripts/verify-camera-parity.mjs

import * as THREE from "three";

const DEG = Math.PI / 180;

// Blender (x,y,z) Z-up  ->  three (x, z, -y) Y-up  (matches export_yup=True).
const b2t = (p) => new THREE.Vector3(p[0], p[2], -p[1]);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

// ---- Ground truth: Blender render.py place_camera + composite.py offset ------
function blenderProject(P, prm) {
  const az = prm.azimuthDeg * DEG;
  const el = prm.elevationDeg * DEG;
  const roll = prm.rollDeg * DEG;
  const fov = prm.fovDeg * DEG;
  const df = prm.distanceFactor ?? 1;
  const margin = 1 / Math.max(prm.coverage, 0.05);
  const D = (prm.radius / Math.sin(fov / 2)) * margin * df;

  const dir = [
    Math.cos(el) * Math.sin(az),
    -Math.cos(el) * Math.cos(az),
    Math.sin(el),
  ];
  const camLoc = [
    prm.center[0] + dir[0] * D,
    prm.center[1] + dir[1] * D,
    prm.center[2] + dir[2] * D,
  ];

  // to_track_quat("-Z","Y") with world up +Z (gluLookAt-style basis).
  const zAxis = norm(sub(camLoc, prm.center)); // camera +Z (points backward)
  let xAxis = norm(cross([0, 0, 1], zAxis)); // camera +X (right)
  let yAxis = cross(zAxis, xAxis); // camera +Y (up)

  // Roll about local +Z by -roll (render.py: quat @ Quaternion((0,0,1), -roll)).
  const t = -roll;
  const ct = Math.cos(t);
  const st = Math.sin(t);
  const xr = [
    xAxis[0] * ct + yAxis[0] * st,
    xAxis[1] * ct + yAxis[1] * st,
    xAxis[2] * ct + yAxis[2] * st,
  ];
  const yr = [
    -xAxis[0] * st + yAxis[0] * ct,
    -xAxis[1] * st + yAxis[1] * ct,
    -xAxis[2] * st + yAxis[2] * ct,
  ];
  xAxis = xr;
  yAxis = yr;

  // composite.py fixture offset (depth from ORIGINAL center, FOV along larger dim).
  const forward = [-zAxis[0], -zAxis[1], -zAxis[2]];
  const depth = dot(sub(prm.center, camLoc), forward);
  let halfW;
  let halfH;
  if (prm.aspect >= 1) {
    halfW = Math.tan(fov / 2) * depth;
    halfH = halfW / prm.aspect;
  } else {
    halfH = Math.tan(fov / 2) * depth;
    halfW = halfH * prm.aspect;
  }
  const sx = (prm.xPct - 0.5) * 2 * halfW;
  const sy = (0.5 - prm.yPct) * 2 * halfH;
  const offset = [
    xAxis[0] * sx + yAxis[0] * sy,
    xAxis[1] * sx + yAxis[1] * sy,
    xAxis[2] * sx + yAxis[2] * sy,
  ];

  const Pw = [P[0] + offset[0], P[1] + offset[1], P[2] + offset[2]];
  const rel = sub(Pw, camLoc);
  const vx = dot(rel, xAxis);
  const vy = dot(rel, yAxis);
  const camDepth = -dot(rel, zAxis); // distance in front of the camera

  let tanX;
  let tanY;
  if (prm.aspect >= 1) {
    tanX = Math.tan(fov / 2);
    tanY = Math.tan(fov / 2) / prm.aspect;
  } else {
    tanY = Math.tan(fov / 2);
    tanX = Math.tan(fov / 2) * prm.aspect;
  }
  return { x: vx / camDepth / tanX, y: vy / camDepth / tanY };
}

// ---- Candidate: the EXACT three.js camera from FixtureScene.update ------------
function threeProject(P, prm) {
  const az = prm.azimuthDeg * DEG;
  const el = prm.elevationDeg * DEG;
  const roll = prm.rollDeg * DEG;
  const fov = prm.fovDeg * DEG;
  const df = prm.distanceFactor ?? 1;
  const margin = 1 / Math.max(prm.coverage, 0.05);
  const D = (prm.radius / Math.sin(fov / 2)) * margin * df;

  const centerT = b2t(prm.center);
  const dirT = new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az),
  );
  const camPos = centerT.clone().add(dirT.multiplyScalar(D));
  const cam = new THREE.PerspectiveCamera(35, 1, 0.001, 1e6);
  cam.position.copy(camPos);
  cam.up.set(0, 1, 0);
  cam.lookAt(centerT);
  cam.rotateZ(-roll);
  cam.fov =
    prm.aspect >= 1
      ? (Math.atan(Math.tan(fov / 2) / prm.aspect) * 2) / DEG
      : prm.fovDeg;
  cam.aspect = prm.aspect;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);

  const e = cam.matrixWorld.elements;
  const right = new THREE.Vector3(e[0], e[1], e[2]).normalize();
  const up = new THREE.Vector3(e[4], e[5], e[6]).normalize();
  const fwd = new THREE.Vector3(-e[8], -e[9], -e[10]).normalize();
  const depth = centerT.clone().sub(camPos).dot(fwd);
  let halfW;
  let halfH;
  if (prm.aspect >= 1) {
    halfW = Math.tan(fov / 2) * depth;
    halfH = halfW / prm.aspect;
  } else {
    halfH = Math.tan(fov / 2) * depth;
    halfW = halfH * prm.aspect;
  }
  const offsetT = right
    .multiplyScalar((prm.xPct - 0.5) * 2 * halfW)
    .add(up.multiplyScalar((0.5 - prm.yPct) * 2 * halfH));

  const ndc = b2t(P).add(offsetT).project(cam);
  return { x: ndc.x, y: ndc.y };
}

// ---- cases --------------------------------------------------------------------
const center = [0.3, -0.2, 1.1]; // arbitrary off-origin fixture center
const radius = 0.85;
// Deliberately asymmetric marker points (a mirror would flip the X sign).
const markers = {
  "+X arm": [center[0] + 0.6, center[1], center[2]],
  "-X arm": [center[0] - 0.6, center[1], center[2]],
  "top": [center[0], center[1], center[2] + 0.6],
  "front": [center[0], center[1] - 0.6, center[2]],
};

const poses = [
  { name: "screenshot pose", azimuthDeg: 0, elevationDeg: -29, rollDeg: 24, fovDeg: 24, coverage: 0.3, xPct: 0.5, yPct: 0.25, aspect: 1024 / 554 },
  { name: "small + off-center", azimuthDeg: 35, elevationDeg: 10, rollDeg: -15, fovDeg: 50, coverage: 0.08, xPct: 0.2, yPct: 0.7, aspect: 1.6 },
  { name: "rotated + portrait", azimuthDeg: -120, elevationDeg: 40, rollDeg: 30, fovDeg: 32, coverage: 0.5, xPct: 0.8, yPct: 0.35, aspect: 0.75 },
  { name: "extreme roll", azimuthDeg: 90, elevationDeg: -10, rollDeg: 45, fovDeg: 15, coverage: 0.9, xPct: 0.5, yPct: 0.5, aspect: 1.85 },
];

let maxErr = 0;
let mirrorOk = true;
for (const pose of poses) {
  const prm = { ...pose, center, radius };
  console.log(`\n# ${pose.name}`);
  for (const [label, P] of Object.entries(markers)) {
    const b = blenderProject(P, prm);
    const t = threeProject(P, prm);
    const ex = Math.abs(b.x - t.x);
    const ey = Math.abs(b.y - t.y);
    maxErr = Math.max(maxErr, ex, ey);
    // sign of X must agree (mirror guard) when meaningfully off-center
    if (Math.abs(b.x) > 0.02 && Math.sign(b.x) !== Math.sign(t.x)) mirrorOk = false;
    console.log(
      `  ${label.padEnd(7)} blender=(${b.x.toFixed(4)}, ${b.y.toFixed(4)})  three=(${t.x.toFixed(4)}, ${t.y.toFixed(4)})  d=(${ex.toExponential(1)}, ${ey.toExponential(1)})`,
    );
  }
}

console.log(`\nmax NDC error: ${maxErr.toExponential(2)}`);
console.log(`X-sign (mirror) agreement: ${mirrorOk ? "OK" : "FAILED"}`);
const pass = maxErr < 1e-3 && mirrorOk;
console.log(pass ? "\nPARITY OK — preview matches render" : "\nPARITY MISMATCH");
process.exit(pass ? 0 : 1);
