import type { Collider } from "./collision";
import type { LightEmitter } from "./world-layout";
import { Vector3, type Camera } from "three";

type Position = { x: number; y: number; z: number };
export type AudioBus = { context: AudioContext; output: GainNode };
export const BASE_GAIN = 0.2;
export const NEAR_GAIN = 0.75;

/** One soundtrack, with the strongest visible nearby fixture controlling its gain. */
export function lightAudioLevel(position: Position, lights: LightEmitter[], colliders: Collider[]) {
  const origin = [position.x, position.y, position.z];
  let nearestSquared = 36;
  let lightId: string | null = null;
  for (const light of lights) {
    const dx = light.position[0] - position.x;
    const dy = light.position[1] - position.y;
    const dz = light.position[2] - position.z;
    const squared = dx * dx + dy * dy + dz * dz;
    if (squared >= nearestSquared) continue;
    const delta = [dx, dy, dz];
    const blocked = colliders.some((box) => {
      let enter = 0, exit = 1;
      for (let axis = 0; axis < 3; axis++) {
        if (Math.abs(delta[axis]) < 1e-8) {
          if (origin[axis] < box.min[axis] || origin[axis] > box.max[axis]) return false;
        } else {
          const a = (box.min[axis] - origin[axis]) / delta[axis];
          const b = (box.max[axis] - origin[axis]) / delta[axis];
          enter = Math.max(enter, Math.min(a, b));
          exit = Math.min(exit, Math.max(a, b));
          if (enter > exit) return false;
        }
      }
      return exit > 0.001 && enter < 0.999;
    });
    if (!blocked) { nearestSquared = squared; lightId = light.id; }
  }
  const distance = Math.sqrt(nearestSquared);
  const edge = Math.min(1, Math.max(0, (6 - distance) / 1.5));
  const proximity = lightId ? Math.min(1, 2.25 / Math.max(nearestSquared, 0.001)) * edge * edge * (3 - 2 * edge) : 0;
  return { gain: BASE_GAIN + (NEAR_GAIN - BASE_GAIN) * proximity, lightId, distance: lightId ? distance : null };
}

export class LightAmbience {
  enabled = true;
  started = false;
  error: string | null = null;
  private media: HTMLAudioElement | null = null;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private samples = new Float32Array(1024);
  private forward = new Vector3();
  private up = new Vector3();
  private level: ReturnType<typeof lightAudioLevel> = { gain: BASE_GAIN, lightId: null, distance: null };

  constructor(private changed: () => void) {}

  ensureBus(): AudioBus {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.enabled && !document.hidden ? 1 : 0;
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = this.samples.length;
      this.master.connect(this.analyser);
      this.analyser.connect(this.context.destination);
    }
    return { context: this.context, output: this.master! };
  }

  async start() {
    if (!this.enabled) return;
    try {
      const bus = this.ensureBus();
      if (!this.media) {
        this.media = new Audio("/audio/backrooms-ambiance.mp3");
        this.media.loop = true;
        this.media.preload = "none";
        this.gain = bus.context.createGain();
        this.gain.gain.value = 0;
        bus.context.createMediaElementSource(this.media).connect(this.gain);
        this.gain.connect(bus.output);
        this.media.addEventListener("error", () => {
          this.error = "The ambience audio could not be loaded.";
          this.changed();
        });
      }
      // Both calls happen in the click handler before any await, preserving user activation.
      if (this.media!.error) this.media!.load();
      await Promise.all([bus.context.resume(), this.media!.play()]);
      this.started = true;
      this.error = null;
      if (document.hidden) this.visibilityChanged();
      else this.applyGain();
      this.changed();
    } catch (error) {
      if (document.hidden) return;
      this.error = error instanceof Error ? error.message : "Tap to enable sound.";
      this.changed();
    }
  }

  toggle() {
    if (!this.started || this.error) {
      this.enabled = true;
      void this.start();
    } else {
      this.enabled = !this.enabled;
      if (this.enabled) void this.start();
      this.applyGain();
      this.changed();
    }
  }

  update(position: Position, lights: LightEmitter[], colliders: Collider[], failure?: { id: string; brightness: number; ids?: string[] }) {
    this.level = lightAudioLevel(position, lights, colliders);
    if (failure && (this.level.lightId === failure.id || failure.ids?.includes(this.level.lightId ?? ""))) {
      this.level.gain = BASE_GAIN + (this.level.gain - BASE_GAIN) * failure.brightness;
    }
    this.applyGain();
  }

  updateListener(camera: Camera) {
    if (!this.context || this.context.state !== "running") return;
    const listener = this.context.listener;
    camera.getWorldDirection(this.forward);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    listener.positionX.value = camera.position.x;
    listener.positionY.value = camera.position.y;
    listener.positionZ.value = camera.position.z;
    listener.forwardX.value = this.forward.x;
    listener.forwardY.value = this.forward.y;
    listener.forwardZ.value = this.forward.z;
    listener.upX.value = this.up.x;
    listener.upY.value = this.up.y;
    listener.upZ.value = this.up.z;
  }

  private applyGain() {
    if (!this.context || !this.master) return;
    this.gain?.gain.setTargetAtTime(this.level.gain, this.context.currentTime, 0.12);
    this.master.gain.setTargetAtTime(this.enabled && !document.hidden ? 1 : 0, this.context.currentTime, 0.12);
  }

  get bus(): AudioBus | null {
    return this.context && this.master ? { context: this.context, output: this.master } : null;
  }

  visibilityChanged() {
    if (!this.context) return;
    if (document.hidden) {
      this.media?.pause();
      void this.context.suspend();
    } else if (this.started && this.enabled) void this.start();
  }

  get diagnostics() {
    let sum = 0;
    if (this.analyser) {
      this.analyser.getFloatTimeDomainData(this.samples);
      for (const sample of this.samples) sum += sample * sample;
    }
    return {
      enabled: this.enabled, started: this.started, playing: this.media ? !this.media.paused : false,
      contextState: this.context?.state ?? "not-started", sourceCount: this.media ? 1 : 0,
      currentTime: this.media?.currentTime ?? 0, duration: this.media?.duration ?? null,
      loop: this.media?.loop ?? true, targetGain: this.enabled ? this.level.gain : 0,
      gain: (this.gain?.gain.value ?? 0) * (this.master?.gain.value ?? 0), rms: Math.sqrt(sum / this.samples.length),
      nearestLight: this.level.lightId, distance: this.level.distance, error: this.error,
    };
  }
}
