import type { AudioBus } from "./light-ambience";

type TrackId = "intro" | "calm" | "tense";
type Track = {
  id: TrackId;
  title: string;
  trim: number;
  media: HTMLAudioElement;
  gain: GainNode | null;
  source: MediaElementAudioSourceNode | null;
  blocked: boolean;
  error: string | null;
  pending: boolean;
  attempt: number;
  playCalls: number;
};
type Fade = { from: TrackId; to: TrackId; elapsed: number; duration: number; hold: number };

export class Soundtrack {
  private bus: AudioBus | null = null;
  private started = false;
  private entered = false;
  private enabled = true;
  private hidden = document.hidden;
  private active = false;
  private current: TrackId = "intro";
  private fade: Fade | null = null;
  private dwell = 0;
  private high = 0;
  private low = 0;
  private duck = 1;
  private busError: string | null = null;
  private tracks: Track[];

  constructor(private getBus: () => AudioBus) {
    // Short ffmpeg samples: loudest mean -10.8/-13.2/-13.3 dBFS, all peaks 0.
    // Match those sections near -17 dBFS before the title/gameplay level.
    this.tracks = ([
      ["intro", "Handprint", "/audio/music/handprint.mp3", 0.5],
      ["calm", "The Untrained Mind", "/audio/music/the-untrained-mind.mp3", 0.65],
      ["tense", "Local Network", "/audio/music/local-network.mp3", 0.65],
    ] as const).map(([id, title, path, trim]) => {
      const media = new Audio();
      media.preload = "none";
      media.loop = true;
      media.src = path;
      const track: Track = { id, title, trim, media, gain: null, source: null,
        blocked: false, error: null, pending: false, attempt: 0, playCalls: 0 };
      media.addEventListener("error", () => {
        track.error = `${title} could not be loaded (media error ${media.error?.code ?? "unknown"}).`;
        this.pause(track);
      });
      return track;
    });
  }

  startIntro(): void {
    if (this.started) return;
    this.started = true;
    this.playWanted(false);
  }

  enter(): void {
    this.entered = true;
    this.active = true;
    this.resume();
  }

  resume(): void {
    this.started = true;
    this.enabled = true;
    this.hidden = document.hidden;
    if (this.entered && this.current === "intro" && !this.fade) {
      // Even a blocked title gets an audible moment after the Enter gesture.
      this.fade = { from: "intro", to: "calm", elapsed: 0, duration: 10, hold: 1 };
    }
    this.playWanted(true);
  }

