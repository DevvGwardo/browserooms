import { afterEach, beforeEach, expect, test } from "bun:test";
import { VhsPlayer } from "../src/vhs/player";

class Bitmap {
  width = 640;
  height = 480;
  closed = false;
  close() { this.closed = true; }
}

class TestWorker {
  static current: TestWorker;
  messages: any[] = [];
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: unknown;
  onmessageerror: unknown;
  terminated = false;
  constructor() { TestWorker.current = this; }
  postMessage(message: any) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  reply(message: any) { this.onmessage?.({ data: message }); }
  frameReply() {
    const frame = this.messages.findLast((message) => message.type === "frame");
    frame.frame.close();
    const bitmap = new Bitmap();
    this.reply({ type: "frame", id: frame.id, generation: frame.generation, bitmap,
      capturedAt: frame.capturedAt, processMs: 4 });
    return bitmap;
  }
}

const globals = ["Worker", "window", "VideoFrame", "createImageBitmap"] as const;
let descriptors: (PropertyDescriptor | undefined)[];
let player: VhsPlayer;
let view: { hidden: boolean; width: number; height: number; getContext: () => unknown };
let displayed: Bitmap[];

beforeEach(() => {
  descriptors = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  for (const [key, value] of Object.entries({ Worker: TestWorker, window: globalThis, VideoFrame: undefined,
    createImageBitmap: async () => new Bitmap() })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  displayed = [];
  view = { hidden: true, width: 0, height: 0,
    getContext: () => ({ transferFromImageBitmap: (bitmap: Bitmap) => { displayed.push(bitmap); bitmap.close(); } }) };
  player = new VhsPlayer({ width: 640, height: 480 } as HTMLCanvasElement, view as unknown as HTMLCanvasElement, () => {});
});

afterEach(() => {
  player.dispose();
  globals.forEach((key, index) => {
    if (descriptors[index]) Object.defineProperty(globalThis, key, descriptors[index]!);
    else Reflect.deleteProperty(globalThis, key);
  });
});

function ready() {
  player.setPreset("camcorder");
  TestWorker.current.reply({ type: "ready", engine: "ntsc-rs", revision: "test-revision" });
}

test("capture and worker processing share one bounded in-flight slot", async () => {
  ready();
  player.capture(100);
  await Promise.resolve();
  player.capture(200);
  player.capture(300);
  expect(TestWorker.current.messages.filter((message) => message.type === "frame").length).toBe(1);
  expect(player.diagnostics.queueDepth).toBe(1);
  TestWorker.current.frameReply();
  expect(player.diagnostics.queueDepth).toBe(0);
  expect(displayed.length).toBe(1);
  player.capture(400);
  await Promise.resolve();
  expect(TestWorker.current.messages.filter((message) => message.type === "frame").length).toBe(2);
});

test("changing presets discards older results rather than flashing the previous effect", async () => {
  ready();
  player.capture(100);
  await Promise.resolve();
  player.setPreset("worn");
  const old = TestWorker.current.frameReply();
  expect(old.closed).toBe(true);
  expect(displayed.length).toBe(0);
  player.capture(200);
  await Promise.resolve();
  TestWorker.current.frameReply();
  expect(displayed.length).toBe(1);
  expect(player.diagnostics.shownGeneration).toBe(player.diagnostics.generation);
});

test("clean mode hides tape output immediately and rejects in-flight frames", async () => {
  ready();
  player.capture(100);
  await Promise.resolve();
  player.setPreset("clean");
  expect(view.hidden).toBe(true);
  TestWorker.current.frameReply();
  expect(displayed.length).toBe(0);
  player.capture(200);
  expect(player.diagnostics.queueDepth).toBe(0);
});

test("resizing invalidates dimensions and returning from background uses a fresh frame", async () => {
  ready();
  player.capture(100);
  await Promise.resolve();
  player.invalidate();
  TestWorker.current.frameReply();
  expect(displayed.length).toBe(0);
  player.setVisible(false);
  player.capture(200);
  expect(player.diagnostics.queueDepth).toBe(0);
  player.setVisible(true);
  player.capture(300);
  await Promise.resolve();
  TestWorker.current.frameReply();
  expect(displayed.length).toBe(1);
});

test("processing errors restore the actual clean view and terminate the failed worker", () => {
  ready();
  const failed = TestWorker.current;
  failed.reply({ type: "error", message: "WASM failed" });
  expect(player.enabled).toBe(false);
  expect(player.error).toBe("WASM failed");
  expect(failed.terminated).toBe(true);
  expect(view.hidden).toBe(true);
  failed.reply({ type: "ready", engine: "ntsc-rs", revision: "stale" });
  expect(player.diagnostics.ready).toBe(false);
});
