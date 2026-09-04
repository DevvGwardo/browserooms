import { expect, test } from "bun:test";
import {
  LEVELS,
  EXIT_CHUNK,
  levelSeed,
  exitChunkCenter,
  resolveExitSpot,
} from "../src/levels";

test("three named levels with distinct fog and speeds", () => {
  expect(LEVELS.length).toBe(3);
  expect(LEVELS[0].name).toMatch(/Level 0/);
  expect(LEVELS[2].name).toMatch(/Level 2/);
  const fogs = new Set(LEVELS.map((level) => level.fog));
  expect(fogs.size).toBe(3);
  expect(LEVELS[0].entitySpeed).toBeLessThan(LEVELS[2].entitySpeed);
  for (const level of LEVELS) {
    expect(level.hint.length).toBeGreaterThan(10);
    expect(level.seedPrefix).toMatch(/^L[0-2]$/);
  }
});

test("level seeds namespace the base seed", () => {
  expect(levelSeed("47", 0)).toBe("L0:47");
  expect(levelSeed("47", 2)).toBe("L2:47");
  expect(levelSeed("47", 3)).toBe("L0:47"); // wraps, never throws
});

test("exit chunk center tracks the floating origin", () => {
  const atHome = exitChunkCenter({ x: 0, z: 0 }, 36);
  expect(atHome).toEqual({ x: EXIT_CHUNK.x * 36, z: EXIT_CHUNK.z * 36 });
  const shifted = exitChunkCenter({ x: 2, z: 1 }, 36);
  expect(shifted).toEqual({ x: (EXIT_CHUNK.x - 2) * 36, z: (EXIT_CHUNK.z - 1) * 36 });
});

test("resolveExitSpot returns open ground near the chunk center", () => {
  const boxes = [{ min: [170, 0, -110], max: [190, 3, -90] }]; // wall over the center
  const center = { x: 180, z: -100 };
  const spot = resolveExitSpot(center, boxes);
  expect(Math.hypot(spot.x - center.x, spot.z - center.z)).toBeLessThan(20);
  // the spot itself must be standable with a 0.6 body radius
  const blocked = boxes.some((box) => {
    const cx = Math.max(box.min[0], Math.min(spot.x, box.max[0]));
    const cz = Math.max(box.min[2], Math.min(spot.z, box.max[2]));
    return Math.hypot(spot.x - cx, spot.z - cz) < 0.6;
  });
  expect(blocked).toBe(false);
});

test("resolveExitSpot keeps a free center as-is", () => {
  const center = { x: 10, z: 10 };
  expect(resolveExitSpot(center, [])).toEqual(center);
});
