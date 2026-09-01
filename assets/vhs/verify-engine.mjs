// Run with PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node assets/vhs/verify-engine.mjs.
// Uses an isolated Vite server and headless Chrome, never the application's dev server or UI.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('../../', import.meta.url)),
  configFile: false, appType: 'custom', server: { host: '127.0.0.1', port: 0, strictPort: false } });
server.middlewares.use((request, response, next) => {
  if (request.url !== '/') return next();
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Engine verification</title>');
});
await server.listen();
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0]);
  const report = await page.evaluate(async () => {
    const ensure = (condition, message) => { if (!condition) throw new Error(message); };
    const base = `${location.origin}/src/vendor/ntsc-rs/`;
    const api = await import(`${base}ntsc_rs_web_wrapper.js`);
    const { memory } = await api.default({ module_or_path: `${base}ntsc_rs_web_wrapper_bg.wasm` });
    const list = new api.NtscSettingsList();
    const defaults = JSON.parse(list.defaultPreset());
    ensure(JSON.stringify(defaults) === JSON.stringify(await (await fetch(`${base}default-settings.json`)).json()), 'generated defaults differ');
    const effect = new api.NtscEffectBuf();
    effect.setEffectSettings(list.settingsFromJSON(JSON.stringify(defaults)));
    const width = 64, height = 48;
    const source = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      source[i] = x < 32 ? 230 : (x * 19) % 256;
      source[i + 1] = x < 32 ? 210 : (y * 17) % 256;
      source[i + 2] = x < 32 ? 50 : 180;
      source[i + 3] = 255;
    }
    let changed = 0, rawOpaque = true;
    for (let iteration = 0; iteration < 3000; iteration++) {
      effect.inputBuffer(width, height).set(source);
      const output = effect.applyEffect(iteration, width, height, api.ResizeFilter.Bilinear,
        false, iteration !== 0, api.Rotation.None, 0, width, height, 0);
      try {
        ensure(output.width === width && output.height === height && output.len === source.length, 'incorrect raw buffer dimensions');
        const pixels = new Uint8Array(memory.buffer, output.ptr, output.len);
        if (iteration === 0) ensure(pixels.every((value, i) => value === source[i]), 'disabled engine changes pixels');
        if (iteration === 1) {
          changed = pixels.reduce((count, value, i) => count + Number(i % 4 !== 3 && value !== source[i]), 0);
          rawOpaque = pixels.every((value, i) => i % 4 !== 3 || value === 255);
          ensure(changed > 1000, 'enabled engine did not change pixels');
        }
      } finally { output.free(); }
    }
    const warmMemory = memory.buffer.byteLength;
    for (let iteration = 0; iteration < 3000; iteration++) {
      effect.inputBuffer(width, height).set(source);
      effect.applyEffect(iteration, width, height, api.ResizeFilter.Bilinear,
        false, true, api.Rotation.None, 0, width, height, 0).free();
    }
    const finalMemory = memory.buffer.byteLength;
    ensure(warmMemory === finalMemory, 'WASM memory grows after warmup');
    effect.free();
    list.free();

    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').putImageData(new ImageData(source, width, height), 0, 0);
    const initBootstrapUrl = URL.createObjectURL(new Blob([`
      const originalFetch = self.fetch.bind(self);
      let failOnce = true;
      self.fetch = (...args) => {
        if (failOnce) { failOnce = false; return Promise.reject(new Error('injected WASM load failure')); }
        // Blob workers lack the HTTP base URL of the production module worker.
        if (typeof args[0] === 'string') args[0] = new URL(args[0], '${location.origin}').href;
        return originalFetch(...args);
      };
      await import('${location.origin}/src/vhs/engine.worker.ts');
      self.postMessage({type:'test-loaded'});
    `], { type: 'text/javascript' }));
    const directWorker = new Worker(initBootstrapUrl, { type: 'module' });
    const waitFor = (worker, predicate) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { worker.removeEventListener('message', listener); reject(new Error('worker response timeout')); }, 20000);
      const listener = ({ data }) => {
        if (!predicate(data)) return;
        clearTimeout(timeout); worker.removeEventListener('message', listener); resolve(data);
      };
      worker.addEventListener('message', listener);
    });
    await waitFor(directWorker, data => data.type === 'test-loaded');
    const failedInitPromise = waitFor(directWorker, data => data.type === 'ready' || data.type === 'error');
    directWorker.postMessage({ type: 'init' });
    const failedInit = await failedInitPromise;
    ensure(failedInit.type === 'error' && failedInit.message.includes('injected'), 'init failure was not reported');
    const readyPromise = waitFor(directWorker, data => data.type === 'ready' || data.type === 'error');
    directWorker.postMessage({ type: 'init' });
    const ready = await readyPromise;
    ensure(ready.type === 'ready' && ready.engine === 'ntsc-rs', `worker init failed: ${ready.message}`);
    directWorker.terminate();
    URL.revokeObjectURL(initBootstrapUrl);

    // Instrument resource methods in the same real worker realm, not mocked pixel processing.
    const bootstrap = new Blob([`
      import init, * as api from '${base}ntsc_rs_web_wrapper.js';
      const {memory} = await init({module_or_path: '${base}ntsc_rs_web_wrapper_bg.wasm'});
      const counts = { inputClosed: 0, outputFreed: 0, configured: 0, copyTo: 0, rejectedCopy: 0 };
      let rejectCopy = false, delayCopy = false;
      for (const type of [VideoFrame, ImageBitmap]) {
        const close = type.prototype.close;
        type.prototype.close = function() { counts.inputClosed++; return close.call(this); };
      }
      const free = api.EffectOutput.prototype.free;
      api.EffectOutput.prototype.free = function() { counts.outputFreed++; return free.call(this); };
      const configure = api.NtscEffectBuf.prototype.setEffectSettings;
      api.NtscEffectBuf.prototype.setEffectSettings = function(value) { counts.configured++; return configure.call(this, value); };
      const copy = VideoFrame.prototype.copyTo;
      VideoFrame.prototype.copyTo = function(...args) {
        counts.copyTo++;
        if (rejectCopy) { counts.rejectedCopy++; return Promise.reject(new DOMException('test unsupported format', 'NotSupportedError')); }
        if (delayCopy) return new Promise(resolve => setTimeout(resolve, 50)).then(() => copy.apply(this, args));
        return copy.apply(this, args);
      };
      self.addEventListener('message', ({data}) => {
        if(data.type === 'probe') {
          rejectCopy = data.rejectCopy ?? rejectCopy;
          delayCopy = data.delayCopy ?? delayCopy;
          self.postMessage({type:'probe', ...counts, memoryBytes:memory.buffer.byteLength});
        }
      });
      await import('${location.origin}/src/vhs/engine.worker.ts');
      self.postMessage({type:'test-loaded'});
    `], { type: 'text/javascript' });
    const bootstrapUrl = URL.createObjectURL(bootstrap);
    const worker = new Worker(bootstrapUrl, { type: 'module' });
    await waitFor(worker, data => data.type === 'test-loaded');
    const timings = [];
    let id = 0;
    const sendFrame = async (frame, extra = {}) => {
      const request = { type: 'frame', id: ++id, generation: 7, frame, width, height,
        frameNumber: id, settings: { use_field: 3 }, capturedAt: 1234, ...extra };
      const response = waitFor(worker, data => data.id === request.id);
      worker.postMessage(request, [frame]);
      return response;
    };
    const checkFrame = (response, w = width, h = height) => {
      ensure(response.type === 'frame', `worker render failed: ${response.message}`);
      ensure(response.generation === 7 && response.capturedAt === 1234, 'metadata changed');
      ensure(response.bitmap.width === w && response.bitmap.height === h, 'bitmap dimensions incorrect');
      const target = new OffscreenCanvas(w, h);
      const context = target.getContext('2d');
      context.drawImage(response.bitmap, 0, 0);
      const rgba = context.getImageData(0, 0, w, h).data;
      ensure(rgba.every((value, i) => i % 4 !== 3 || value === 255), 'bitmap is not opaque');
      response.bitmap.close();
      timings.push(response.processMs);
    };
    const probe = async (options = {}) => {
      const response = waitFor(worker, data => data.type === 'probe');
      worker.postMessage({ type: 'probe', ...options });
      return response;
    };
    checkFrame(await sendFrame(await createImageBitmap(canvas)));
    checkFrame(await sendFrame(new VideoFrame(canvas, { timestamp: 0 })));
    await probe({ rejectCopy: true });
    checkFrame(await sendFrame(new VideoFrame(canvas, { timestamp: 1 })));
    await probe({ rejectCopy: false });
    checkFrame(await sendFrame(new VideoFrame(canvas, { timestamp: 2 }), { width: 853, height: 479 } ), 853, 479);
    for (let n = 0; n < 20; n++) checkFrame(await sendFrame(await createImageBitmap(canvas), { width: 854, height: 480 }), 854, 480);
    const invalid = await sendFrame(await createImageBitmap(canvas), { width: 0 });
    ensure(invalid.type === 'error' && invalid.generation === 7, 'invalid frame did not report error');
    checkFrame(await sendFrame(await createImageBitmap(canvas)));
    const invalidSettings = await sendFrame(await createImageBitmap(canvas), { settings: { use_field: 999 } });
    ensure(invalidSettings.type === 'error', 'invalid settings did not report error');
    checkFrame(await sendFrame(await createImageBitmap(canvas)));
    await probe({ delayCopy: true });
    const firstInput = new VideoFrame(canvas, { timestamp: 3 });
    const secondInput = await createImageBitmap(canvas);
    const first = sendFrame(firstInput);
    const second = sendFrame(secondInput);
    const concurrent = await Promise.all([first, second]);
    ensure(concurrent[0].type === 'frame' && concurrent[1].type === 'error' && concurrent[1].message.includes('busy'), 'busy guard did not reject overlapping work');
    for (const response of concurrent) if (response.type === 'frame') checkFrame(response);
    const metrics = await probe();
    ensure(metrics.inputClosed === id, `unclosed inputs: ${metrics.inputClosed}/${id}`);
    ensure(metrics.outputFreed === timings.length, 'output handle leak');
    ensure(metrics.configured === 1, 'identical settings were unnecessarily reapplied');
    ensure(metrics.copyTo === 4 && metrics.rejectedCopy === 1, 'VideoFrame and fallback branches not exercised');
    worker.terminate();
    URL.revokeObjectURL(bootstrapUrl);
    return { revision: ready.revision, changedRgbComponents: changed, rawOpaque,
      rawFrames: 6000, warmMemory, finalMemory, workerFrames: timings.length,
      workerMetrics: metrics, processingMs: timings,
      errorsRecovered: ['initialization fetch failure', 'invalid dimensions', 'invalid settings'], busyGuard: true };
  });
  assert(report.changedRgbComponents > 0);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await server.close();
}
