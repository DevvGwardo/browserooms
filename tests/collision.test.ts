import { describe, expect, test } from "bun:test";
import { movePlayer, type Collider } from "../src/collision";

describe("walkable architecture", () => {
  const wall: Collider = { min: [0, 0, -10], max: [0.2, 3, 10] };
  test("large movement cannot tunnel through a thin wall", () => {
    const end = movePlayer({ x: -2, z: 0 }, 5, 0, [wall]);
    expect(end.x).toBeCloseTo(-0.24);
  });
  test("diagonal input slides along the wall", () => {
    const end = movePlayer({ x: -1, z: 0 }, 2, 2, [wall]);
    expect(end.x).toBeCloseTo(-0.24);
    expect(end.z).toBeCloseTo(2);
  });
  test("a person fits beneath the doorway lintel", () => {
    const doorway = [
      { min: [-2, 0, 0], max: [-0.6, 3, 0.2] },
      { min: [0.6, 0, 0], max: [2, 3, 0.2] },
      { min: [-0.6, 2.2, 0], max: [0.6, 3, 0.2] },
    ];
    expect(movePlayer({ x: 0, z: -1 }, 0, 2, doorway).z).toBeCloseTo(1);
  });
  test("an inside corner contains the player during repeated input", () => {
    const walls = [wall, { min: [-10, 0, 0], max: [0, 3, 0.2] }];
    let p = { x: -1, z: -1 };
    for (let i = 0; i < 120; i++) p = movePlayer(p, 0.04, 0.04, walls);
    expect(p.x).toBeLessThanOrEqual(-0.239);
    expect(p.z).toBeLessThanOrEqual(-0.239);
  });
  test("door jamb grazing neither teleports nor penetrates", () => {
    const jamb = [{ min: [0, 0, 0], max: [0.3, 3, 2] }];
    const end = movePlayer({ x: -0.22, z: -1 }, 0, 3, jamb);
    expect(end.x).toBeLessThanOrEqual(-0.239);
    expect(end.z).toBeGreaterThan(1.5);
  });
});
