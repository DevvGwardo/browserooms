import * as THREE from "three";
import type { AudioBus } from "./light-ambience";
import type { StreamedWorld } from "./streamed-world";

type Failure = { id: string; age: number; duration: number; attention: number; recovery: number; outage: boolean; dips: number[] };
type Circuit = { ids: string[]; age: number; fade: number; hold: number; darkness: number };

export class LightFlicker {
  error: string | null = null;
  private lamp = { value: new THREE.Vector4(0, 0, 0, 0) };
  private circuitLamps = { value: Array.from({ length: 8 }, () => new THREE.Vector4()) };
  private circuitCount = { value: 0 };
  private circuitCenter = { value: new THREE.Vector3() };
  private circuitRadius = { value: 0 };
  private circuit: Circuit | null = null;
  private circuitWait = 12 + Math.random() * 8;
  private circuitEvents = 0;
  private travelled = 0;
  private travelAnchor: THREE.Vector3 | null = null;
  private travelOrigin = { x: 0, z: 0 };
  private blockers = { value: 0 };
  private boxMin = { value: Array.from({ length: 16 }, () => new THREE.Vector3()) };
  private boxMax = { value: Array.from({ length: 16 }, () => new THREE.Vector3()) };
  private failure: Failure | null = null;
  private wait = 5 + Math.random() * 5;
  private lastId = "";
  private events = 0;
  private recoveries = 0;
  private point = new THREE.Vector3();
  private projected = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private ray = new THREE.Ray();
  private box = new THREE.Box3();
  private hit = new THREE.Vector3();
  private buffers: AudioBuffer[] = [];
  private preparing: Promise<void> | null = null;
  private lastClip = -1;
  private voice: { source: AudioBufferSourceNode; gain: GainNode; pan: PannerNode } | null = null;

  constructor(private camera: THREE.PerspectiveCamera, private world: StreamedWorld,
    private getBus: () => AudioBus | null, private changed: () => void, private reducedMotion: boolean,
    prototypes: Iterable<THREE.Object3D>) {
    const materials = new Set<THREE.Material>();
    for (const prototype of prototypes) prototype.traverse((object) => {
      if (object instanceof THREE.Mesh) for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    });
    for (const material of materials) {
      const compile = material.onBeforeCompile;
      const key = material.customProgramCacheKey();
      const emitter = material instanceof THREE.MeshBasicMaterial && !material.map;
      material.customProgramCacheKey = () => `${key}-fixture-failure-v2`;
      material.onBeforeCompile = (shader, renderer) => {
        compile.call(material, shader, renderer);
        shader.uniforms.failedLamp = this.lamp;
        shader.uniforms.circuitLamps = this.circuitLamps;
        shader.uniforms.circuitCount = this.circuitCount;
        shader.uniforms.circuitCenter = this.circuitCenter;
        shader.uniforms.circuitRadius = this.circuitRadius;
        shader.uniforms.failureBlockers = this.blockers;
        shader.uniforms.failureMin = this.boxMin;
        shader.uniforms.failureMax = this.boxMax;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec3 vFailurePosition;")
          .replace("#include <project_vertex>", "#include <project_vertex>\nvFailurePosition = (modelMatrix * vec4(transformed, 1.0)).xyz;");
        shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
          varying vec3 vFailurePosition;
          uniform vec4 failedLamp;
          uniform vec4 circuitLamps[8];
          uniform int circuitCount;
          uniform vec3 circuitCenter;
          uniform float circuitRadius;
          uniform int failureBlockers;
          uniform vec3 failureMin[16];
          uniform vec3 failureMax[16];
          float fixtureInfluence(vec3 lampPosition) {
              vec3 separation = vFailurePosition - lampPosition;
              ${emitter ? `return length(separation) < 0.8 ? 0.995 : 0.0;` : `
                float footprint = 1.0 - smoothstep(0.3, 4.5, length(separation.xz));
                float influence = footprint * footprint * 0.72;
                if (influence > 0.001) {
                  // Do not subtract a lamp's contribution through a partition.
                  vec3 origin = lampPosition - vec3(0.0, 0.035, 0.0);
                  vec3 travel = vFailurePosition - origin;
                  vec3 inverse = 1.0 / (mix(vec3(-1.0), vec3(1.0), step(vec3(0.0), travel)) * max(abs(travel), vec3(0.00001)));
                  for (int i = 0; i < 16; i++) {
                    if (i >= failureBlockers) break;
                    vec3 a = (failureMin[i] - origin) * inverse;
                    vec3 b = (failureMax[i] - origin) * inverse;
                    vec3 nearHit = min(a, b), farHit = max(a, b);
                    float entry = max(max(nearHit.x, nearHit.y), nearHit.z);
                    float exit = min(min(farHit.x, farHit.y), farHit.z);
                    if (entry < exit && exit > 0.001 && entry < 0.975) { influence = 0.0; break; }
                  }
                }
                return influence;
              `}
          }`)
          .replace("#include <opaque_fragment>", `
            if (failedLamp.w > 0.001) {
              outgoingLight *= 1.0 - failedLamp.w * fixtureInfluence(failedLamp.xyz);
            }
            if (circuitCount > 0 && distance(vFailurePosition.xz, circuitCenter.xz) < circuitRadius + 4.5) {
              float circuitDarkness = 0.0;
              for (int i = 0; i < 8; i++) {
                if (i >= circuitCount) break;
                if (circuitLamps[i].w > 0.001) circuitDarkness += circuitLamps[i].w * fixtureInfluence(circuitLamps[i].xyz);
              }
              outgoingLight *= 1.0 - min(circuitDarkness, ${emitter ? "0.995" : "0.88"});
            }
            #include <opaque_fragment>`);
      };
      material.needsUpdate = true;
    }
  }

