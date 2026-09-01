import { expect, test } from "bun:test";
import { StepCadence } from "../src/footsteps";

function steps(speed: number, running: boolean, fps = 120) {
  const cadence = new StepCadence();
  let count = 0;
  for (let frame = 0; frame < fps * 10; frame++) {
    if (cadence.advance(speed / fps, 1 / fps, running)) count++;
  }
  return count;
}

test("walking and running cadence follow distance, independently of frame rate", () => {
  for (const fps of [30, 60, 120]) {
    expect(steps(2.15, false, fps)).toBe(21);
    expect(steps(3.3, true, fps)).toBe(28);
  }
  expect(steps(0.5, false)).toBeLessThan(steps(2.15, false));
});

test("no movement or pushing into a wall cannot produce footfalls", () => {
  const cadence = new StepCadence();
  for (let i = 0; i < 100; i++) cadence.advance(2.15 / 120, 1 / 120, false);
  for (let i = 0; i < 1000; i++) expect(cadence.advance(0, 1 / 120, true)).toBe(false);
  expect(cadence.phase).toBe(0);
});

test("reset drops pending progress instead of emitting a late step", () => {
  const cadence = new StepCadence();
  cadence.advance(0.1, 0.05, false);
  cadence.reset();
  expect(cadence.advance(0.01, 0.01, false)).toBe(false);
  expect(cadence.advance(NaN, 0.01, false)).toBe(false);
  expect(cadence.advance(0.1, 0, false)).toBe(false);
});

test("actual edited clips contain one short, unclipped impact with click-free endpoints", async () => {
  const folder = new URL("../public/audio/footsteps/", import.meta.url);
  const manifest = await Bun.file(new URL("manifest.json", folder)).json();
  expect(manifest.clips.length).toBe(11);
  let previousEnd = 0;
  const levels: number[] = [];
  for (const clip of manifest.clips) {
    expect(clip.sourcePeak).toBeGreaterThan(clip.sourceStart);
    expect(clip.sourcePeak).toBeLessThan(clip.sourceEnd);
    expect(clip.sourceStart).toBeGreaterThanOrEqual(previousEnd);
    previousEnd = clip.sourceEnd;
    const data = new DataView(await Bun.file(new URL(clip.file, folder)).arrayBuffer());
    let audioOffset = 0, audioBytes = 0, rate = 0;
    for (let offset = 12; offset + 8 < data.byteLength;) {
      const id = String.fromCharCode(...new Uint8Array(data.buffer, offset, 4));
      const size = data.getUint32(offset + 4, true);
      if (id === "fmt ") {
        expect(data.getUint16(offset + 8, true)).toBe(1);
        expect(data.getUint16(offset + 10, true)).toBe(1);
        expect(data.getUint16(offset + 22, true)).toBe(16);
        rate = data.getUint32(offset + 12, true);
      }
      if (id === "data") { audioOffset = offset + 8; audioBytes = size; }
      offset += 8 + size + (size % 2);
    }
    expect(rate).toBe(44100);
    const count = audioBytes / 2;
    expect(count / rate).toBeCloseTo(clip.duration, 4);
    expect(count / rate).toBeGreaterThan(0.2);
    expect(count / rate).toBeLessThan(0.35);
    expect(data.getInt16(audioOffset, true)).toBe(0);
    expect(data.getInt16(audioOffset + audioBytes - 2, true)).toBe(0);
    let peak = 0, energy = 0;
    for (let i = 0; i < count; i++) {
      const value = data.getInt16(audioOffset + i * 2, true) / 32768;
      peak = Math.max(peak, Math.abs(value));
      energy += value * value;
    }
    expect(peak).toBeLessThanOrEqual(0.251);
    expect(peak).toBeGreaterThan(0.1);
    levels.push(Math.sqrt(energy / count));
  }
  expect(Math.max(...levels) / Math.min(...levels)).toBeLessThan(1.3);
});
