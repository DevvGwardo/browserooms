import init, {
  NtscEffectBuf,
  NtscSettingsList,
  ResizeFilter,
  Rotation,
  type EffectOutput,
} from '../vendor/ntsc-rs/ntsc_rs_web_wrapper';
import wasmUrl from '../vendor/ntsc-rs/ntsc_rs_web_wrapper_bg.wasm?url';

export type FrameRequest = {
  type: 'frame';
  id: number;
  generation: number;
  frame: VideoFrame | ImageBitmap;
  width: number;
  height: number;
  frameNumber: number;
  settings: Record<string, number | boolean>;
  capturedAt: number;
};

const revision = 'ntsc-rs-web@76283f541173ac636f5935001ecdae93f31bb480/ntsc-rs@bddab2df789162391aa1981271a3d698a478f2e7';
const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<FrameRequest | { type: 'init' }>) => void): void;
};
let engine: ReturnType<typeof initialize> | undefined;
let busy = false;
let currentSettings = '';
let canvas: OffscreenCanvas | undefined;
let context: OffscreenCanvasRenderingContext2D | undefined;

async function initialize() {
  const { memory } = await init({ module_or_path: wasmUrl });
  const settingsList = new NtscSettingsList();
  try {
    const defaults = JSON.parse(settingsList.defaultPreset()) as Record<string, number | boolean>;
    return { memory, settingsList, defaults, effect: new NtscEffectBuf() };
  } catch (error) {
    settingsList.free();
    throw error;
  }
}

scope.addEventListener('message', async ({ data: request }) => {
  if (request.type === 'init') {
    try {
      await (engine ??= initialize());
      scope.postMessage({ type: 'ready', engine: 'ntsc-rs', revision });
    } catch (error) {
      engine = undefined;
      scope.postMessage({ type: 'error', message: String(error) });
    }
    return;
  }
  if (request.type !== 'frame') return;
  const { id, generation, frame, width, height, frameNumber, capturedAt } = request;
  if (busy) {
    frame.close();
    scope.postMessage({ type: 'error', id, generation, message: 'ntsc-rs worker is busy; only one frame may be in flight' });
    return;
  }
  busy = true;
  let output: EffectOutput | undefined;
  let bitmap: ImageBitmap | undefined;
  const startedAt = performance.now();
  try {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width > 4096 || height > 4096 || width * height > 2_097_152 ||
        !Number.isInteger(frameNumber) || frameNumber < 0) {
      throw new Error('Invalid ntsc-rs frame dimensions or frame number');
    }
    const { effect, settingsList, defaults, memory } = await (engine ??= initialize());
    const json = JSON.stringify({ ...defaults, ...request.settings, version: 1 });
    if (json !== currentSettings) {
      // setEffectSettings consumes the configurator; freeing it again would double-free.
      effect.setEffectSettings(settingsList.settingsFromJSON(json));
      currentSettings = json;
    }

    let copied = false;
    if (typeof VideoFrame !== 'undefined' && frame instanceof VideoFrame && frame.visibleRect) {
      const rect = frame.visibleRect;
      try {
        // The busy guard also covers this asynchronous write: no other WASM call may grow memory.
        await frame.copyTo(effect.inputBuffer(rect.width, rect.height), {
          format: 'RGBX', colorSpace: 'srgb', rect,
          layout: [{ offset: 0, stride: rect.width * 4 }],
        });
        copied = true;
      } catch {
        // Some browsers cannot copy GPU-backed frames to RGBX. Canvas also handles ImageBitmap.
      }
    }
    if (!copied) {
      if (!canvas) {
        canvas = new OffscreenCanvas(width, height);
        context = canvas.getContext('2d', { alpha: false, willReadFrequently: true }) ?? undefined;
      }
      if (!context) throw new Error('OffscreenCanvas 2D context is unavailable');
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.clearRect(0, 0, width, height);
      context.drawImage(frame, 0, 0, width, height);
      effect.inputBuffer(width, height).set(context.getImageData(0, 0, width, height).data);
    }

    output = effect.applyEffect(frameNumber, width, height, ResizeFilter.Bilinear,
      false, true, Rotation.None, 0, width, height, 0);
    if (output.width !== width || output.height !== height || output.len !== width * height * 4) {
      throw new Error('Unexpected ntsc-rs output dimensions');
    }
    // Own the pixels before any allocation/await, and explicitly make RGBX opaque RGBA.
    const rgba = new Uint8ClampedArray(memory.buffer, output.ptr, output.len).slice();
    for (let index = 3; index < rgba.length; index += 4) rgba[index] = 255;
    bitmap = await createImageBitmap(new ImageData(rgba, width, height), {
      premultiplyAlpha: 'none', colorSpaceConversion: 'none',
    });
    scope.postMessage({ type: 'frame', id, generation, bitmap, capturedAt,
      processMs: performance.now() - startedAt }, [bitmap]);
    bitmap = undefined;
  } catch (error) {
    scope.postMessage({ type: 'error', id, generation, message: String(error) });
  } finally {
    bitmap?.close();
    output?.free();
    frame.close();
    busy = false;
  }
});
