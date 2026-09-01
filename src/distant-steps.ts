import * as THREE from "three";
import type { AudioBus } from "./light-ambience";

type Voice = { source: AudioBufferSourceNode; gain: GainNode; pan: PannerNode; stopping: boolean };

export class DistantSteps {
  error: string | null = null;
  tension = 0;
  private heard = 0;
  private wait = 14 + Math.random() * 10;
  private remaining = 0;
  private burstSize = 0;
  private side = 1;
  private behind = 20;
  private lateral = 7;
  private position = new THREE.Vector3();
  private voices = new Set<Voice>();
  private buffers: AudioBuffer[] = [];
  private preparing: Promise<void> | null = null;
  private lastClip = -1;
  private played = 0;
  private bursts = 0;

  constructor(private camera: THREE.PerspectiveCamera, private getBus: () => AudioBus | null, private changed: () => void) {}

  prepare(): Promise<void> {
    if (this.buffers.length) return Promise.resolve();
    if (this.preparing) return this.preparing;
    const bus = this.getBus();
    if (!bus) return Promise.resolve();
    this.preparing = (async () => {
      const response = await fetch("/audio/heavy-steps/manifest.json");
      if (!response.ok) throw new Error("Distant footsteps could not be loaded.");
      const manifest = await response.json() as { clips: { file: string }[] };
      this.buffers = await Promise.all(manifest.clips.map(async ({ file }) => {
        const response = await fetch(`/audio/heavy-steps/${encodeURIComponent(file)}`);
        if (!response.ok) throw new Error("A distant footstep could not be loaded.");
        return bus.context.decodeAudioData(await response.arrayBuffer());
      }));
      this.error = null;
    })().catch((error: unknown) => {
      this.error = error instanceof Error ? error.message : "Distant footstep audio unavailable.";
    }).finally(() => { this.preparing = null; this.changed(); });
    return this.preparing;
  }

  update(seconds: number, active: boolean, audible: boolean, lightThreat: number) {
    if (!active || document.hidden) { this.reset(); return; }
    const dt = Math.min(seconds, 0.1);
    const bus = this.getBus();
    const canHear = audible && bus?.context.state === "running" && this.buffers.length > 0;
    this.heard *= Math.exp(-dt / 9);
    if (!canHear) {
      this.stopVoices();
      if (this.remaining) { this.remaining = 0; this.wait = 12 + Math.random() * 15; }
      this.heard = 0;
    } else {
      this.wait -= dt;
      if (this.wait <= 0 && this.voices.size < 2) {
        if (!this.remaining) {
          this.remaining = this.burstSize = 4 + Math.floor(Math.random() * 3);
          this.side = Math.random() < 0.5 ? -1 : 1;
          this.behind = 14 + Math.random() * 10;
          this.lateral = 5 + Math.random() * 5;
          this.bursts++;
        }
        this.behind = Math.max(13, this.behind - 0.45 - Math.random() * 0.5);
        this.updatePosition();
        this.play(this.remaining === this.burstSize ? 0.38 : 0.65);
        const proximity = THREE.MathUtils.clamp((28 - Math.hypot(this.behind, this.lateral)) / 15, 0, 1);
        this.heard = Math.max(this.heard, 0.35 + proximity * 0.5);
        this.remaining--;
        this.wait = this.remaining ? 1.15 + Math.random() * 0.5 : 25 + Math.random() * 25;
      }
    }
    this.updatePosition();
    for (const voice of this.voices) {
      voice.pan.positionX.value = this.position.x;
      voice.pan.positionY.value = this.position.y;
      voice.pan.positionZ.value = this.position.z;
    }
    const target = Math.max(this.heard, lightThreat);
    this.tension = THREE.MathUtils.damp(this.tension, target, target > this.tension ? 0.9 : 0.16, dt);
    if (this.tension < 0.001) this.tension = 0;
  }

  private updatePosition() {
    // A listener-relative source stays behind-left/right even if the player turns around.
    const yaw = this.camera.rotation.y;
    this.position.set(
      this.camera.position.x + Math.sin(yaw) * this.behind + Math.cos(yaw) * this.lateral * this.side,
      0.15,
      this.camera.position.z + Math.cos(yaw) * this.behind - Math.sin(yaw) * this.lateral * this.side,
    );
  }

  private play(level: number) {
    const bus = this.getBus();
    if (!bus || !this.buffers.length) return;
    const index = this.buffers.length > 1 ? (this.lastClip + 1 + Math.floor(Math.random() * (this.buffers.length - 1))) % this.buffers.length : 0;
    this.lastClip = index;
    const source = bus.context.createBufferSource();
    source.buffer = this.buffers[index];
    source.playbackRate.value = 0.94 + Math.random() * 0.1;
    const gain = bus.context.createGain();
    gain.gain.setValueAtTime(0, bus.context.currentTime);
    gain.gain.linearRampToValueAtTime(level, bus.context.currentTime + 0.05);
    const pan = bus.context.createPanner();
    pan.panningModel = "HRTF";
    pan.distanceModel = "inverse";
    pan.refDistance = 8;
    pan.rolloffFactor = 0.8;
    pan.positionX.value = this.position.x; pan.positionY.value = this.position.y; pan.positionZ.value = this.position.z;
    source.connect(gain); gain.connect(pan); pan.connect(bus.output);
    const voice = { source, gain, pan, stopping: false };
    this.voices.add(voice);
    source.onended = () => { source.disconnect(); gain.disconnect(); pan.disconnect(); this.voices.delete(voice); };
    source.start();
    this.played++;
  }

  private stopVoices() {
    const bus = this.getBus();
    for (const voice of this.voices) {
      if (!bus || bus.context.state !== "running" || document.hidden) {
        voice.source.stop(); voice.source.disconnect(); voice.gain.disconnect(); voice.pan.disconnect(); this.voices.delete(voice);
      } else if (!voice.stopping) {
        voice.stopping = true;
        voice.gain.gain.cancelScheduledValues(bus.context.currentTime);
        voice.gain.gain.setTargetAtTime(0, bus.context.currentTime, 0.025);
        voice.source.stop(bus.context.currentTime + 0.15);
      }
    }
  }

  reset() {
    if (this.remaining || this.voices.size) this.wait = 14 + Math.random() * 16;
    this.remaining = 0; this.heard = 0; this.tension = 0;
    this.stopVoices();
  }

  get diagnostics() {
    return { tension: this.tension, heard: this.heard, remaining: this.remaining, nextIn: this.wait,
      played: this.played, bursts: this.bursts, activeVoices: this.voices.size, loadedSounds: this.buffers.length,
      position: this.position.toArray(), distance: Math.hypot(this.behind, this.lateral), side: this.side < 0 ? "left" : "right", error: this.error };
  }
}
