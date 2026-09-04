import * as THREE from "three";
import { loadNubCat } from "./nubcat";
import type { Collider } from "./collision";

export type ViewMode = "first" | "third";

export const BOOM_DIST = 3.6;
export const BOOM_UP = 1.1;
export const BOOM_MIN = 1.2;

export type Vec3Like = { x: number; y: number; z: number };

function hitsArchitecture(
  x: number,
  y: number,
  z: number,
  eyeY: number,
  boxes: Collider[],
  radius: number,
): boolean {
  for (const box of boxes) {
    if (box.max[1] <= eyeY - 1.6) continue; // floor slabs far below the boom
    const cx = Math.max(box.min[0], Math.min(x, box.max[0]));
    const cy = Math.max(box.min[1], Math.min(y, box.max[1]));
    const cz = Math.max(box.min[2], Math.min(z, box.max[2]));
    if (Math.hypot(x - cx, y - cy, z - cz) < radius) return true;
  }
  return false;
}

/**
 * Pure boom solver: how far along `dir` (3D unit, from the eye) the third-person
 * camera may travel before it would clip into architecture — walls AND ceilings.
 * Sampled in fourteen steps so thin door frames and ceiling slabs still catch it.
 * The first step is forgiven so hugging a wall doesn't collapse the boom.
 */
export function solveBoom(
  eye: Vec3Like,
  dir: Vec3Like,
  maxDist: number,
  boxes: Collider[],
  radius = 0.25,
): number {
  const steps = 14;
  let allowed = maxDist;
  for (let i = 2; i <= steps; i++) {
    const t = (i / steps) * maxDist;
    const x = eye.x + dir.x * t;
    const y = eye.y + dir.y * t;
    const z = eye.z + dir.z * t;
    if (hitsArchitecture(x, y, z, eye.y, boxes, radius)) {
      allowed = ((i - 1) / steps) * maxDist;
      break;
    }
  }
  return Math.max(BOOM_MIN * 0.5, allowed);
}

/**
 * Third-person rig using the render-offset pattern (same trick as CameraMotion):
 * the simulation always sees the eye-position camera, and apply()/restore()
 * bracket only the render + VHS capture. Zero changes to movement, collision,
 * alarm raycasts, entity senses, or the exploration map.
 */
export class ThirdPersonRig {
  mode: ViewMode = "first";
  error: string | null = null;
  private avatar: THREE.Group | null = null;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private savedPos = new THREE.Vector3();
  private savedQuat = new THREE.Quaternion();
  private applied = false;
  private bob = 0;
  private eye = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private look = new THREE.Vector3();
  private boomEnd = new THREE.Vector3();
  private boomDir = new THREE.Vector3();
  private up = new THREE.Vector3();
  private mixer: THREE.AnimationMixer | null = null;

  constructor(private getEyeHeight: () => number) {}

  /** The actual OpenClawWorld player avatar — original materials, player scale. */
  load(scene: THREE.Scene): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = loadNubCat()
      .then(({ model, clips }) => {
        this.avatar = new THREE.Group();
        // Normalize the avatar against the 1.65m eye. Use TRUE height (Y),
        // not the longest axis: the nakedNUB quadruped is 2.2m wide but
        // 1.5m tall, and max-axis normalization shrank it to a 0.38m sliver.
        // Target ~0.9m at the shoulder so it reads against the 1.65m eye.
        const bounds = new THREE.Box3().setFromObject(model, true);
        const size = bounds.getSize(new THREE.Vector3());
        const height = Math.max(0.1, size.y);
        const inner = new THREE.Group();
        inner.add(model);
        inner.scale.setScalar(0.9 / height);
        // Re-seat the normalized model so its feet sit at group origin.
        inner.position.y = -bounds.min.y * (0.9 / height);
        this.avatar.add(inner);
        this.avatar.traverse((node) => {
          if (node instanceof THREE.Mesh) node.castShadow = false;
        });
        if (clips.length) {
          this.mixer = new THREE.AnimationMixer(model);
          const walk = this.mixer.clipAction(clips[0]);
          walk.play();
        }
        this.avatar.visible = false;
        scene.add(this.avatar);
        this.loaded = true;
        this.error = null;
      })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : "Avatar model unavailable.";
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  toggle(): ViewMode {
    this.mode = this.mode === "first" ? "third" : "first";
    if (this.avatar) this.avatar.visible = this.mode === "third" && this.loaded;
    return this.mode;
  }

  /** Track the eye while the camera is still in simulation state. */
  update(dt: number, camera: THREE.PerspectiveCamera, speed: number) {
    if (!this.avatar || !this.loaded) return;
    this.avatar.visible = this.mode === "third";
    if (this.mode !== "third") return;
    // Baked walk loop follows stride speed; idles when standing.
    this.mixer?.update(speed > 0.2 ? dt * (0.5 + speed * 0.45) : 0);
    const feet = camera.position.y - this.getEyeHeight();
    this.avatar.position.set(camera.position.x, feet, camera.position.z);
    camera.getWorldDirection(this.look);
    this.avatar.rotation.y = Math.atan2(this.look.x, this.look.z);
    if (speed > 0.2) {
      this.bob += dt * (4 + speed * 1.6);
      this.avatar.position.y = feet + Math.abs(Math.sin(this.bob)) * 0.07;
      this.avatar.rotation.z = Math.sin(this.bob) * 0.04;
      this.avatar.rotation.x = -0.06; // lean into the walk, camcorder in hand
    } else {
      this.avatar.rotation.x = 0;
      this.avatar.rotation.z *= 0.9;
      this.avatar.position.y = feet + Math.sin(performance.now() / 900) * 0.015;
    }
  }

  /** Move the render camera onto the boom. Call after motion.apply(). */
  apply(camera: THREE.PerspectiveCamera, boxes: Collider[]) {
    if (this.mode !== "third" || this.applied) return;
    this.savedPos.copy(camera.position);
    this.savedQuat.copy(camera.quaternion);
    this.applied = true;
    this.eye.copy(camera.position);
    camera.getWorldDirection(this.dir);
    this.dir.y = 0;
    if (this.dir.lengthSq() < 1e-6) this.dir.set(0, 0, -1);
    this.dir.normalize();
    // Boom end: behind the head, above it.
    this.boomEnd
      .copy(this.eye)
      .addScaledVector(this.dir, -BOOM_DIST);
    this.up.set(0, BOOM_UP, 0);
    this.boomEnd.add(this.up);
    this.boomDir.copy(this.boomEnd).sub(this.eye);
    const len = this.boomDir.length();
    this.boomDir.normalize();
    const allowed = Math.min(len, solveBoom(this.eye, this.boomDir, len, boxes));
    camera.position.copy(this.eye).addScaledVector(this.boomDir, allowed);
    camera.lookAt(this.eye.x, this.eye.y - 0.25, this.eye.z);
  }

  /** Put the simulation camera back. Call before motion.restore(). */
  restore(camera: THREE.PerspectiveCamera) {
    if (!this.applied) return;
    camera.position.copy(this.savedPos);
    camera.quaternion.copy(this.savedQuat);
    this.applied = false;
  }

  get diagnostics() {
    return { mode: this.mode, loaded: this.loaded, error: this.error };
  }
}
