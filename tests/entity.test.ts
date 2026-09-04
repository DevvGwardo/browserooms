import { expect, test } from "bun:test";
import {
  EntityBrain,
  segmentBlocked,
  pointBlocked,
  sense,
  type Box,
} from "../src/entity-logic";

const wall: Box = { min: [4, 0, -1], max: [5, 3, 9] };
const lowBox: Box = { min: [4, 0, -1], max: [5, 0.05, 9] }; // curb — never blocks

test("open segment is not blocked; wall crossing is", () => {
  expect(segmentBlocked(0, 0, 3, 0, [wall])).toBe(false);
  expect(segmentBlocked(0, 4, 8, 4, [wall])).toBe(true);
  expect(segmentBlocked(0, 4, 8, 4, [lowBox])).toBe(false);
  expect(segmentBlocked(0, 4, 8, 4, [])).toBe(false);
});

test("point-blocked respects eye-height filter and radius", () => {
  expect(pointBlocked(4.5, 4, [wall], 0.4)).toBe(true);
  expect(pointBlocked(0, 0, [wall], 0.4)).toBe(false);
  expect(pointBlocked(4.5, 4, [lowBox], 0.4)).toBe(false);
});

test("sight: close range always seen with LOS; zoom extends range", () => {
  const boxes: Box[] = [];
  const close = sense({ entity: { x: 0, z: 0 }, player: { x: 3, z: 0 }, playerSpeed: 0, zoom: 1, gazeDot: 0, boxes });
  expect(close.seen).toBe(true);
  const mid = sense({ entity: { x: 0, z: 0 }, player: { x: 10, z: 0 }, playerSpeed: 0, zoom: 1, gazeDot: 0, boxes });
  expect(mid.seen).toBe(false);
  const zoomed = sense({ entity: { x: 0, z: 0 }, player: { x: 10, z: 0 }, playerSpeed: 0, zoom: 2, gazeDot: 0, boxes });
  expect(zoomed.seen).toBe(true);
  const behindWall = sense({ entity: { x: 0, z: 4 }, player: { x: 8, z: 4 }, playerSpeed: 0, zoom: 4, gazeDot: 1, boxes: [wall] });
  expect(behindWall.seen).toBe(false);
  expect(behindWall.blocked).toBe(true);
});

test("hearing: sprint is loud, walk is silent", () => {
  const boxes: Box[] = [];
  const loud = sense({ entity: { x: 0, z: 0 }, player: { x: 10, z: 0 }, playerSpeed: 3.3, zoom: 1, gazeDot: 0, boxes });
  expect(loud.heard).toBe(true);
  const quiet = sense({ entity: { x: 0, z: 0 }, player: { x: 10, z: 0 }, playerSpeed: 2.1, zoom: 1, gazeDot: 0, boxes });
  expect(quiet.heard).toBe(false);
});

test("stalk → chase on sight, chase → stalk after losing contact", () => {
  const brain = new EntityBrain({ x: 0, z: 0 });
  const player = { x: 3, z: 0 };
  const boxes: Box[] = [];
  const seen = sense({ entity: brain.pos, player, playerSpeed: 0, zoom: 1, gazeDot: 0, boxes });
  const r1 = brain.update(0.1, seen, false, player);
  expect(brain.mode).toBe("chase");
  expect(r1.events).toContain("spotted");
  // break contact for longer than LOSE_AFTER
  const far = { x: 60, z: 60 };
  for (let i = 0; i < 80; i++) {
    const s = sense({ entity: brain.pos, player: far, playerSpeed: 0, zoom: 1, gazeDot: 0, boxes });
    brain.update(0.1, s, false, far);
  }
  expect(brain.mode).toBe("stalk");
});

test("held gaze stuns a chasing entity, then it recovers", () => {
  const brain = new EntityBrain({ x: 0, z: 0 });
  const player = { x: 6, z: 0 };
  const boxes: Box[] = [];
  const seen = sense({ entity: brain.pos, player, playerSpeed: 0, zoom: 2, gazeDot: 1, boxes });
  brain.update(0.1, seen, false, player);
  expect(brain.mode).toBe("chase");
  let stunned = false;
  for (let i = 0; i < 40; i++) {
    const s = sense({ entity: brain.pos, player, playerSpeed: 0, zoom: 2, gazeDot: 1, boxes });
    const r = brain.update(0.1, s, true, player);
    if (r.events.includes("stunned")) stunned = true;
  }
  expect(stunned).toBe(true);
  expect(brain.mode).toBe("stunned");
  expect(brain.update(0.1, seen, false, player).steer).toBeNull();
  let recovered = false;
  for (let i = 0; i < 50; i++) {
    const rr = brain.update(0.1, seen, false, player);
    if (rr.events.includes("recovered")) recovered = true;
  }
  expect(recovered).toBe(true);
  // the player is still standing in the open at 6m — a correct brain re-spots them
  expect(brain.mode).toBe("chase");
});

test("catch range emits caught", () => {
  const brain = new EntityBrain({ x: 0, z: 0 });
  const player = { x: 0.8, z: 0 };
  const boxes: Box[] = [];
  brain.update(0.1, sense({ entity: brain.pos, player, playerSpeed: 0, zoom: 1, gazeDot: 0, boxes }), false, player);
  const r = brain.update(0.1, sense({ entity: brain.pos, player, playerSpeed: 0, zoom: 1, gazeDot: 0, boxes }), false, player);
  expect(r.events).toContain("caught");
});

test("gaze without chase does not stun; meter decays", () => {
  const brain = new EntityBrain({ x: 0, z: 0 });
  const player = { x: 30, z: 0 };
  const boxes: Box[] = [];
  const s = sense({ entity: brain.pos, player, playerSpeed: 0, zoom: 2, gazeDot: 1, boxes });
  brain.update(0.1, s, true, player);
  expect(brain.mode).toBe("stalk");
  expect(brain.stunMeter).toBe(0);
});
