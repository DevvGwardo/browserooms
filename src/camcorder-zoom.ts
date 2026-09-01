import type { PerspectiveCamera } from "three";
import type { AudioBus } from "./light-ambience";

type MotorVoice = { source: AudioBufferSourceNode; envelope: GainNode; direction: number; stopping: boolean; index: number };

export class CamcorderZoom {
  error: string | null = null;
  private stops = 0;
  private rate = 0;
  private readonly maxStops = 3;
  private readonly maxRate = 0.52;
  private buffers: AudioBuffer[] = [];
  private files: string[] = [];
  private preparing: Promise<void> | null = null;
  private level: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private samples = new Float32Array(512);
  private voices = new Set<MotorVoice>();
  private voice: MotorVoice | null = null;
  private lastIndex = -1;

  constructor(private camera: PerspectiveCamera, private getBus: () => AudioBus | null, private changed: () => void) {}

  prepare(): Promise<void> {
    if (this.buffers.length) return Promise.resolve();
    if (this.preparing) return this.preparing;
    const bus = this.getBus();
    if (!bus) return Promise.resolve();
    if (!this.level) {
      this.level = bus.context.createGain();
      this.level.gain.value = 0;
      this.analyser = bus.context.createAnalyser();
      this.analyser.fftSize = this.samples.length;
      this.level.connect(this.analyser);
      this.analyser.connect(bus.output);
    }
    this.preparing = (async () => {
      const response = await fetch("/audio/zoom/manifest.json");
      if (!response.ok) throw new Error("Lens sounds could not be loaded.");
      const manifest = await response.json() as { version: number; clips: { file: string }[] };
      if (manifest.version !== 1 || !manifest.clips?.length) throw new Error("Invalid lens sound set.");
      const files = manifest.clips.map((clip) => clip.file);
      const buffers = await Promise.all(files.map(async (file) => {
        const response = await fetch(`/audio/zoom/${encodeURIComponent(file)}`);
        if (!response.ok) throw new Error(`Lens sound unavailable: ${file}`);
        return bus.context.decodeAudioData(await response.arrayBuffer());
      }));
      this.files = files;
      this.buffers = buffers;
      this.error = null;
      this.changed();
    })().catch((error: unknown) => {
      this.error = error instanceof Error ? error.message : "Lens audio could not be prepared.";
      this.changed();
    }).finally(() => { this.preparing = null; });
    return this.preparing;
  }

  update(seconds: number, direction: number, audible: boolean) {
    const delta = Math.max(0, Math.min(seconds, 0.25));
    if ((this.stops <= 0 && direction < 0) || (this.stops >= this.maxStops && direction > 0)) direction = 0;
    const target = direction * this.maxRate;
    const tau = direction ? 0.14 : 0.065;
    const decay = Math.exp(-delta / tau);
    const previous = this.stops;
    // Integrate motor velocity in logarithmic focal-length space, not linear FOV degrees.
    this.stops += target * delta + (this.rate - target) * tau * (1 - decay);
    this.rate = target + (this.rate - target) * decay;
    if (this.stops <= 0) { this.stops = 0; this.rate = Math.max(0, this.rate); }
    if (this.stops >= this.maxStops) { this.stops = this.maxStops; this.rate = Math.min(0, this.rate); }
    if (!direction && Math.abs(this.rate) < 0.001) this.rate = 0;
    if (Math.abs(this.stops - previous) > 1e-8) {
      this.camera.zoom = 2 ** this.stops;
      this.camera.updateProjectionMatrix();
    }
    const moving = Math.abs(this.stops - previous) > 1e-8 && Math.abs(this.rate) > 0.006;
    this.updateSound(moving && audible, Math.sign(this.rate));
  }

  private updateSound(moving: boolean, direction: number) {
    const bus = this.getBus();
    if (!moving || !bus || bus.context.state !== "running" || !this.buffers.length || !this.level) {
      this.stopSound();
      return;
    }
    const now = bus.context.currentTime;
    const speed = Math.min(1, Math.abs(this.rate) / this.maxRate);
    this.level.gain.setTargetAtTime(0.55 * Math.sqrt(speed), now, 0.04);
    if (this.voice && this.voice.direction !== direction) this.stopSound();
    if (!this.voice && this.voices.size < 2) {
      const index = (this.lastIndex + 1) % this.buffers.length;
      const source = bus.context.createBufferSource();
      source.buffer = this.buffers[index];
      source.loop = true;
      const envelope = bus.context.createGain();
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(1, now + 0.04);
      source.connect(envelope);
      envelope.connect(this.level);
      const voice = { source, envelope, direction, stopping: false, index };
      this.voices.add(voice);
      this.voice = voice;
      source.onended = () => {
        source.disconnect(); envelope.disconnect();
        this.voices.delete(voice);
        if (this.voice === voice) this.voice = null;
      };
      source.start();
      this.lastIndex = index;
    }
    this.voice?.source.playbackRate.setTargetAtTime(0.80 + 0.20 * speed + (direction < 0 ? -0.02 : 0), now, 0.05);
  }

  private stopSound() {
    const bus = this.getBus();
    this.voice = null;
    for (const voice of this.voices) {
      if (!bus || bus.context.state !== "running" || document.hidden) {
        voice.source.stop();
        voice.source.disconnect(); voice.envelope.disconnect();
        this.voices.delete(voice);
      } else if (!voice.stopping) {
        voice.stopping = true;
        voice.envelope.gain.cancelScheduledValues(bus.context.currentTime);
        voice.envelope.gain.setTargetAtTime(0, bus.context.currentTime, 0.008);
        voice.source.stop(bus.context.currentTime + 0.045);
      }
    }
  }

  stop() {
    this.rate = 0;
    this.stopSound();
  }

  reset() {
    this.stop();
    this.stops = 0;
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
  }

  get diagnostics() {
    let sum = 0;
    if (this.analyser) {
      this.analyser.getFloatTimeDomainData(this.samples);
      for (const sample of this.samples) sum += sample * sample;
    }
    return { magnification: this.camera.zoom, effectiveFov: this.camera.getEffectiveFOV(),
      rate: this.rate, min: 1, max: 2 ** this.maxStops, loadedSounds: this.buffers.length,
      activeVoices: this.voices.size, moving: Math.abs(this.rate) > 0.006,
      sound: this.voice ? this.files[this.voice.index] : null, rms: Math.sqrt(sum / this.samples.length), error: this.error };
  }
}
