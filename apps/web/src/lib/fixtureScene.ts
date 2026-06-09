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
    const el = (u.pose.elevationDeg ?? 0) * DEG2RAD;
    const roll = (u.pose.rollDeg ?? 0) * DEG2RAD;
    const fovDeg = u.pose.fovDeg ?? 35;
    const fovRad = fovDeg * DEG2RAD;
    const df = u.pose.distanceFactor ?? 1;
    const cov = Math.max(u.coverage, 0.05);
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

function disposeObject(o: THREE.Object3D) {
  const mesh = o as THREE.Mesh;
  if (mesh.geometry) mesh.geometry.dispose();
  const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
  else if (mat) mat.dispose();
}
