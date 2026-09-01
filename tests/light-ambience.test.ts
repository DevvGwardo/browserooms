import { expect, test } from "bun:test";
import { BASE_GAIN, NEAR_GAIN, lightAudioLevel } from "../src/light-ambience";
import { describeChunk, type Kit, type LightEmitter } from "../src/world-layout";

const light: LightEmitter = { id: "panel", position: [0, 3, 0] };

test("baseline stays at 20% away from fixtures or when no powered lights are present", () => {
  expect(lightAudioLevel({ x: 0, y: 1.65, z: 0 }, [], []).gain).toBe(BASE_GAIN);
  expect(lightAudioLevel({ x: 8, y: 1.65, z: 0 }, [light], []).gain).toBe(BASE_GAIN);
});

test("volume rises smoothly toward the light and reaches the capped near level underneath", () => {
  const gains = [7, 5, 3, 2, 1, 0].map((x) => lightAudioLevel({ x, y: 1.65, z: 0 }, [light], []).gain);
  expect(gains.at(-1)).toBe(NEAR_GAIN);
  expect(gains.every((gain, i) => gain >= BASE_GAIN && gain <= NEAR_GAIN && (!i || gain >= gains[i - 1]))).toBe(true);
});

test("overlapping light sources do not multiply soundtrack volume", () => {
  const position = { x: 1, y: 1.65, z: 1 };
  expect(lightAudioLevel(position, Array(100).fill(light), []).gain).toBe(lightAudioLevel(position, [light], []).gain);
});

test("a wall blocks the proximity boost but does not remove the ambient baseline", () => {
  const walls = [{ min: [-0.6, 0, -2], max: [-0.4, 3.1, 2] }];
  const result = lightAudioLevel({ x: -1, y: 1.65, z: 0 }, [light], walls);
  expect(result.gain).toBe(BASE_GAIN);
  expect(result.lightId).toBe(null);
});

test("floating-origin translation leaves gain unchanged", () => {
  const before = lightAudioLevel({ x: 0.5, y: 1.65, z: 0.5 }, [light], []);
  const after = lightAudioLevel({ x: -31.5, y: 1.65, z: 32.5 }, [{ ...light, position: [-32, 3, 32] }], []);
  expect(after.gain).toBe(before.gain);
});

test("real powered fixtures retain stable IDs and rotate with their room module", async () => {
  const kit = await Bun.file(new URL("../public/modules/modules.json", import.meta.url)).json() as Kit;
  for (const template of kit.templates) {
    expect(template.lights.length).toBeGreaterThan(0);
    expect(new Set(template.lights.map((panel) => panel.id)).size).toBe(template.lights.length);
    expect(template.lights.every((panel) => Math.abs(panel.position[0]) <= 16 && Math.abs(panel.position[2]) <= 16 && panel.position[1] > 2.4)).toBe(true);
  }
  const chunk = describeChunk("47", 0, -1, kit);
  const template = kit.templates.find((candidate) => candidate.id === chunk.templateId)!;
  expect(chunk.lights.length).toBe(template.lights.length);
  expect(chunk.lights.every((panel) => panel.id.startsWith(chunk.id + "/light/"))).toBe(true);
  const angle = chunk.quarterTurns * Math.PI / 2;
  expect(chunk.lights[0].position[0]).toBeCloseTo(template.lights[0].position[0] * Math.cos(angle) + template.lights[0].position[2] * Math.sin(angle));
});
