import { expect, test } from "bun:test";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { movePlayer } from "../src/collision";
import { transformCollider, type Kit } from "../src/world-layout";

const root = new URL("../public/modules/", import.meta.url);
const kit = await Bun.file(new URL("modules.json", root)).json() as Kit;
const directions = [[0, -1], [1, 0], [0, 1], [-1, 0]];

test("actual room modules have open passages across every rotated neighbour pairing", () => {
  for (const a of kit.templates) for (const b of kit.templates) {
    for (let turnA = 0; turnA < 4; turnA++) for (let turnB = 0; turnB < 4; turnB++) {
      for (const [dx, dz] of directions) {
        const boxes = [
          ...a.colliders.map((box) => transformCollider(box, turnA)),
          ...b.colliders.map((box) => transformCollider(box, turnB, dx * kit.cellSize, dz * kit.cellSize)),
        ];
        const start = { x: dx * 15.6, z: dz * 15.6 };
        const end = movePlayer(start, dx * 0.8, dz * 0.8, boxes);
        expect(end.x).toBeCloseTo(dx * 16.4, 4);
        expect(end.z).toBeCloseTo(dz * 16.4, 4);
      }
    }
  }
});

test("actual exported floors cover both sides of every corridor seam", async () => {
  for (const template of kit.templates) {
    const data = await Bun.file(new URL(template.geometry, root)).arrayBuffer();
    const { scene } = await new GLTFLoader().parseAsync(data, "");
    scene.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    for (const [dx, dz] of directions) {
      for (const depth of [12.05, 14, 15.99]) {
        for (const side of [-0.85, 0, 0.85]) {
          ray.set(new THREE.Vector3(dx * depth + dz * side, 1, dz * depth + dx * side), new THREE.Vector3(0, -1, 0));
          const hits = ray.intersectObject(scene, true);
          expect(hits.length).toBeGreaterThan(0);
          expect(hits[0].point.y).toBeCloseTo(0, 3);
        }
      }
    }
  }
});

test("all four exits and floor placement anchors are reachable in the actual modules", () => {
  const step = 0.2;
  const size = Math.round(kit.cellSize / step);
  const half = kit.cellSize / 2;
  const cell = (x: number, z: number) => [Math.floor((x + half) / step), Math.floor((z + half) / step)];
  for (const template of kit.templates) {
    const free = new Uint8Array(size * size);
    for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
      const p = { x: (x + 0.5) * step - half, z: (z + 0.5) * step - half };
      const resolved = movePlayer(p, 0, 0, template.colliders);
      free[z * size + x] = Number(Math.hypot(p.x - resolved.x, p.z - resolved.z) < 1e-5);
    }
    const [sx, sz] = cell(template.spawn.position[0], template.spawn.position[2]);
    expect(free[sz * size + sx]).toBe(1);
    const queue = [[sx, sz]];
    const seen = new Set([sz * size + sx]);
    for (let i = 0; i < queue.length; i++) {
      const [x, z] = queue[i];
      for (const [dx, dz] of directions) {
        const a = x + dx, b = z + dz, key = b * size + a;
        if (a < 0 || b < 0 || a >= size || b >= size || !free[key] || seen.has(key)) continue;
        seen.add(key); queue.push([a, b]);
      }
    }
    for (const [dx, dz] of directions) {
      const [x, z] = cell(dx * 15.5, dz * 15.5);
      expect(seen.has(z * size + x)).toBe(true);
    }
    const rooms = new Set(template.rooms.map((room) => room.id));
    expect(new Set(template.anchors.map((anchor) => anchor.id)).size).toBe(template.anchors.length);
    for (const anchor of template.anchors) {
      expect(rooms.has(anchor.roomId)).toBe(true);
      if (anchor.kind !== "floor") continue;
      const [x, y, z] = anchor.position;
      const [cx, cz] = cell(x, z);
      expect(seen.has(cz * size + cx)).toBe(true);
      const [width, height, depth] = anchor.clearance;
      for (const box of template.colliders) {
        const overlaps = x + width / 2 > box.min[0] + 1e-5 && x - width / 2 < box.max[0] - 1e-5
          && z + depth / 2 > box.min[2] + 1e-5 && z - depth / 2 < box.max[2] - 1e-5
          && y + height > box.min[1] + 1e-5 && y < box.max[1] - 1e-5;
        expect(overlaps).toBe(false);
      }
    }
  }
});