  prepare(): Promise<void> {
    if (this.buffers.length) return Promise.resolve();
    if (this.preparing) return this.preparing;
    const bus = this.getBus();
    if (!bus) return Promise.resolve();
    this.preparing = (async () => {
      const response = await fetch("/audio/flicker/manifest.json");
      if (!response.ok) throw new Error("Flicker sounds could not be loaded.");
      const manifest = await response.json() as { clips: { file: string }[] };
      this.buffers = await Promise.all(manifest.clips.map(async ({ file }) => {
        const response = await fetch(`/audio/flicker/${encodeURIComponent(file)}`);
        if (!response.ok) throw new Error("A flicker sound could not be loaded.");
        return bus.context.decodeAudioData(await response.arrayBuffer());
      }));
      this.error = null;
    })().catch((error: unknown) => {
      this.error = error instanceof Error ? error.message : "Flicker audio unavailable.";
    }).finally(() => { this.preparing = null; this.changed(); });
    return this.preparing;
  }

  private visible(position: number[]) {
    this.point.fromArray(position);
    const distance = this.point.distanceTo(this.camera.position);
    this.ray.set(this.camera.position, this.point.clone().sub(this.camera.position).normalize());
    for (const collider of this.world.colliders) {
      this.box.min.fromArray(collider.min); this.box.max.fromArray(collider.max);
      if (this.ray.intersectBox(this.box, this.hit) && this.hit.distanceTo(this.camera.position) < distance - 0.07) return false;
    }
    return true;
  }

