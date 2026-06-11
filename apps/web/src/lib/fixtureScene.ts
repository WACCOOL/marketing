import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * Live placement preview that reproduces the Blender render's geometry EXACTLY.
 *
 * The fixture GLB (exported Y-up, Draco-compressed by export_fixture.py) is shown
 * through a three.js camera configured to match `place_camera` (render.py) and the
 * fixture screen offset to match `composite.py`. Because the camera pose, FOV
 * convention, roll, distance (= radius / sin(fov/2) / coverage), and the
 * perpendicular xPct/yPct offset are all replicated 1:1, the preview frames the
 * fixture at the same size/position/angle the Test render will. Only light and
 * materials differ — that is what the Test render adds.
 *
 * Coordinate bridge: Blender is Z-up, glTF/three is Y-up. The GLB was exported
 * with `export_yup=True`, so a Blender world vector (x, y, z) appears in three as
 * (x, z, -y). That mapping is a pure rotation (det +1), so it introduces NO mirror
 * — every Blender axis just lands on a three axis.
 */

export interface FixturePose {
  azimuthDeg?: number;
  elevationDeg?: number;
  rollDeg?: number;
  fovDeg?: number;
  distanceFactor?: number;
}

export interface FixtureUpdate {
  pose: FixturePose;
  /** Fixture size as a fraction of the frame (drives camera distance). */
  coverage: number;
  /** Horizontal screen position of the fixture center (0 = left, 1 = right). */
  xPct: number;
  /** Vertical screen position of the fixture center (0 = top, 1 = bottom). */
  yPct: number;
  /** Room aspect (width / height) — the render is framed at this aspect. */
  aspect: number;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// Google-hosted Draco decoder (the GLB is Draco-compressed). Shared across loads.
let sharedDraco: DRACOLoader | null = null;
function dracoLoader(): DRACOLoader {
  if (!sharedDraco) {
    sharedDraco = new DRACOLoader();
    sharedDraco.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");
  }
  return sharedDraco;
}

export class FixtureScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private modelGroup: THREE.Group;
  private model: THREE.Object3D | null = null;
  /** Fixture bounding-box center in three space (camera always aims here). */
  private center = new THREE.Vector3();
  /** Bounding-sphere radius (half the AABB diagonal), matching world_bounding_box. */
  private radius = 1;
  private envTexture: THREE.Texture | null = null;
  private loadToken = 0;
  private last: FixtureUpdate | null = null;
  private width = 0;
  private height = 0;

