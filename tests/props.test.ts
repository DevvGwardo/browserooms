import { expect, test } from "bun:test";
import { placementsForChunk, PROP_DEFS, MAX_PROPS_PER_CHUNK, isInnerRing } from "../src/props";
import type { Chunk } from "../src/world-layout";

function anchors(count: number, clearance: [number, number, number] = [3, 3, 3]): Chunk["anchors"] {
  return Array.from({ length: count }, (_, i) => ({
    id: `a${i}`,
    roomId: "r",
    kind: "floor" as const,
    position: [i * 2, 0, 0] as [number, number, number],
    yaw: 0,
    clearance,
  }));
}

test("placements are deterministic per chunk id", () => {
  const a = anchors(12);
  const first = placementsForChunk("world-v2:47:1,0", a);
  const second = placementsForChunk("world-v2:47:1,0", a);
  expect(first).toEqual(second);
  const other = placementsForChunk("world-v2:47:2,0", a);
  expect(JSON.stringify(other) === JSON.stringify(first)).toBe(false);
});

test("placements never exceed the per-chunk cap", () => {
  const out = placementsForChunk("cap-check", anchors(40));
  expect(out.length).toBeLessThanOrEqual(MAX_PROPS_PER_CHUNK);
});

test("every placement fits its anchor clearance", () => {
  for (const seed of ["fit-1", "fit-2", "fit-3", "fit-4", "fit-5"]) {
    const list = anchors(20);
    for (const p of placementsForChunk(seed, list)) {
      const clearance = list[p.anchorIndex].clearance;
      expect(p.def.footprint[0]).toBeLessThanOrEqual(clearance[0]);
      expect(p.def.footprint[1]).toBeLessThanOrEqual(clearance[2]);
      expect(p.def.height).toBeLessThanOrEqual(clearance[1]);
    }
  }
});

test("wall/ceiling anchors are never used; tiny clearances fit nothing", () => {
  const mixed: Chunk["anchors"] = [
    { id: "w", roomId: "r", kind: "wall", position: [0, 1, 0], yaw: 0, clearance: [5, 5, 5] },
    { id: "c", roomId: "r", kind: "ceiling", position: [0, 3, 0], yaw: 0, clearance: [5, 5, 5] },
    { id: "t", roomId: "r", kind: "floor", position: [0, 0, 0], yaw: 0, clearance: [0.1, 0.1, 0.1] },
  ];
  expect(placementsForChunk("mixed", mixed)).toEqual([]);
});

test("every prop def resolves to a sane footprint", () => {
  expect(PROP_DEFS.length).toBeGreaterThanOrEqual(8);
  for (const def of PROP_DEFS) {
    expect(def.footprint[0]).toBeGreaterThan(0);
    expect(def.footprint[1]).toBeGreaterThan(0);
    expect(def.height).toBeGreaterThan(0);
    expect(def.file).toMatch(/^[a-zA-Z0-9]+$/);
  }
});

test("only the fog-visible inner ring gets clutter", () => {
  expect(isInnerRing(0, 0)).toBe(true);
  expect(isInnerRing(1, -1)).toBe(true);
  expect(isInnerRing(2, 0)).toBe(false);
  expect(isInnerRing(0, 2)).toBe(false);
  expect(isInnerRing(-2, -2)).toBe(false);
});

test("per-chunk cap stays small for draw-call budget", () => {
  expect(MAX_PROPS_PER_CHUNK).toBeLessThanOrEqual(2);
});