  update(seconds: number, active: boolean, audible: boolean) {
    if (!active || document.hidden) { this.reset(); return; }
    const delta = Math.min(seconds, 0.1);
    this.camera.updateMatrixWorld();
    this.camera.getWorldDirection(this.forward);
    let moving = false;
    if (this.travelAnchor) {
      this.travelAnchor.x -= (this.world.origin.x - this.travelOrigin.x) * this.world.kit.cellSize;
      this.travelAnchor.z -= (this.world.origin.z - this.travelOrigin.z) * this.world.kit.cellSize;
      const distance = Math.hypot(this.camera.position.x - this.travelAnchor.x, this.camera.position.z - this.travelAnchor.z);
      // Sample the base camera before motion offsets; accumulate steps of at least 2 cm.
      if (distance >= 0.02) {
        this.travelled += distance;
        moving = true;
        this.travelAnchor.copy(this.camera.position);
      }
    } else this.travelAnchor = this.camera.position.clone();
    this.travelOrigin.x = this.world.origin.x;
    this.travelOrigin.z = this.world.origin.z;
    if (!this.circuit) this.circuitWait = Math.max(0, this.circuitWait - delta);
    if (!this.circuit && !this.failure && moving && this.travelled >= 8 && this.circuitWait <= 0) {
      const candidates = this.world.lights.filter((light) => {
        this.point.fromArray(light.position).sub(this.camera.position);
        return this.point.length() <= 8.5 && this.point.dot(this.forward) >= -0.4 && this.visible(light.position);
      });
      candidates.sort((a, b) => this.point.fromArray(a.position).distanceToSquared(this.camera.position)
        - this.projected.fromArray(b.position).distanceToSquared(this.camera.position));
      if (candidates.length >= 3) {
        this.circuit = { ids: candidates.slice(0, 8).map((light) => light.id), age: 0,
          fade: 0.5 + Math.random() * 0.4, hold: 8 + Math.random() * 4, darkness: 0 };
        this.circuitEvents++;
        this.travelled = 0;
      } else this.circuitWait = 1;
    }
    if (this.circuit) { this.updateCircuit(delta, audible); return; }
    if (!this.failure) {
      this.wait -= delta;
      if (this.wait > 0) return;
      const candidates = this.world.lights.filter((light) => {
        this.point.fromArray(light.position).sub(this.camera.position);
        const distance = this.point.length();
        if (distance < 2 || distance > 11 || light.id === this.lastId || this.point.normalize().dot(this.forward) < -0.15) return false;
        this.projected.fromArray(light.position).project(this.camera);
        if (this.projected.z < 1 && Math.hypot(this.projected.x, this.projected.y) < 0.38) return false;
        return this.visible(light.position);
      });
      // Most failures are visible at the edge of the frame; some are just beside you.
      const inFrame = candidates.filter((light) => {
        this.projected.fromArray(light.position).project(this.camera);
        return this.projected.z < 1 && Math.abs(this.projected.x) < 1.15 && Math.abs(this.projected.y) < 1.15;
      });
      const pool = inFrame.length && Math.random() < 0.8 ? inFrame : candidates;
      if (!pool.length) { this.wait = 2; return; }
      const chosen = pool[Math.floor(Math.random() * pool.length)];
      const first = 0.22 + Math.random() * 0.16;
      const second = first + 0.35 + Math.random() * 0.18;
      const third = second + 0.38 + Math.random() * 0.22;
      this.failure = { id: chosen.id, age: 0, duration: 3 + Math.random() * 4, attention: 0, recovery: -1,
        outage: Math.random() < 0.4, dips: [first, second, third, third + 0.4 + Math.random() * 0.25] };
      this.lastId = chosen.id;
      this.events++;
      this.lamp.value.set(...chosen.position, 0);
      if (audible) this.playSound();
    }
    const failure = this.failure;
    const light = this.world.lights.find((light) => light.id === failure.id);
    if (!light || this.camera.position.distanceTo(this.point.fromArray(light.position)) > 15) { this.clearFailure(); return; }
    this.lamp.value.set(...light.position, this.lamp.value.w);
    this.blockers.value = 0;
    for (const collider of this.world.colliders) {
      this.box.min.fromArray(collider.min); this.box.max.fromArray(collider.max);
      if (this.box.distanceToPoint(this.point) > 4.6) continue;
      const i = this.blockers.value++;
      this.boxMin.value[i].copy(this.box.min); this.boxMax.value[i].copy(this.box.max);
      if (this.blockers.value === 16) break;
    }
    const previousAge = failure.age;
    failure.age += delta;
    if (!this.reducedMotion && audible && failure.recovery < 0 &&
      [failure.dips[1], failure.dips[3]].some((time) => previousAge < time && failure.age >= time)) this.playSound(true);
    this.projected.fromArray(light.position).project(this.camera);
    const focused = this.projected.z < 1 && Math.hypot(this.projected.x, this.projected.y) < 0.32 && this.visible(light.position);
    failure.attention = focused ? failure.attention + delta : Math.max(0, failure.attention - delta * 0.6);
    if (failure.recovery < 0 && (failure.attention > 0.85 || failure.age > failure.duration)) {
      failure.recovery = 0;
      if (failure.attention > 0.85) this.recoveries++;
      this.stopSound();
    }
    // A pair of irregular dips, not a high-frequency or full-screen strobe.
    let darkness = failure.outage ? 1 : 0.82;
    if (!this.reducedMotion && failure.age > failure.dips[0] && failure.age < failure.dips[1]) darkness = 0.12;
    if (!this.reducedMotion && failure.age > failure.dips[2] && failure.age < failure.dips[3]) darkness = 0.28;
    if (failure.recovery >= 0) { failure.recovery += delta; darkness = 0; }
    const speed = this.reducedMotion ? 3 : failure.recovery >= 0 ? 8 : 22;
    this.lamp.value.w += (darkness - this.lamp.value.w) * (1 - Math.exp(-delta * speed));
    if (failure.recovery > (this.reducedMotion ? 1.8 : 0.8)) { this.clearFailure(); return; }
    if (!audible) this.stopSound();
    if (this.voice) {
      this.voice.pan.positionX.value = light.position[0];
      this.voice.pan.positionY.value = light.position[1];
      this.voice.pan.positionZ.value = light.position[2];
    }
  }