  /**
   * @param opts.preserveDrawingBuffer keep the drawing buffer readable after a
   *   render so `canvas.toDataURL()` works — used by the offline thumbnail baker
   *   (apps/fixture-sync), which renders one frame then reads it back. The live
   *   editor leaves it off (the default) to avoid the small per-frame cost.
   */
  constructor(
    canvas: HTMLCanvasElement,
    opts: { preserveDrawingBuffer?: boolean } = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTexture;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);
  }

  /** Resize the drawing buffer to the room overlay's pixel size. */
  setSize(width: number, height: number) {
    if (width <= 0 || height <= 0) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    if (this.last) this.update(this.last);
  }

  /** Load (or swap) the fixture GLB. Returns its dimensions, or null if superseded. */
  async loadModel(
    url: string,
  ): Promise<{ x: number; y: number; z: number } | null> {
    const token = ++this.loadToken;
    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader());
    const gltf = await loader.loadAsync(url);
    if (token !== this.loadToken) {
      // A newer load started while this one was in flight — discard.
      gltf.scene.traverse((o) => disposeObject(o));
      return null;
    }
    this.clearModel();
    this.model = gltf.scene;
    this.modelGroup.position.set(0, 0, 0);
    this.modelGroup.add(this.model);

    const box = new THREE.Box3().setFromObject(this.model);
    const size = box.getSize(new THREE.Vector3());
    box.getCenter(this.center);
    this.radius = Math.max(size.length() / 2, 1e-4);

    if (this.last) this.update(this.last);
    return { x: size.x, y: size.y, z: size.z };
  }

  private clearModel() {
    if (!this.model) return;
    this.modelGroup.remove(this.model);
    this.model.traverse((o) => disposeObject(o));
    this.model = null;
  }

  /** Position the camera + fixture for the given pose/placement and draw. */
  update(u: FixtureUpdate) {
    this.last = u;
    if (!this.model || this.width <= 0 || this.height <= 0) return;

    const az = (u.pose.azimuthDeg ?? 0) * DEG2RAD;
    // At exactly ±90° the view is parallel to the up hint and the lookAt roll is
    // arbitrary (same singularity as Blender's to_track_quat) — nudge just off
    // the pole so both engines resolve the same orientation. Mirrors place_camera.
    let elDeg = u.pose.elevationDeg ?? 0;
    if (Math.abs(Math.abs(elDeg) - 90) < 0.05) {
      elDeg = Math.sign(elDeg) * (90 - 0.05);
    }
    const el = elDeg * DEG2RAD;
    const roll = (u.pose.rollDeg ?? 0) * DEG2RAD;
    const fovDeg = u.pose.fovDeg ?? 35;
    const fovRad = fovDeg * DEG2RAD;
    const df = u.pose.distanceFactor ?? 1;
    const cov = Math.max(u.coverage, 0.01);
    const margin = 1 / cov; // composite.py forces marginFactor = 1 / coverage
    const aspect = Math.max(u.aspect, 0.01);

    // Camera distance so the bounding sphere fits the FOV (render.py place_camera).
    const D = (this.radius / Math.sin(fovRad / 2)) * margin * df;

    // Blender Z-up direction -> three Y-up via (x, y, z) -> (x, z, -y).
    const dirT = new THREE.Vector3(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az),
    );
    const camPos = this.center.clone().add(dirT.multiplyScalar(D));
    this.camera.position.copy(camPos);
    this.camera.up.set(0, 1, 0); // Blender world +Z is three +Y
    this.camera.lookAt(this.center);
    // Roll about the view axis: matches `quat @ Quaternion((0,0,1), -roll)`.
    this.camera.rotateZ(-roll);

    // three's `fov` is the vertical FOV; Blender's cam.angle is along the LARGER
    // sensor dimension (see frustum_half in composite.py). Convert accordingly.
    const vfovDeg =
      aspect >= 1
        ? Math.atan(Math.tan(fovRad / 2) / aspect) * 2 * RAD2DEG
        : fovDeg;
    this.camera.fov = vfovDeg;
    this.camera.aspect = aspect;
    this.camera.near = Math.max(D * 0.005, 0.001);
    this.camera.far = D * 8 + this.radius * 12;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    // Fixture screen offset (composite.py): translate the fixture perpendicular to
    // the view so its center projects to (xPct, yPct), measured against the same
    // half-extents the render uses at the fixture's depth.
    const e = this.camera.matrixWorld.elements;
    const right = new THREE.Vector3(e[0], e[1], e[2]).normalize();
    const up = new THREE.Vector3(e[4], e[5], e[6]).normalize();
    const fwd = new THREE.Vector3(-e[8], -e[9], -e[10]).normalize();
    const depth = this.center.clone().sub(camPos).dot(fwd);
    let halfW: number;
    let halfH: number;
    if (aspect >= 1) {
      halfW = Math.tan(fovRad / 2) * depth;
      halfH = halfW / aspect;
    } else {
      halfH = Math.tan(fovRad / 2) * depth;
      halfW = halfH * aspect;
    }
    const offset = right
      .multiplyScalar((u.xPct - 0.5) * 2 * halfW)
      .add(up.multiplyScalar((0.5 - u.yPct) * 2 * halfH));
    this.modelGroup.position.copy(offset);

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.clearModel();
    if (this.envTexture) this.envTexture.dispose();
    this.renderer.dispose();
  }
}

