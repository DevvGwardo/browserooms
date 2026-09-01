import * as THREE from "three";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";
import { movePlayer, type Collider } from "./collision";

export const WALK_STYLES = {
  reactive: { label: "Reactive", bob: 0.004, sway: 0.002, rotation: 0.0015, noise: 0.0008, inertia: 0.2 },
  off: { label: "Off", bob: 0, sway: 0, rotation: 0, noise: 0, inertia: 0 },
  smooth: { label: "Smooth", bob: 0.004, sway: 0.002, rotation: 0.0015, noise: 0.0008, inertia: 0.2 },
  natural: { label: "Natural", bob: 0.016, sway: 0.010, rotation: 0.004, noise: 0.0025, inertia: 0.6 },
  handheld: { label: "Handheld", bob: 0.022, sway: 0.014, rotation: 0.008, noise: 0.007, inertia: 1 },
  loose: { label: "Loose handheld", bob: 0.031, sway: 0.021, rotation: 0.012, noise: 0.014, inertia: 1.3 },
};
export const STAND_STYLES = {
  reactive: { label: "Reactive", breath: 0.004, drift: 0.0015, frequency: 0.28 },
  off: { label: "Off (tripod)", breath: 0, drift: 0, frequency: 0.3 },
  breathing: { label: "Breathing", breath: 0.004, drift: 0.0015, frequency: 0.28 },
  handheld: { label: "Handheld", breath: 0.006, drift: 0.007, frequency: 0.55 },
  uneasy: { label: "Uneasy", breath: 0.009, drift: 0.014, frequency: 0.8 },
};

export class CameraMotion {
  walking: keyof typeof WALK_STYLES;
  standing: keyof typeof STAND_STYLES;
  private noise = new ImprovedNoise();
  private time = 0;
  private noiseTime = 0;
  private blend = 0;
  private pace = 0;
  private gait = 0;
  private speed = 0;
  private previousYaw: number | null = null;
  private offset = new THREE.Vector3();
  private angles = new THREE.Vector3();
  private targetOffset = new THREE.Vector3();
  private targetAngles = new THREE.Vector3();
  private euler = new THREE.Euler(0, 0, 0, "YXZ");
  private rotation = new THREE.Quaternion();
  private basePosition = new THREE.Vector3();
  private baseRotation = new THREE.Quaternion();
  private worldOffset = new THREE.Vector3();
  private applied = false;
  private renderedPosition = new THREE.Vector3();
  private tension = 0;

  constructor(private camera: THREE.PerspectiveCamera, reducedMotion: boolean) {
    this.walking = reducedMotion ? "off" : "reactive";
    this.standing = reducedMotion ? "off" : "reactive";
    try {
      const saved = JSON.parse(localStorage.getItem("backrooms.camera-motion.v1") ?? "null");
      if (saved && Object.hasOwn(WALK_STYLES, saved.walking)) this.walking = saved.walking;
      if (saved && Object.hasOwn(STAND_STYLES, saved.standing)) this.standing = saved.standing;
    } catch { /* Saved preferences are optional. */ }
  }

  select(kind: "walking" | "standing", value: string) {
    if (kind === "walking" && Object.hasOwn(WALK_STYLES, value)) this.walking = value as keyof typeof WALK_STYLES;
    if (kind === "standing" && Object.hasOwn(STAND_STYLES, value)) this.standing = value as keyof typeof STAND_STYLES;
    try { localStorage.setItem("backrooms.camera-motion.v1", JSON.stringify({ walking: this.walking, standing: this.standing })); } catch { /* Storage may be disabled. */ }
  }

