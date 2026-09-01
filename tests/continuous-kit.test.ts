import { expect, test } from "bun:test";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { movePlayer } from "../src/collision";
import { transformCollider } from "../src/world-layout";
import type { ReferenceKit } from "../src/reference-assets";

const root = new URL("../public/continuous/", import.meta.url);
const kit = await Bun.file(new URL("modules.json", root)).json() as ReferenceKit;
const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const loader = new GLTFLoader();

test("continuous patches have floor and full-height ceiling across their entire footprint", async () => {
  expect(kit.version).toBe(2);
  expect(kit.cellSize).toBe(36);
  for (const template of kit.templates) {
    const { scene } = await loader.parseAsync(await Bun.file(new URL(template.geometry, root)).arrayBuffer(), "");
    scene.updateMatrixWorld(true);
    const floors: THREE.Object3D[] = [], ceilings: THREE.Object3D[] = [];
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const family = kit.materials[object.userData.surface]?.family;
      if (family === "floor") floors.push(object);
      if (family === "ceiling") ceilings.push(object);
    });
    const ray = new THREE.Raycaster();
    for (const x of [-17.98, -14, -6, 0, 6, 14, 17.98]) for (const z of [-17.98, -14, -6, 0, 6, 14, 17.98]) {
      ray.set(new THREE.Vector3(x, 1, z), new THREE.Vector3(0, -1, 0));
      const floor = ray.intersectObjects(floors)[0];
      expect(floor).toBeDefined();
      expect(floor.point.y).toBeCloseTo(0, 3);
      ray.set(new THREE.Vector3(x, 2.1, z), new THREE.Vector3(0, 1, 0));
      const ceiling = ray.intersectObjects(ceilings)[0];
      expect(ceiling).toBeDefined();
      expect(ceiling.point.y).toBeGreaterThanOrEqual(2.995);
      expect(ceiling.point.y).toBeLessThanOrEqual(3.005);
    }
  }
});

test("crossing is possible throughout broad boundaries, not only a central connector", () => {
  for (const a of kit.templates) for (const b of kit.templates) {
    for (const [dx, dz] of directions) for (const along of [-16.5, -13, -6, 0, 6, 13, 16.5]) {
      const boxes = [...a.colliders, ...b.colliders.map((box) => transformCollider(box, 0, dx * 36, dz * 36))];
      const start = { x: dx * 17.5 + dz * along, z: dz * 17.5 + dx * along };
      const end = movePlayer(start, dx, dz, boxes);
      expect(end.x).toBeCloseTo(start.x + dx, 4);
      expect(end.z).toBeCloseTo(start.z + dz, 4);
    }
  }
});

test("shared partitions continue across the invisible cell edge", () => {
  for (const a of kit.templates) for (const b of kit.templates) {
    for (const [dx, dz] of directions) for (const along of [-9, 9]) {
      const boxes = [...a.colliders, ...b.colliders.map((box) => transformCollider(box, 0, dx * 36, dz * 36))];
      for (const depth of [17.99, 18.01]) {
        const p = { x: dx * depth + dz * along, z: dz * depth + dx * along };
        const corrected = movePlayer(p, 0, 0, boxes);
        expect(Math.hypot(corrected.x - p.x, corrected.z - p.z)).toBeGreaterThan(0.2);
      }
    }
  }
});

test("interior collision faces coincide with the actual exported walls", async () => {
  for (const template of kit.templates) {
    const { scene } = await loader.parseAsync(await Bun.file(new URL(template.geometry, root)).arrayBuffer(), "");
    scene.updateMatrixWorld(true);
    const walls: THREE.Object3D[] = [];
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh && kit.materials[object.userData.surface]?.family === "walls") walls.push(object);
    });
    const ray = new THREE.Raycaster();
    for (const box of template.colliders) {
      expect(box.min[1]).toBeGreaterThanOrEqual(-0.02);
      expect(box.max[1]).toBeLessThanOrEqual(3.02);
      const axis = box.max[0] - box.min[0] < box.max[2] - box.min[2] ? 0 : 2;
      const tangent = axis === 0 ? 2 : 0;
      for (const side of [-1, 1]) {
        let matches = 0;
        for (const fraction of [0.25, 0.5, 0.75]) {
          const origin = new THREE.Vector3();
          origin.setComponent(axis, (side < 0 ? box.min[axis] : box.max[axis]) + side * 0.3);
          origin.setComponent(tangent, box.min[tangent] + (box.max[tangent] - box.min[tangent]) * fraction);
          origin.y = (box.min[1] + box.max[1]) / 2;
          const direction = new THREE.Vector3().setComponent(axis, -side);
          ray.set(origin, direction);
          if (ray.intersectObjects(walls).some((hit) => hit.distance >= 0.26 && hit.distance <= 0.36)) matches++;
        }
        expect(matches).toBeGreaterThan(0);
      }
    }
  }
});

test("shared floor and ceiling edge profiles meet at identical corner values", async () => {
  for (const family of ["floor", "ceiling"]) {
    const profile = kit.edgeProfiles![family];
    const data = new Uint16Array(await Bun.file(new URL(profile.file, root)).arrayBuffer());
    expect(data.length).toBe(profile.width * profile.height * 4);
    for (let channel = 0; channel < 3; channel++) {
      const first = data[channel];
      expect(data[(profile.width - 1) * 4 + channel]).toBe(first);
      expect(data[profile.width * 4 + channel]).toBe(first);
      expect(data[(profile.width * 2 - 1) * 4 + channel]).toBe(first);
      expect(Number.isFinite(THREE.DataUtils.fromHalfFloat(first))).toBe(true);
    }
  }
});

test("floor and ceiling texture phases continue across adjacent patches", async () => {
  const scenes = await Promise.all(kit.templates.map(async (template) =>
    (await loader.parseAsync(await Bun.file(new URL(template.geometry, root)).arrayBuffer(), "")).scene));
  const ray = new THREE.Raycaster();
  const hits = (scene: THREE.Object3D, family: string, x: number, z: number) => {
    const meshes: THREE.Object3D[] = [];
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh && kit.materials[object.userData.surface]?.kind === "pbr"
        && kit.materials[object.userData.surface].family === family) meshes.push(object);
    });
    ray.set(new THREE.Vector3(x, family === "floor" ? 1 : 2.5, z), new THREE.Vector3(0, family === "floor" ? -1 : 1, 0));
    return ray.intersectObjects(meshes)[0]?.uv;
  };
  for (const a of scenes) for (const b of scenes) {
    for (const [dx, dz] of directions) {
      const left = a.clone(true), right = b.clone(true);
      right.position.set(dx * 36, 0, dz * 36);
      left.updateMatrixWorld(true); right.updateMatrixWorld(true);
      for (const family of ["floor", "ceiling"]) {
        const material = Object.values(kit.materials).find((surface) => surface.family === family && surface.kind === "pbr");
        const scale = material?.kind === "pbr" ? material.uvScale ?? [1, 1] : [1, 1];
        const first = hits(left, family, dx * 17.9999, dz * 17.9999);
        const second = hits(right, family, dx * 18.0001, dz * 18.0001);
        expect(first).toBeDefined(); expect(second).toBeDefined();
        for (const axis of ["x", "y"] as const) {
          const difference = (second![axis] - first![axis]) * scale[axis === "x" ? 0 : 1];
          expect(Math.abs(difference - Math.round(difference))).toBeLessThan(0.001);
        }
      }
    }
  }
});
