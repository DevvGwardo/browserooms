import * as THREE from "three";
import { loadNubCat, characterDef, getCharacter, nubFaceTexture } from "./nubcat";
import type { AudioBus } from "./light-ambience";
import type { StreamedWorld } from "./streamed-world";
import { movePlayer } from "./collision";
import {
  EntityBrain,
  segmentBlocked,
  pointBlocked,
  sense,
  STUN_RANGE,
  CATCH_RANGE,
} from "./entity-logic";

export type EntityEvents = {
  onCaught: () => void;
  onSpotted: () => void;
};

type Drone = { osc: OscillatorNode; gain: GainNode; pan: PannerNode };

function hashRand(text: string): () => number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

/**
 * The Entity — the pink nub rig, corrupted: blackened, red-eyed,
 * stalking the streamed world. Steering reuses movePlayer wall-sliding; there is
 * no navmesh, so long-range pressure comes from lurk-relocation, not pathfinding.
 */
export class Entity {
  error: string | null = null;
  readonly root = new THREE.Group();
  private brain: EntityBrain;
  private body: THREE.Group | null = null;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private drone: Drone | null = null;
  private wanderIn = 3;
  private unstickIn = 0;
  private lastPos = new THREE.Vector2();
  private stuckFor = 0;
  private spottedCount = 0;
  private stuns = 0;
  private catches = 0;
  private rand: () => number;
  private forward = new THREE.Vector3();
  private toEntity = new THREE.Vector3();
  private bobPhase = Math.random() * 10;
  private mixer: THREE.AnimationMixer | null = null;
  private walkAction: THREE.AnimationAction | null = null;
  /** Per-load materials (owned here, disposed on reload — never the shared geo). */
  private ownedMats: THREE.Material[] = [];

  constructor(
    private camera: THREE.PerspectiveCamera,
    private getBus: () => AudioBus | null,
    private getWorld: () => StreamedWorld,
    private hooks: EntityEvents,
    private seed: string,
    public speed = 3.05,
  ) {
    this.root.name = "Entity";
    this.root.visible = false;
    this.rand = hashRand(`entity:${seed}`);
    const start = this.findLurkSpot(new THREE.Vector3(0, 0, 0), 18) ?? { x: 12, z: -14 };
    this.brain = new EntityBrain(start);
    this.lastPos.set(start.x, start.z);
  }