  update(seconds: number, speed: number, phase: number, steps: number, enabled: boolean, tension = 0) {
    const dt = Math.max(0.001, Math.min(seconds, 0.1));
    const yaw = this.camera.rotation.y;
    const yawChange = this.previousYaw === null ? 0 : Math.atan2(Math.sin(yaw - this.previousYaw), Math.cos(yaw - this.previousYaw));
    this.previousYaw = yaw;
    if (!enabled) { this.reset(); return; }
    this.tension = THREE.MathUtils.clamp(tension, 0, 1);
    this.time += dt;
    const moving = speed > 0.22;
    this.blend = THREE.MathUtils.damp(this.blend, moving ? 1 : 0, moving ? 9 : 6, dt);
    this.pace = THREE.MathUtils.damp(this.pace, Math.min(speed / 2.15, 1.45), 8, dt);
    // The same phase and alternating steps drive the sounds, even when audio is muted.
    if (moving) this.gait = (steps + phase) * Math.PI;
    const acceleration = THREE.MathUtils.clamp((speed - this.speed) / dt, -6, 6);
    this.speed = speed;
    const walk = { ...WALK_STYLES[this.walking] };
    const stand = { ...STAND_STYLES[this.standing] };
    if (this.walking === "reactive") {
      for (const key of ["bob", "sway", "rotation", "noise", "inertia"] as const) {
        walk[key] = THREE.MathUtils.lerp(WALK_STYLES.smooth[key], WALK_STYLES.loose[key], this.tension);
      }
    }
    if (this.standing === "reactive") {
      for (const key of ["breath", "drift", "frequency"] as const) {
        stand[key] = THREE.MathUtils.lerp(STAND_STYLES.breathing[key], STAND_STYLES.uneasy[key], this.tension);
      }
    }
    const stride = Math.sin(this.gait);
    const wave = Math.cos(this.gait * 2);
    const abrupt = this.walking === "reactive" ? this.tension * 0.55 : 0;
    const impact = -(wave * (1 - abrupt) + (2 * Math.pow((wave + 1) / 2, 3) - 0.625) * abrupt);
    const weight = this.blend * this.pace;
    const idle = 1 - this.blend;
    const breath = Math.sin(this.time * Math.PI * 2 * 0.24);
    this.noiseTime += dt * (0.55 * this.blend + stand.frequency * idle);
    const t = this.noiseTime;
    const nx = this.noise.noise(t, 1.7, 9.2) + 0.18 * this.noise.noise(t * 3.1, 8.3, 2.4);
    const ny = this.noise.noise(4.1, t, 6.8);
    const nz = this.noise.noise(7.9, 3.2, t);
    const drift = walk.noise * weight + stand.drift * idle;
    this.targetOffset.set(
      walk.sway * stride * weight + nx * drift * 0.45,
      walk.bob * impact * weight + stand.breath * breath * idle + ny * drift * 0.35,
      Math.sin(this.gait * 2) * walk.bob * 0.18 * weight,
    );
    const zoomDamping = 1 / Math.pow(this.camera.zoom, 0.7);
    this.targetAngles.set(
      walk.rotation * impact * weight + ny * drift + stand.breath * breath * 0.3 * idle - acceleration * walk.inertia * 0.001,
      nx * drift + walk.rotation * stride * weight * 0.22,
      -walk.rotation * stride * weight * 0.7 + nz * drift * 0.5 - THREE.MathUtils.clamp(yawChange / dt, -2, 2) * walk.inertia * this.blend * 0.004,
    ).multiplyScalar(zoomDamping);
    this.targetOffset.multiplyScalar(1 / Math.pow(this.camera.zoom, 0.25));
    const smoothing = 1 - Math.exp(-14 * dt);
    this.offset.lerp(this.targetOffset, smoothing);
    this.angles.lerp(this.targetAngles, smoothing);
    if (this.offset.lengthSq() < 1e-12) this.offset.set(0, 0, 0);
    if (this.angles.lengthSq() < 1e-12) this.angles.set(0, 0, 0);
  }

  apply(colliders: Collider[]) {
    this.basePosition.copy(this.camera.position);
    this.baseRotation.copy(this.camera.quaternion);
    this.worldOffset.copy(this.offset).applyQuaternion(this.baseRotation);
    const safe = movePlayer(this.basePosition, this.worldOffset.x, this.worldOffset.z, colliders);
    this.camera.position.set(safe.x, this.basePosition.y + this.worldOffset.y, safe.z);
    this.euler.set(this.angles.x, this.angles.y, this.angles.z, "YXZ");
    this.camera.quaternion.multiply(this.rotation.setFromEuler(this.euler));
    this.camera.updateMatrixWorld();
    this.renderedPosition.copy(this.camera.position);
    this.applied = true;
  }

  restore() {
    if (!this.applied) return;
    this.camera.position.copy(this.basePosition);
    this.camera.quaternion.copy(this.baseRotation);
    this.camera.updateMatrixWorld();
    this.applied = false;
  }

  reset() {
    this.restore();
    this.blend = 0; this.pace = 0; this.speed = 0; this.gait = 0;
    this.tension = 0;
    this.previousYaw = null;
    this.offset.set(0, 0, 0); this.angles.set(0, 0, 0);
  }

  get diagnostics() {
    return { walking: this.walking, standing: this.standing, moving: this.speed > 0.22, tension: this.tension,
      blend: this.blend, offset: this.offset.toArray(), rotation: this.angles.toArray(), renderedPosition: this.renderedPosition.toArray() };
  }
}
