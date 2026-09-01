import type { AudioBus } from "./light-ambience";

export class StepCadence {
  phase = 0;
  steps = 0;
  private moving = false;

  advance(distance: number, seconds: number, running: boolean) {
    if (!Number.isFinite(distance) || !Number.isFinite(seconds) || seconds <= 0 || distance / seconds < 0.22) {
      this.reset();
      return false;
    }
    // The source averages 0.480s between impacts, about 1.03m at our walking speed.
    const stride = running ? 1.2 : 1.03;
    if (!this.moving) { this.phase = 1 - 0.15 / stride; this.moving = true; }
    this.phase += distance / stride;
    if (this.phase < 1) return false;
    this.phase %= 1;
    this.steps++;
    return true;
  }

  reset() { this.phase = 0; this.moving = false; }
}

type Voice = { source: AudioBufferSourceNode; gain: GainNode; pan: StereoPannerNode; stopping: boolean };

export class Footsteps {
  error: string | null = null;
  readonly cadence = new StepCadence();
  private buffers: AudioBuffer[] = [];
  private files: string[] = [];
  private preparing: Promise<void> | null = null;
  private voices = new Set<Voice>();
  private bag: number[] = [];
  private lastIndex = -1;
  private played = 0;
  private lastStarted = 0;

  constructor(private getBus: () => AudioBus | null, private changed: () => void) {}

  prepare(): Promise<void> {
    if (this.buffers.length) return Promise.resolve();
    if (this.preparing) return this.preparing;
    const bus = this.getBus();
    if (!bus) return Promise.resolve();
    this.preparing = (async () => {
      const response = await fetch("/audio/footsteps/manifest.json");
      if (!response.ok) throw new Error("Footstep clips could not be loaded.");
      const manifest = await response.json() as { version: number; clips: { file: string }[] };
      if (manifest.version !== 1 || !manifest.clips?.length || manifest.clips.length > 32) throw new Error("Invalid footstep clip set.");
      const files = manifest.clips.map((clip) => clip.file);
      const buffers = await Promise.all(files.map(async (file) => {
        const response = await fetch(`/audio/footsteps/${encodeURIComponent(file)}`);
        if (!response.ok) throw new Error(`Footstep clip unavailable: ${file}`);
        const buffer = await bus.context.decodeAudioData(await response.arrayBuffer());
        if (buffer.duration < 0.05 || buffer.duration > 1) throw new Error(`Invalid footstep duration: ${file}`);
        return buffer;
      }));
      this.buffers = buffers;
      this.files = files;
      this.error = null;
      this.changed();
    })().catch((error: unknown) => {
      this.error = error instanceof Error ? error.message : "Footsteps could not be prepared.";
      this.changed();
    }).finally(() => { this.preparing = null; });
    return this.preparing;
  }

  advance(distance: number, seconds: number, running: boolean, enabled: boolean) {
    if (!this.cadence.advance(distance, seconds, running) || !enabled) return;
    const bus = this.getBus();
    if (!bus || bus.context.state !== "running" || !this.buffers.length || this.voices.size >= 2) return;
    if (!this.bag.length) {
      this.bag = this.buffers.map((_, i) => i);
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
      if (this.bag.length > 1 && this.bag.at(-1) === this.lastIndex) {
        [this.bag[0], this.bag[this.bag.length - 1]] = [this.bag[this.bag.length - 1], this.bag[0]];
      }
    }
    const index = this.bag.pop()!;
    const source = bus.context.createBufferSource();
    const gain = bus.context.createGain();
    const pan = bus.context.createStereoPanner();
    source.buffer = this.buffers[index];
    source.playbackRate.value = (running ? 1.025 : 0.985) + Math.random() * 0.03;
    gain.gain.value = (running ? 0.63 : 0.55) * (0.97 + Math.random() * 0.06);
    pan.pan.value = this.played % 2 ? 0.055 : -0.055;
    source.connect(gain);
    gain.connect(pan);
    pan.connect(bus.output);
    const voice = { source, gain, pan, stopping: false };
    this.voices.add(voice);
    source.onended = () => {
      source.disconnect(); gain.disconnect(); pan.disconnect();
      this.voices.delete(voice);
    };
    source.start();
    this.lastIndex = index;
    this.lastStarted = bus.context.currentTime;
    this.played++;
  }

  reset() {
    this.cadence.reset();
    const bus = this.getBus();
    for (const voice of this.voices) {
      if (!bus || bus.context.state !== "running" || document.hidden) {
        voice.source.stop();
        voice.source.disconnect(); voice.gain.disconnect(); voice.pan.disconnect();
        this.voices.delete(voice);
      } else if (!voice.stopping) {
        voice.stopping = true;
        voice.gain.gain.setTargetAtTime(0, bus.context.currentTime, 0.004);
        voice.source.stop(bus.context.currentTime + 0.025);
      }
    }
  }

  get diagnostics() {
    return { ready: this.buffers.length > 0, loadedClips: this.buffers.length,
      activeVoices: this.voices.size, played: this.played, lastClip: this.files[this.lastIndex] ?? null,
      lastStarted: this.lastStarted, phase: this.cadence.phase, error: this.error };
  }
}
