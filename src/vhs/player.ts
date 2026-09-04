import { getVhsPreset, type VhsPreset } from "./presets";

type WorkerReply = {
  type: "ready"; engine: string; revision: string;
} | {
  type: "frame"; id: number; generation: number; bitmap: ImageBitmap; capturedAt: number; processMs: number;
} | {
  type: "error"; id?: number; generation?: number; message: string;
};

/** A single pending frame spans capture and processing. Never queue a backlog behind the player. */
export class VhsPlayer {
  preset: VhsPreset = getVhsPreset("clean");
  error: string | null = null;
  /** Governor-set: halve the tape fps (every other frame) on the weakest step. */
  throttled = false;
  private worker: Worker | null = null;
  private workerReady = false;
  private generation = 0;
  private nextId = 0;
  private pending: { id: number; generation: number } | null = null;
  private watchdog: number | null = null;
  private lastCapture = -Infinity;
  private visible = true;
  private disposed = false;
  private bitmapContext: ImageBitmapRenderingContext | null;
  private context2d: CanvasRenderingContext2D | null;
  private revision = "";
  private processed = 0;
  private skipped = 0;
  private discarded = 0;
  private lastProcessMs = 0;
  private lastLatencyMs = 0;
  private outputWidth = 0;
  private outputHeight = 0;
  private shownGeneration = -1;
  private frameWindowStart = 0;
  private frameWindowCount = 0;
  private tapeFps = 0;
  private preferVideoFrame = typeof VideoFrame !== "undefined";

  constructor(private source: HTMLCanvasElement, private view: HTMLCanvasElement, private changed: () => void) {
    this.bitmapContext = view.getContext("bitmaprenderer");
    this.context2d = this.bitmapContext ? null : view.getContext("2d", { alpha: false });
    this.view.hidden = true;
  }

  get enabled() { return this.preset.id !== "clean"; }

  setPreset(id: string) {
    if (this.disposed) return;
    this.preset = getVhsPreset(id);
    this.generation++;
    this.lastCapture = -Infinity;
    this.frameWindowStart = 0;
    this.frameWindowCount = 0;
    this.error = null;
    if (!this.enabled) {
      this.view.hidden = true;
      this.tapeFps = 0;
    } else if (!this.worker) this.initialize();
    this.changed();
  }