/** One placed fixture inside a MultiFixtureScene update. */
export interface FixtureInstanceUpdate {
  id: string;
  pose: FixturePose;
  coverage: number;
  xPct: number;
  yPct: number;
}

export interface MultiSceneUpdate {
  /** Placed fixtures (only instances whose GLB has loaded are drawn). */
  instances: FixtureInstanceUpdate[];
  /** Drives the shared camera's FOV/distance (falls back to the first instance). */
  selectedId: string | null;
  /** Room aspect (width / height) — the render is framed at this aspect. */
  aspect: number;
}

/**
 * Multi-fixture live preview with ONE shared, fixed camera.
 *
 * In the render pipeline every fixture owns its own orbit camera (its pose IS a
 * camera orbit), so N fixtures cannot share one true camera. But viewing a model
 * from an orbiting camera is equivalent to viewing the INVERSE-rotated model
 * from a fixed camera — and since the room is a flat photo backdrop, that
 * conjugation is exactly how we show all fixtures at once: the camera sits at
 * (0, 0, D) looking at the origin, and each fixture group is rotated by the
 * inverse of its own orbit, scaled so it subtends `coverage` of the frame, and
 * offset so its center projects to (xPct, yPct).
 *
 * The one approximation versus the per-fixture renders: every fixture is drawn
 * through the SHARED camera's FOV/distance (the selected fixture's), so a
 * non-selected fixture's internal perspective/foreshortening is approximate.
 * Size, rotation and screen position are exact; Test/Final renders are always
 * exact. For a single fixture this reduces to the same image as FixtureScene.
 */
