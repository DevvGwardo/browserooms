import * as THREE from "three";
import type { AudioBus } from "./light-ambience";
import type { StreamedWorld } from "./streamed-world";
import type { Kit } from "./world-layout";
import { exitChunkCenter, resolveExitSpot, EXIT_CHUNK } from "./levels";

type Hum = { osc: OscillatorNode; gain: GainNode; pan: PannerNode };

/**
 * Glowing exit door placed in a fixed far chunk. Click it (or aim + F) within
 * reach to descend a level. Interaction and origin-shift handling mirror
 * DistantAlarm so both systems behave identically under the floating origin.
 */
export class ExitDoor {
  error: string | null = null;
  readonly root = new THREE.Group();
  private ray = new THREE.Raycaster();
  private hum: Hum | null = null;
  private pickCamera = new THREE.PerspectiveCamera();
  private advances = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private getBus: () => AudioBus | null,
    private getWorld: () => StreamedWorld,
    private kit: Kit,
    private onAdvance: () => void,
  ) {
    this.root.name = "Exit door";
    this.root.visible = false;
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 2.8, 0.3),
      new THREE.MeshBasicMaterial({ color: 0x141414 }),
    );
    frame.position.y = 1.4;
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.2, 2.4),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 2.55, 1.5) }),
    );
    glow.position.set(0, 1.4, 0.16);
    const lintel = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, 0.25, 0.5),
      new THREE.MeshBasicMaterial({ color: 0x3a3524 }),
    );
    lintel.position.y = 2.95;
    this.root.add(frame, glow, lintel);
  }

  place(world: StreamedWorld) {
    const center = exitChunkCenter(world.origin, this.kit.cellSize, EXIT_CHUNK);
    const spot = resolveExitSpot(center, world.colliders);
    this.root.position.set(spot.x, 0, spot.z);
    // Face back toward the origin side — players approach from home.
    const yaw = Math.atan2(-spot.x, -spot.z);
    this.root.rotation.set(0, yaw, 0);
    this.root.visible = true;
    this.root.updateMatrixWorld(true);
  }

  prepare(): Promise<void> {
    return Promise.resolve(); // hum is procedural; nothing to fetch
  }

  update(seconds: number, active: boolean, audible: boolean) {
    if (!active || document.hidden || !this.root.visible) {
      this.stopHum();
      return;
    }
    void seconds;
    const bus = this.getBus();
    const dist = this.root.position.distanceTo(this.camera.position);
    const want = audible && bus?.context.state === "running" && dist < 45;
    if (!want) {
      this.stopHum();
      return;
    }
    if (!bus) return;
    if (!this.hum) {
      const osc = bus.context.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 55;
      const overtone = bus.context.createOscillator();
      overtone.type = "sine";
      overtone.frequency.value = 110.3;
      const gain = bus.context.createGain();
      gain.gain.value = 0;
      const pan = bus.context.createPanner();
      pan.panningModel = "HRTF";
      pan.distanceModel = "inverse";
      pan.refDistance = 10;
      pan.rolloffFactor = 0.5;
      osc.connect(gain);
      overtone.connect(gain);
      gain.connect(pan);
      pan.connect(bus.output);
      osc.start();
      overtone.start();
      this.hum = { osc, gain, pan };
      // Keep the overtone tied to the same lifecycle without a second handle.
      osc.onended = () => {
        try {
          overtone.stop();
        } catch {
          /* already stopped */
        }
      };
    }
    const reach = 1 - THREE.MathUtils.smoothstep(dist, 6, 45);
    this.hum.gain.gain.setTargetAtTime(0.02 + reach * 0.16, bus.context.currentTime, 0.4);
    this.hum.pan.positionX.value = this.root.position.x;
    this.hum.pan.positionY.value = 1.4;
    this.hum.pan.positionZ.value = this.root.position.z;
  }

  private hit(x: number, y: number): boolean {
    if (!this.root.visible) return false;
    this.pickCamera.copy(this.camera);
    this.pickCamera.updateMatrixWorld(true);
    this.root.updateMatrixWorld(true);
    this.ray.setFromCamera(new THREE.Vector2(x, y), this.pickCamera);
    this.ray.near = 0;
    this.ray.far = 2.6;
    const hit = this.ray.intersectObject(this.root, true)[0];
    if (!hit) return false;
    const obstruction = this.ray.intersectObject(this.getWorld().root, true)[0];
    return !obstruction || obstruction.distance >= hit.distance - 0.01;
  }

  inReach(): boolean {
    if (!this.root.visible) return false;
    return this.root.position.distanceTo(this.camera.position) < 2.6;
  }

  interact(x: number, y: number): boolean {
    if (!this.hit(x, y)) return false;
    this.advances++;
    this.stopHum();
    this.onAdvance();
    return true;
  }

  shiftOrigin(shift: { x: number; z: number }) {
    if (!this.root.visible) return;
    this.root.position.x += shift.x;
    this.root.position.z += shift.z;
    this.root.updateMatrixWorld(true);
  }

  private stopHum() {
    if (!this.hum) return;
    try {
      this.hum.osc.stop();
    } catch {
      /* already stopped */
    }
    this.hum.gain.disconnect();
    this.hum.pan.disconnect();
    this.hum = null;
  }

  reset() {
    this.stopHum();
    this.root.visible = false;
  }

  get diagnostics() {
    return {
      visible: this.root.visible,
      position: this.root.visible ? this.root.position.toArray() : null,
      distance: this.root.visible ? this.root.position.distanceTo(this.camera.position) : null,
      humming: !!this.hum,
      advances: this.advances,
      error: this.error,
    };
  }
}
