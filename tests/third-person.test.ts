import { expect, test } from "bun:test";
import { solveBoom, BOOM_MIN } from "../src/third-person";
import type { Collider } from "../src/collision";

const wall: Collider = { min: [-3, 0, -2.5], max: [3, 3, -1.5] };
const curb: Collider = { min: [-3, 0, -2.5], max: [3, 0.05, -1.5] };
const eye = { x: 0, y: 1.65, z: 0 };
const back = { x: 0, y: 0.42, z: -0.91 }; // boom direction, ~unit length

test("open space allows the full boom", () => {
  expect(solveBoom(eye, back, 4.6, [])).toBeCloseTo(4.6, 6);
  expect(solveBoom(eye, back, 4.6, [curb])).toBeCloseTo(4.6, 6);
});

test("a wall behind the player shortens the boom but never to zero", () => {
  const d = solveBoom(eye, back, 4.6, [wall]);
  expect(d).toBeLessThan(4.6);
  expect(d).toBeGreaterThanOrEqual(BOOM_MIN * 0.5);
});

test("floor slabs and off-path lintels are ignored", () => {
  const floorSlab: Collider = { min: [-5, -0.5, -5], max: [5, 0.0, 5] };
  const sideLintel: Collider = { min: [8, 2.6, -5], max: [14, 3.0, 5] };
  expect(solveBoom(eye, back, 4.6, [floorSlab, sideLintel])).toBeCloseTo(4.6, 6);
});

test("an overhead ceiling slab shortens the boom — the camera stays under it", () => {
  const ceiling: Collider = { min: [-8, 2.4, -8], max: [8, 2.7, 8] };
  const d = solveBoom(eye, back, 4.6, [ceiling]);
  // boom would pierce 2.4m at ~1.8m out; it must stop well before the full length
  expect(d).toBeLessThan(2.6);
  expect(d).toBeGreaterThanOrEqual(BOOM_MIN * 0.5);
  // and the resulting camera height stays below the slab
  const t = d / Math.hypot(back.x, back.y, back.z);
  expect(eye.y + back.y * t).toBeLessThan(2.4);
});

test("a typical 2.7m backrooms ceiling contains the default boom", () => {
  const ceiling: Collider = { min: [-20, 2.7, -20], max: [20, 3.0, 20] };
  // default boom: 3.6m out, 1.1m up → slope unit (0, 0.29, -0.96)-ish
  const dir = { x: 0, y: 0.29, z: -0.96 };
  const len = Math.hypot(dir.x, dir.y, dir.z);
  const unit = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
  const d = solveBoom(eye, unit, 3.75, [ceiling]);
  const camY = eye.y + unit.y * d;
  expect(camY).toBeLessThan(2.7);
});

test("a close wall still leaves a usable over-shoulder gap", () => {
  const near: Collider = { min: [-3, 0, -1.2], max: [3, 3, -0.8] };
  const d = solveBoom(eye, back, 4.6, [near]);
  expect(d).toBeGreaterThanOrEqual(BOOM_MIN * 0.5);
  expect(d).toBeLessThan(2);
});