  private updateCircuit(delta: number, audible: boolean) {
    const circuit = this.circuit!;
    const onset = circuit.age === 0;
    circuit.age += delta;
    const restoreAt = circuit.fade + (circuit.ids.length - 1) * 0.045 + circuit.hold;
    if (circuit.age >= restoreAt + 2) {
      this.circuit = null;
      this.circuitCount.value = 0;
      for (const lamp of this.circuitLamps.value) lamp.w = 0;
      this.circuitWait = 40 + Math.random() * 30;
      this.travelled = 0;
      this.wait = 12 + Math.random() * 18;
      this.stopSound();
      return;
    }
    this.circuitCount.value = circuit.ids.length;
    this.circuitCenter.value.set(0, 0, 0);
    circuit.darkness = 0;
    let present = 0;
    for (let i = 0; i < circuit.ids.length; i++) {
      const lamp = this.circuitLamps.value[i];
      const light = this.world.lights.find((light) => light.id === circuit.ids[i]);
      if (!light) { lamp.w = 0; continue; }
      const fade = THREE.MathUtils.smoothstep(circuit.age - i * 0.045, 0, circuit.fade);
      const recovery = THREE.MathUtils.smoothstep(circuit.age, restoreAt, restoreAt + 2);
      lamp.set(...light.position, fade * (1 - recovery));
      this.circuitCenter.value.add(this.point.fromArray(light.position));
      circuit.darkness += lamp.w;
      present++;
    }
    if (present) this.circuitCenter.value.divideScalar(present);
    circuit.darkness /= circuit.ids.length;
    this.circuitRadius.value = 0;
    for (let i = 0; i < circuit.ids.length; i++) {
      const lamp = this.circuitLamps.value[i];
      if (lamp.w > 0) this.circuitRadius.value = Math.max(this.circuitRadius.value,
        Math.hypot(lamp.x - this.circuitCenter.value.x, lamp.z - this.circuitCenter.value.z));
    }
    // One bounded occlusion set shared by the group, nearest partitions first.
    const nearby = this.world.colliders.map((collider) => {
      this.box.min.fromArray(collider.min); this.box.max.fromArray(collider.max);
      return { collider, distance: this.box.distanceToPoint(this.circuitCenter.value) };
    }).filter(({ distance }) => distance < this.circuitRadius.value + 4.6)
      .sort((a, b) => a.distance - b.distance).slice(0, 16);
    this.blockers.value = nearby.length;
    for (let i = 0; i < nearby.length; i++) {
      this.boxMin.value[i].fromArray(nearby[i].collider.min);
      this.boxMax.value[i].fromArray(nearby[i].collider.max);
    }
    if (onset && audible && present) this.playSound(true);
    if (!audible || !present) this.stopSound();
    if (this.voice) {
      this.voice.pan.positionX.value = this.circuitCenter.value.x;
      this.voice.pan.positionY.value = this.circuitCenter.value.y;
      this.voice.pan.positionZ.value = this.circuitCenter.value.z;
    }
  }