  visibilityChanged(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) this.tracks.forEach((track) => this.pause(track));
    else if (this.started && this.enabled) this.playWanted(true);
  }

  private wanted(track: Track): boolean {
    return track.id === this.current || track.id === this.fade?.to;
  }

  private pause(track: Track): void {
    track.attempt++;
    track.pending = false;
    track.media.pause();
  }

  private playWanted(retry: boolean): void {
    if (this.hidden || !this.enabled) return;
    try {
      this.bus ??= this.getBus();
      for (const track of this.tracks) {
        if (!track.gain) {
          track.gain = this.bus.context.createGain();
          track.gain.gain.value = 0;
          track.gain.connect(this.bus.output);
        }
        if (!track.source) {
          track.source = this.bus.context.createMediaElementSource(track.media);
          track.source.connect(track.gain);
        }
        if (retry) {
          track.blocked = false;
          track.error = null;
        }
      }
      this.busError = null;
      this.applyGains();
      // Invoke resume AND play synchronously in the originating gesture, never after await.
      void this.bus.context.resume().then(() => {
        if (this.hidden || !this.enabled) return;
        for (const track of this.tracks) if (this.wanted(track)) this.play(track);
      }).catch((error: unknown) => {
        this.busError = error instanceof Error ? error.message : "Tap to enable music.";
      });
      for (const track of this.tracks) if (this.wanted(track)) this.play(track);
    } catch (error) {
      this.busError = error instanceof Error ? error.message : "Music could not be initialized.";
    }
  }

  private play(track: Track): void {
    if (!track.source || track.pending || track.blocked || track.error || !track.media.paused) return;
    const attempt = ++track.attempt;
    track.pending = true;
    track.playCalls++;
    const failed = (error: unknown) => {
      if (attempt !== track.attempt) return;
      track.pending = false;
      const name = error instanceof Error ? error.name : "";
      if (name === "NotAllowedError") track.blocked = true;
      else track.error = `${track.title}: ${error instanceof Error ? error.message : "Playback failed."}`;
    };
    try {
      if (track.media.error) track.media.load();
      void track.media.play().then(() => {
        if (attempt !== track.attempt) return;
        track.pending = false;
        track.blocked = false;
        if (this.hidden || !this.enabled || !this.wanted(track)) this.pause(track);
      }).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  update(seconds: number, tension: number, active: boolean, enabled: boolean): void {
    this.active = active;
    if (this.enabled !== enabled) {
      this.enabled = enabled;
      if (!enabled) this.tracks.forEach((track) => this.pause(track));
      // Enabling is retried by resume() in the click, not by the render loop.
    }
    if (!this.started || !this.bus || this.hidden || !enabled) return;
    if (this.bus.context.state !== "running") {
      // A media element can otherwise advance silently behind a suspended context.
      for (const track of this.tracks) if (!track.media.paused || track.pending) this.pause(track);
      return;
    }
    const dt = Number.isFinite(seconds) ? Math.min(0.25, Math.max(0, seconds)) : 0;
    this.duck += ((this.entered && !active ? 0.8 : 1) - this.duck) * (1 - Math.exp(-dt / 1.5));
    const playing = (id: TrackId) => this.tracks.some((track) =>
      track.id === id && !track.media.paused && track.media.readyState >= 3);

    if (this.fade) {
      const incoming = this.tracks.find((track) => track.id === this.fade!.to)!;
      if (incoming.error) {
        // Keep the outgoing song if the next file fails; surface the failure.
        this.pause(incoming);
        this.fade = null;
        this.dwell = 0;
        this.high = this.low = 0;
      } else if ((!this.entered || active) && playing(this.fade.to)) {
        const outgoing = this.tracks.find((track) => track.id === this.fade!.from)!;
        if (playing(this.fade.from) || outgoing.error) {
          this.fade.elapsed += dt;
          if (this.fade.elapsed >= this.fade.duration + this.fade.hold) {
            outgoing.gain!.gain.value = 0;
            this.pause(outgoing);
            this.current = this.fade.to;
            this.fade = null;
            this.dwell = 0;
            this.high = this.low = 0;
          }
        }
      }
    } else if (this.entered && active && this.current !== "intro" && playing(this.current)) {
      this.dwell += dt;
      this.high = tension > 0.5 ? this.high + dt : 0;
      this.low = tension < 0.25 ? this.low + dt : 0;
      const next = this.current === "calm" && this.high >= 2 ? "tense"
        : this.current === "tense" && this.low >= 12 ? "calm" : null;
      if (next && this.dwell >= 25) {
        const track = this.tracks.find((item) => item.id === next)!;
        if (!track.blocked && !track.error) {
          this.fade = { from: this.current, to: next, elapsed: 0, duration: 10, hold: 0 };
          this.play(track);
        }
      }
    }
    this.applyGains();
  }

  private applyGains(): void {
    if (!this.bus) return;
    const progress = this.fade ? Math.min(1, Math.max(0, (this.fade.elapsed - this.fade.hold) / this.fade.duration)) : 0;
    const blend = progress * progress * (3 - 2 * progress);
    for (const track of this.tracks) {
      if (!track.gain) continue;
      const weight = this.fade ? (track.id === this.fade.from ? 1 - blend : track.id === this.fade.to ? blend : 0)
        : track.id === this.current ? 1 : 0;
      const level = track.id === "intro" ? 0.35 : 0.16;
      track.gain.gain.setTargetAtTime(weight * level * track.trim * this.duck, this.bus.context.currentTime, 0.04);
    }
  }

  get error(): string | null {
    return this.busError ?? this.tracks.find((track) => track.error)?.error
      ?? (this.tracks.some((track) => track.blocked && this.wanted(track)) ? "Tap Enter or enable sound to start music." : null);
  }

  get diagnostics() {
    return {
      started: this.started, title: !this.entered, entered: this.entered,
      enabled: this.enabled, hidden: this.hidden, active: this.active,
      blocked: this.tracks.some((track) => track.blocked && this.wanted(track))
        || (this.started && this.enabled && !this.hidden && this.bus?.context.state === "suspended"),
      current: this.current, target: this.fade?.to ?? this.current,
      contextState: this.bus?.context.state ?? "not-started",
      sourceCount: this.tracks.filter((track) => track.source).length,
      fade: this.fade ? { ...this.fade } : null,
      dwell: this.dwell, highTensionSeconds: this.high, lowTensionSeconds: this.low,
      duck: this.duck, error: this.error,
      tracks: this.tracks.map((track) => ({
        id: track.id, title: track.title, src: track.media.src,
        playing: !track.media.paused, pending: track.pending, blocked: track.blocked,
        volume: track.gain?.gain.value ?? 0, trim: track.trim,
        currentTime: track.media.currentTime,
        duration: Number.isFinite(track.media.duration) ? track.media.duration : null,
        readyState: track.media.readyState, networkState: track.media.networkState,
        loop: track.media.loop, playCalls: track.playCalls, error: track.error,
      })),
    };
  }
}
