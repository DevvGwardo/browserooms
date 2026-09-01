import { expect, test } from "bun:test";
import init, { NtscEffectBuf, NtscSettingsList, ResizeFilter, Rotation } from "../src/vendor/ntsc-rs/ntsc_rs_web_wrapper.js";
import { VHS_PRESETS } from "../src/vhs/presets";

const { memory } = await init({ module_or_path: await Bun.file(new URL("../src/vendor/ntsc-rs/ntsc_rs_web_wrapper_bg.wasm", import.meta.url)).arrayBuffer() });
const width = 320, height = 240;
const input = new Uint8Array(width * height * 4);
const colors = [[185, 176, 85], [248, 248, 219], [38, 34, 14], [96, 96, 96]];
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  input.set([...colors[Math.floor(x / 80)], 255], (y * width + x) * 4);
}

function meanColor(pixels: Uint8Array, from: number, to: number) {
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = 30; y < 190; y++) for (let x = from; x < to; x++) {
    for (let channel = 0; channel < 3; channel++) sum[channel] += pixels[(y * width + x) * 4 + channel];
    count++;
  }
  return sum.map((value) => value / count);
}

test("all VHS presets run through the real engine and preserve yellow walls and warm whites", () => {
  const settings = new NtscSettingsList();
  const defaults = JSON.parse(settings.defaultPreset());
  const outputs: string[] = [];
  try {
    for (const preset of VHS_PRESETS.filter((preset) => preset.id !== "clean")) {
      const effect = new NtscEffectBuf();
      try {
        const json = JSON.stringify({ ...defaults, ...preset.settings, version: 1 });
        expect(() => settings.parsePreset(json)).not.toThrow();
        effect.setEffectSettings(settings.settingsFromJSON(json));
        effect.inputBuffer(width, height).set(input);
        const result = effect.applyEffect(12, width, height, ResizeFilter.Nearest, false, true, Rotation.None, 0, width, height, 0);
        const pixels = new Uint8Array(memory.buffer, result.ptr, result.len).slice();
        result.free();
        expect(pixels.length).toBe(input.length);
        expect(pixels.some((value, i) => i % 4 !== 3 && value !== input[i])).toBe(true);
        const yellow = meanColor(pixels, 20, 65);
        const white = meanColor(pixels, 100, 140);
        expect(Math.min(yellow[0], yellow[1])).toBeGreaterThan(130);
        expect(yellow[2]).toBeLessThan(Math.min(yellow[0], yellow[1]) * 0.7);
        expect(Math.min(...white)).toBeGreaterThan(180);
        expect(Math.max(...white) - Math.min(...white)).toBeLessThan(65);
        outputs.push(new Bun.CryptoHasher("sha256").update(pixels).digest("hex"));
      } finally { effect.free(); }
    }
  } finally { settings.free(); }
  expect(new Set(outputs).size).toBe(outputs.length);
});

test("frame processing reuses bounded WASM buffers and advances real temporal artifacts", () => {
  const settings = new NtscSettingsList();
  const effect = new NtscEffectBuf();
  try {
    effect.setEffectSettings(settings.settingsFromJSON(JSON.stringify({ ...JSON.parse(settings.defaultPreset()), ...VHS_PRESETS[2].settings })));
    let first = "", next = "";
    let stableBytes = 0;
    for (let frame = 0; frame < 60; frame++) {
      effect.inputBuffer(width, height).set(input);
      const result = effect.applyEffect(frame, width, height, ResizeFilter.Nearest, false, true, Rotation.None, 0, width, height, 0);
      if (frame === 10) first = new Bun.CryptoHasher("sha256").update(new Uint8Array(memory.buffer, result.ptr, result.len)).digest("hex");
      if (frame === 11) next = new Bun.CryptoHasher("sha256").update(new Uint8Array(memory.buffer, result.ptr, result.len)).digest("hex");
      result.free();
      if (frame === 15) stableBytes = memory.buffer.byteLength;
      if (frame > 15) expect(memory.buffer.byteLength).toBe(stableBytes);
    }
    expect(first).not.toBe(next);
  } finally { effect.free(); settings.free(); }
});