  /** GLB fetch — called from boot alongside the other loaders. */
  load(scene: THREE.Scene): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = loadNubCat()
      .then(({ model, clips }) => {
        // The scene is baked MeshBasic, not lit: an unlit body matches and a
        // PointLight would burn uniforms for zero contribution. The pinkNUB
        // rig ships its own eye mesh (Nub_eyes) with a real face texture, so:
        // body keeps the current character's artist color, eyes get map + red tint.
        // Texture base path mirrors the GLB so dev + Vercel agree.
        const faceTex = nubFaceTexture();
        const dark = new THREE.MeshBasicMaterial({ color: characterDef(getCharacter()).bodyColor });
        const eyeMat = new THREE.MeshBasicMaterial({
          map: faceTex, color: 0xff5555, transparent: true,
        });
        this.ownedMats.push(dark, eyeMat);
        model.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.castShadow = false;
            if (/eye/i.test(node.name)) node.material = eyeMat;
            else node.material = dark;
          }
        });
        this.body = new THREE.Group();
        this.body.add(model);
        // Blender-baked walk loop: chase scrambles it faster, stalk ambles.
        if (clips.length) {
          this.mixer = new THREE.AnimationMixer(model);
          this.walkAction = this.mixer.clipAction(clips[0]);
          this.walkAction.play();
        }
        // pinkNUB stands ~1.5m at the head; scale to a ~1.65m stalker so it
        // reads at eye level down the corridor (old 1.55x was for the smaller rig).
        const s = 1.1;
        this.body.scale.set(s, s, s);
        this.body.position.y = 0;
        this.root.add(this.body);
        this.root.visible = true;
        this.loaded = true;
        this.error = null;
      })
      .catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : "Entity model unavailable.";
      })
      .finally(() => {
        this.loading = null;
      });
    scene.add(this.root);
    return this.loading;
  }

  /** Hot-swap the rig after a character change (scene graph + sim state kept). */
  reload(scene: THREE.Scene): Promise<void> {
    if (this.loading) return this.loading;
    this.stopDrone();
    if (this.body) {
      this.root.remove(this.body);
      this.body = null;
    }
    for (const mat of this.ownedMats) mat.dispose();
    this.ownedMats = [];
    this.mixer = null;
    this.walkAction = null;
    this.loaded = false;
    return this.load(scene);
  }

  prepare(): Promise<void> {
    return Promise.resolve(); // drone is fully procedural; nothing to fetch
  }

  private get boxes() {
    return this.getWorld().colliders;
  }

  private freeSpotNear(x: number, z: number, minR: number, maxR: number): { x: number; z: number } | null {
    for (let i = 0; i < 40; i++) {
      const angle = this.rand() * Math.PI * 2;
      const radius = minR + this.rand() * (maxR - minR);
      const px = x + Math.cos(angle) * radius;
      const pz = z + Math.sin(angle) * radius;
      if (pointBlocked(px, pz, this.boxes, 0.5)) continue;
      if (segmentBlocked(x, z, px, pz, this.boxes)) continue;
      return { x: px, z: pz };
    }
    return null;
  }

  private findLurkSpot(player: THREE.Vector3, minDist: number): { x: number; z: number } | null {
    return this.freeSpotNear(player.x, player.z, minDist, minDist + 10);
  }

  update(seconds: number, active: boolean, audible: boolean, playerSpeed: number, zoom: number) {
    if (!active || document.hidden) {
      this.stopDrone();
      return;
    }
    const dt = Math.min(Math.max(seconds, 0), 0.1);
    const boxes = this.boxes;
    const player = { x: this.camera.position.x, z: this.camera.position.z };
    const dist = Math.hypot(player.x - this.brain.pos.x, player.z - this.brain.pos.z);

    this.camera.getWorldDirection(this.forward);
    this.toEntity.set(this.brain.pos.x - player.x, 0, this.brain.pos.z - player.z);
    const dirLen = this.toEntity.length() || 1;
    this.toEntity.divideScalar(dirLen);
    const gazeDot = this.forward.x * this.toEntity.x + this.forward.z * this.toEntity.z;
    const blocked = segmentBlocked(this.brain.pos.x, this.brain.pos.z, player.x, player.z, boxes);
    const gazeHeld = gazeDot > 0.94 && zoom > 1.5 && dist < STUN_RANGE && !blocked;

    const sensed = sense({ entity: this.brain.pos, player, playerSpeed, zoom, gazeDot, boxes });
    const { events, steer } = this.brain.update(dt, sensed, gazeHeld, player);

    for (const event of events) {
      if (event === "spotted") {
        this.spottedCount++;
        this.hooks.onSpotted();
      } else if (event === "lost") {
        const spot = this.findLurkSpot(this.camera.position, 15);
        if (spot) {
          this.brain.pos = spot;
          this.brain.requestWander({ ...spot }, 0);
        }
      } else if (event === "stunned") {
        this.stuns++;
      } else if (event === "caught") {
        this.catches++;
        this.hooks.onCaught();
      }
    }

    // Steering with wall sliding + unstick jitter.
    let target: { x: number; z: number } | null = steer;
    if (this.brain.mode === "stalk") {
      this.wanderIn -= dt;
      if (!this.brain.wanderTarget && this.wanderIn <= 0) {
        this.wanderIn = 4 + this.rand() * 4;
        const spot = this.freeSpotNear(this.brain.pos.x, this.brain.pos.z, 6, 18);
        if (spot) this.brain.requestWander(spot, 9);
      }
      target = this.brain.wanderTarget;
    }
    if (target) {
      const dx = target.x - this.brain.pos.x;
      const dz = target.z - this.brain.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.3) {
        const rate = this.brain.mode === "chase" ? (dist > 14 ? this.speed * 1.1 : this.speed) : this.speed * 0.45;
        const step = Math.min(d, rate * dt);
        let jx = 0;
        let jz = 0;
        if (this.stuckFor > 0.8) {
          const a = this.rand() * Math.PI * 2;
          jx = Math.cos(a) * rate * dt * 2;
          jz = Math.sin(a) * rate * dt * 2;
        }
        const next = movePlayer(
          this.brain.pos,
          (dx / d) * step + jx,
          (dz / d) * step + jz,
          boxes,
          0.4,
        );
        this.brain.pos = next;
      }
    }

    // Stuck detection (chase only — stalk wandering is allowed to idle).
    this.unstickIn += dt;
    if (this.unstickIn >= 0.5) {
      const moved = Math.hypot(this.brain.pos.x - this.lastPos.x, this.brain.pos.z - this.lastPos.y);
      this.lastPos.set(this.brain.pos.x, this.brain.pos.z);
      this.unstickIn = 0;
      if (this.brain.mode === "chase" && moved < 0.15 && dist > CATCH_RANGE + 0.5) this.stuckFor += 0.5;
      else this.stuckFor = 0;
    }

    // Presentation.
    this.root.position.set(this.brain.pos.x, 0, this.brain.pos.z);
    this.root.rotation.y = Math.atan2(player.x - this.brain.pos.x, player.z - this.brain.pos.z);
    if (this.body) {
      this.bobPhase += dt * (this.brain.mode === "chase" ? 9 : 4);
      this.body.position.y = 0.55 + Math.abs(Math.sin(this.bobPhase)) * (this.brain.mode === "chase" ? 0.22 : 0.1);
    }
    // Baked walk loop rides alongside the procedural bob: chase scrambles.
    if (this.walkAction) this.walkAction.timeScale = this.brain.mode === "chase" ? 2.2 : 0.9;
    this.mixer?.update(dt);

    this.updateDrone(audible, dist);
  }

  private updateDrone(audible: boolean, dist: number) {
    const bus = this.getBus();
    const want = audible && bus?.context.state === "running" && this.brain.mode === "chase";
    if (!want) {
      this.stopDrone();
      return;
    }
    if (!bus) return;
    if (!this.drone) {
      const osc = bus.context.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 62;
      const filter = bus.context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 280;
      const gain = bus.context.createGain();
      gain.gain.value = 0;
      const pan = bus.context.createPanner();
      pan.panningModel = "HRTF";
      pan.distanceModel = "inverse";
      pan.refDistance = 8;
      pan.rolloffFactor = 0.6;
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(pan);
      pan.connect(bus.output);
      osc.start();
      this.drone = { osc, gain, pan };
    }
    const closeness = 1 - THREE.MathUtils.smoothstep(dist, 4, 22);
    this.drone.gain.gain.setTargetAtTime(0.05 + closeness * 0.22, bus.context.currentTime, 0.3);
    this.drone.osc.frequency.setTargetAtTime(58 + closeness * 26, bus.context.currentTime, 0.3);
    this.drone.pan.positionX.value = this.root.position.x;
    this.drone.pan.positionY.value = 1;
    this.drone.pan.positionZ.value = this.root.position.z;
  }

  private stopDrone() {
    if (!this.drone) return;
    try {
      this.drone.osc.stop();
    } catch {
      /* already stopped */
    }
    this.drone.gain.disconnect();
    this.drone.pan.disconnect();
    this.drone = null;
  }

  shiftOrigin(shift: { x: number; z: number }) {
    this.brain.pos.x += shift.x;
    this.brain.pos.z += shift.z;
    if (this.brain.wanderTarget) {
      this.brain.wanderTarget.x += shift.x;
      this.brain.wanderTarget.z += shift.z;
    }
    this.root.position.x += shift.x;
    this.root.position.z += shift.z;
  }

  reset(clear = false) {
    this.stopDrone();
    this.wanderIn = 3;
    this.stuckFor = 0;
    const spot = this.findLurkSpot(this.camera.position, 16) ?? { x: 12, z: -14 };
    this.brain.reset(spot);
    this.lastPos.set(spot.x, spot.z);
    if (clear) {
      this.spottedCount = 0;
      this.stuns = 0;
      this.catches = 0;
    }
  }

  get threat(): number {
    if (this.brain.mode !== "chase") return this.brain.mode === "stunned" ? 0.05 : 0;
    const dist = Math.hypot(
      this.camera.position.x - this.brain.pos.x,
      this.camera.position.z - this.brain.pos.z,
    );
    return 0.45 + 0.55 * (1 - THREE.MathUtils.smoothstep(dist, 3, 20));
  }

  get mode() {
    return this.brain.mode;
  }

  get diagnostics() {
    return {
      mode: this.brain.mode,
      loaded: this.loaded,
      position: [this.brain.pos.x, this.brain.pos.z] as [number, number],
      distance: Math.hypot(
        this.camera.position.x - this.brain.pos.x,
        this.camera.position.z - this.brain.pos.z,
      ),
      speed: this.speed,
      spotted: this.spottedCount,
      stuns: this.stuns,
      catches: this.catches,
      error: this.error,
    };
  }
}