  private playSound(short = false) {
    const bus = this.getBus();
    if (!bus || bus.context.state !== "running" || !this.buffers.length) return;
    this.stopSound();
    const choices = this.buffers.map((buffer, index) => ({ buffer, index }))
      .filter(({ buffer, index }) => index !== this.lastClip && (!short || buffer.duration < 0.6));
    const index = choices.length ? choices[Math.floor(Math.random() * choices.length)].index
      : this.circuit ? this.buffers.findIndex((buffer) => buffer.duration < 0.6) : 0;
    if (index < 0) return;
    this.lastClip = index;
    const source = bus.context.createBufferSource();
    source.buffer = this.buffers[index];
    const gain = bus.context.createGain();
    gain.gain.value = 0.65;
    const pan = bus.context.createPanner();
    pan.panningModel = "HRTF";
    pan.distanceModel = "inverse";
    pan.refDistance = 2.5;
    pan.rolloffFactor = 0.8;
    const position = this.circuit ? this.circuitCenter.value : this.lamp.value;
    pan.positionX.value = position.x; pan.positionY.value = position.y; pan.positionZ.value = position.z;
    source.connect(gain); gain.connect(pan); pan.connect(bus.output);
    const voice = { source, gain, pan };
    this.voice = voice;
    source.onended = () => { source.disconnect(); gain.disconnect(); pan.disconnect(); if (this.voice === voice) this.voice = null; };
    source.start();
  }

  private stopSound() {
    if (!this.voice) return;
    const voice = this.voice;
    this.voice = null;
    const bus = this.getBus();
    if (!bus || bus.context.state !== "running" || document.hidden) { voice.source.stop(); voice.source.disconnect(); voice.gain.disconnect(); voice.pan.disconnect(); }
    else { voice.gain.gain.setTargetAtTime(0, bus.context.currentTime, 0.01); voice.source.stop(bus.context.currentTime + 0.06); }
  }

  private clearFailure() {
    if (this.failure) this.wait = 12 + Math.random() * 18;
    this.failure = null;
    this.lamp.value.w = 0;
    this.stopSound();
  }

  reset() {
    this.clearFailure();
    if (this.circuit) this.circuitWait = 40 + Math.random() * 30;
    else if (this.travelAnchor) this.circuitWait = Math.max(this.circuitWait, 12 + Math.random() * 8);
    this.circuit = null;
    this.circuitCount.value = 0;
    for (const lamp of this.circuitLamps.value) lamp.w = 0;
    this.blockers.value = 0;
    this.travelAnchor = null;
    this.travelled = 0;
  }

  get lightState() {
    return { id: this.failure?.id ?? "", brightness: 1 - (this.circuit?.darkness ?? this.lamp.value.w),
      ...(this.circuit ? { ids: this.circuit.ids } : {}) };
  }
  get threat() {
    if (this.circuit) return 0.8 * this.circuit.darkness
      * (1 - THREE.MathUtils.smoothstep(this.camera.position.distanceTo(this.circuitCenter.value), 4, 12));
    if (!this.failure) return 0;
    return 0.15 * this.lamp.value.w * (1 - THREE.MathUtils.smoothstep(
      this.camera.position.distanceTo(this.point.set(this.lamp.value.x, this.lamp.value.y, this.lamp.value.z)), 3, 12));
  }
  get diagnostics() {
    return { ...this.lightState, position: this.failure ? this.lamp.value.toArray().slice(0, 3) : null,
      attention: this.failure?.attention ?? 0, age: this.failure?.age ?? 0, recovering: (this.failure?.recovery ?? -1) >= 0,
      events: this.events, watchedRecoveries: this.recoveries, nextIn: this.wait, loadedSounds: this.buffers.length,
      circuit: this.circuit ? { ...this.circuit, position: this.circuitCenter.value.toArray(), radius: this.circuitRadius.value } : null,
      circuitEvents: this.circuitEvents, circuitNextIn: this.circuitWait, travelled: this.travelled,
      soundPlaying: !!this.voice, error: this.error };
  }
}