  private initialize() {
    try {
      if (!this.bitmapContext && !this.context2d) throw new Error("This browser cannot display processed video frames.");
      const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
      this.worker = worker;
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        if (this.worker === worker && !this.disposed) this.receive(event.data);
        else if (event.data.type === "frame") event.data.bitmap.close();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (this.worker === worker) this.fail(event.message || "The tape processor stopped.");
      };
      worker.onmessageerror = () => { if (this.worker === worker) this.fail("The browser could not transfer a video frame."); };
      this.armWatchdog(20000);
      this.worker.postMessage({ type: "init" });
    } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
  }

  /** Call immediately after rendering, before the WebGL drawing buffer is released. */
  capture(now: number) {
    if (!this.enabled || !this.workerReady || !this.visible || this.disposed) return;
    if (this.source.width < 2 || this.source.height < 2) return;
    const fps = this.throttled ? this.preset.fps / 2 : this.preset.fps;
    if (now - this.lastCapture < 1000 / fps - 0.5) return;
    if (this.pending) { this.skipped++; return; }
    const id = ++this.nextId;
    const generation = this.generation;
    const width = this.source.width, height = this.source.height;
    this.pending = { id, generation };
    this.lastCapture = now;
    this.armWatchdog(10000);
    const send = (frame: VideoFrame | ImageBitmap) => {
      if (!this.worker || this.disposed || generation !== this.generation || !this.enabled || !this.visible) {
        frame.close();
        this.finishPending(id);
        this.discarded++;
        return;
      }
      try {
        this.worker.postMessage({ type: "frame", id, generation, frame, width, height,
          frameNumber: Math.floor(now * this.preset.fps / 1000), settings: this.preset.settings, capturedAt: now }, [frame]);
      } catch (error) {
        frame.close();
        this.fail(error instanceof Error ? error.message : String(error));
      }
    };
    if (this.preferVideoFrame) {
      try {
        send(new VideoFrame(this.source, { timestamp: Math.round(now * 1000) }));
        return;
      } catch { this.preferVideoFrame = false; }
    }
    createImageBitmap(this.source).then(send, (error) => this.fail(error instanceof Error ? error.message : String(error)));
  }

  invalidate() {
    this.generation++;
    this.lastCapture = -Infinity;
    this.view.hidden = true;
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.generation++;
    this.lastCapture = -Infinity;
    this.frameWindowStart = 0;
    this.frameWindowCount = 0;
    this.view.hidden = true;
    if (!visible) this.clearWatchdog();
    else if (this.pending) this.armWatchdog(10000);
    else if (this.worker && !this.workerReady) this.armWatchdog(20000);
  }

  private receive(message: WorkerReply) {
    if (message.type === "ready") {
      this.clearWatchdog();
      this.workerReady = true;
      this.revision = message.revision;
      this.changed();
      return;
    }
    if (message.type === "error") {
      this.fail(message.message);
      return;
    }
    const expected = this.pending?.id === message.id;
    this.finishPending(message.id);
    if (!expected || message.generation !== this.generation || !this.enabled || !this.visible || this.disposed) {
      message.bitmap.close();
      this.discarded++;
      return;
    }
    const width = message.bitmap.width, height = message.bitmap.height;
    if (this.view.width !== width || this.view.height !== height) { this.view.width = width; this.view.height = height; }
    if (this.bitmapContext) this.bitmapContext.transferFromImageBitmap(message.bitmap);
    else this.context2d!.drawImage(message.bitmap, 0, 0);
    message.bitmap.close();
    this.outputWidth = width;
    this.outputHeight = height;
    this.view.hidden = false;
    this.shownGeneration = message.generation;
    this.lastProcessMs = message.processMs;
    this.lastLatencyMs = performance.now() - message.capturedAt;
    this.processed++;
    const time = performance.now();
    if (!this.frameWindowStart) this.frameWindowStart = time;
    this.frameWindowCount++;
    if (time - this.frameWindowStart >= 1000) {
      this.tapeFps = Math.max(0, this.frameWindowCount - 1) * 1000 / (time - this.frameWindowStart);
      this.frameWindowCount = 1;
      this.frameWindowStart = time;
    }
  }

  private finishPending(id: number) {
    if (this.pending?.id !== id) return;
    this.pending = null;
    this.clearWatchdog();
  }

  private armWatchdog(milliseconds: number) {
    this.clearWatchdog();
    this.watchdog = window.setTimeout(() => this.fail("VHS processing timed out. Clean view has been restored."), milliseconds);
  }

  private clearWatchdog() {
    if (this.watchdog !== null) window.clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private fail(message: string) {
    this.error = message;
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    this.pending = null;
    this.clearWatchdog();
    this.generation++;
    this.preset = getVhsPreset("clean");
    this.view.hidden = true;
    this.changed();
  }

  dispose() {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.clearWatchdog();
    this.pending = null;
    this.view.width = 0;
    this.view.height = 0;
    this.view.hidden = true;
  }

  get diagnostics() {
    return { preset: this.preset.id, enabled: this.enabled, ready: this.workerReady,
      engine: this.workerReady ? "ntsc-rs" : null, revision: this.revision,
      processedFrames: this.processed, queueDepth: this.pending ? 1 : 0, skipped: this.skipped,
      discarded: this.discarded, processMs: this.lastProcessMs, latencyMs: this.lastLatencyMs,
      tapeFps: this.tapeFps, resolution: [this.outputWidth, this.outputHeight],
      generation: this.generation, shownGeneration: this.shownGeneration, error: this.error };
  }
}