export class MultiFixtureScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private entries = new Map<
    string,
    { group: THREE.Group; model: THREE.Object3D; radius: number; token: number }
  >();
  private envTexture: THREE.Texture | null = null;
  private loadToken = 0;
  private last: MultiSceneUpdate | null = null;
  private width = 0;
  private height = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTexture;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  }

  setSize(width: number, height: number) {
    if (width <= 0 || height <= 0) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    if (this.last) this.update(this.last);
  }

  /** Load (or swap) the GLB for one placed fixture. */
  async loadModel(id: string, url: string): Promise<void> {
    const token = ++this.loadToken;
    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader());
    const gltf = await loader.loadAsync(url);
    const stale = this.entries.get(id);
    if (stale && stale.token > token) {
      // A newer load for this id finished first — discard this one.
      gltf.scene.traverse((o) => disposeObject(o));
      return;
    }
    if (stale) this.disposeEntry(stale);

    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // Center the model inside its group so the group origin == fixture center
    // (the orbit pivot, matching world_bounding_box in render.py).
    model.position.sub(center);
    const group = new THREE.Group();
    group.add(model);
    this.scene.add(group);
    this.entries.set(id, {
      group,
      model,
      radius: Math.max(size.length() / 2, 1e-4),
      token,
    });
    if (this.last) this.update(this.last);
  }

  /** Remove a placed fixture's model (fixture deleted from the layout). */
  removeModel(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.disposeEntry(entry);
    if (this.last) this.update(this.last);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  private disposeEntry(entry: { group: THREE.Group; model: THREE.Object3D }) {
    this.scene.remove(entry.group);
    entry.model.traverse((o) => disposeObject(o));
  }

  update(u: MultiSceneUpdate) {
    this.last = u;
    if (this.width <= 0 || this.height <= 0) return;

    const aspect = Math.max(u.aspect, 0.01);
    const shared =
      u.instances.find((i) => i.id === u.selectedId) ?? u.instances[0];
    if (!shared) return;

    // Shared camera: the selected fixture's FOV + orbit distance (so a single
    // fixture reproduces FixtureScene exactly — same conjugated math).
    const sharedEntry = this.entries.get(shared.id);
    const fovShDeg = shared.pose.fovDeg ?? 35;
    const fovShRad = fovShDeg * DEG2RAD;
    const D0 = sharedEntry
      ? this.orbitDistance(sharedEntry.radius, shared)
      : 1;

    this.camera.position.set(0, 0, D0);
    this.camera.quaternion.identity();
    this.camera.up.set(0, 1, 0);

    const vfovDeg =
      aspect >= 1
        ? Math.atan(Math.tan(fovShRad / 2) / aspect) * 2 * RAD2DEG
        : fovShDeg;
    this.camera.fov = vfovDeg;
    this.camera.aspect = aspect;

    // Frustum half-extents at the fixtures' depth (z = 0 plane), for the screen-
    // anchor offsets — identical math to the single-fixture scene.
    let halfW: number;
    let halfH: number;
    if (aspect >= 1) {
      halfW = Math.tan(fovShRad / 2) * D0;
      halfH = halfW / aspect;
    } else {
      halfH = Math.tan(fovShRad / 2) * D0;
      halfW = halfH * aspect;
    }

    let maxReach = 0;
    const dummy = new THREE.Object3D();
    for (const inst of u.instances) {
      const entry = this.entries.get(inst.id);
      if (!entry) continue;

      // Inverse-orbit rotation: the fixture appears exactly as its own orbit
      // camera would see it. Built the same way FixtureScene aims its camera
      // (position on the orbit sphere, lookAt center, roll about view axis).
      const az = (inst.pose.azimuthDeg ?? 0) * DEG2RAD;
      let elDeg = inst.pose.elevationDeg ?? 0;
      if (Math.abs(Math.abs(elDeg) - 90) < 0.05) {
        elDeg = Math.sign(elDeg) * (90 - 0.05);
      }
      const el = elDeg * DEG2RAD;
      const roll = (inst.pose.rollDeg ?? 0) * DEG2RAD;
      dummy.position.set(
        Math.cos(el) * Math.sin(az),
        Math.sin(el),
        Math.cos(el) * Math.cos(az),
      );
      dummy.up.set(0, 1, 0);
      dummy.lookAt(0, 0, 0);
      dummy.rotateZ(-roll);
      entry.group.quaternion.copy(dummy.quaternion).invert();

      // Scale so the fixture subtends the same fraction of the frame as it
      // would at its OWN orbit distance/FOV: s = (D0·tan(fovSh/2)) / (Di·tan(fovi/2)).
      const fovI = (inst.pose.fovDeg ?? 35) * DEG2RAD;
      const Di = this.orbitDistance(entry.radius, inst);
      const s =
        (D0 * Math.tan(fovShRad / 2)) /
        Math.max(Di * Math.tan(fovI / 2), 1e-6);
      entry.group.scale.setScalar(s);

      // Screen anchor: offset perpendicular to the (fixed) view so the fixture
      // center projects to (xPct, yPct).
      entry.group.position.set(
        (inst.xPct - 0.5) * 2 * halfW,
        (0.5 - inst.yPct) * 2 * halfH,
        0,
      );
      maxReach = Math.max(maxReach, entry.radius * s);
    }

    this.camera.near = Math.max(D0 * 0.005, 0.001);
    this.camera.far = D0 * 8 + maxReach * 12;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    this.renderer.render(this.scene, this.camera);
  }

  /** render.py place_camera distance: sphere fits the FOV, scaled by coverage. */
  private orbitDistance(radius: number, inst: FixtureInstanceUpdate): number {
    const fovRad = (inst.pose.fovDeg ?? 35) * DEG2RAD;
    const margin = 1 / Math.max(inst.coverage, 0.01);
    const df = inst.pose.distanceFactor ?? 1;
    return (radius / Math.sin(fovRad / 2)) * margin * df;
  }

  dispose() {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    if (this.envTexture) this.envTexture.dispose();
    this.renderer.dispose();
  }
}

function disposeObject(o: THREE.Object3D) {
  const mesh = o as THREE.Mesh;
  if (mesh.geometry) mesh.geometry.dispose();
  const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
  else if (mat) mat.dispose();
}
