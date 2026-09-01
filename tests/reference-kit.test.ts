import { expect, test } from "bun:test";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { movePlayer } from "../src/collision";
import { transformCollider } from "../src/world-layout";
import type { ReferenceKit } from "../src/reference-assets";

const folder = new URL("../public/reference/", import.meta.url);
const kit = await Bun.file(new URL("modules.json", folder)).json() as ReferenceKit;
const template = kit.templates[0];

test("reference PBR surfaces have distinct tiled and nonoverlapping lighting UV channels", async () => {
  const gltf = await new GLTFLoader().parseAsync(await Bun.file(new URL(template.geometry, folder)).arrayBuffer(), "");
  const physicalSurfaces = new Set<string>();
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const surface = kit.materials[object.userData.surface];
    expect(surface).toBeDefined();
    if (surface.kind !== "pbr") return;
    physicalSurfaces.add(object.userData.surface);
    const uv = object.geometry.getAttribute("uv");
    const lighting = object.geometry.getAttribute("uv1");
    expect(uv.count).toBe(lighting.count);
    let tiledCoordinates = false;
    for (let i = 0; i < uv.count; i++) {
      if (Math.abs(uv.getX(i)) > 1 || Math.abs(uv.getY(i)) > 1) tiledCoordinates = true;
      expect(lighting.getX(i)).toBeGreaterThanOrEqual(-0.0001);
      expect(lighting.getX(i)).toBeLessThanOrEqual(1.0001);
      expect(lighting.getY(i)).toBeGreaterThanOrEqual(-0.0001);
      expect(lighting.getY(i)).toBeLessThanOrEqual(1.0001);
    }
    expect(tiledCoordinates).toBe(true);
  });
  expect(physicalSurfaces).toEqual(new Set(Object.entries(kit.materials).filter(([, surface]) => surface.kind === "pbr").map(([name]) => name)));
});

test("reference room floors and rotated corridor connections remain navigable", async () => {
  const gltf = await new GLTFLoader().parseAsync(await Bun.file(new URL(template.geometry, folder)).arrayBuffer(), "");
  gltf.scene.updateMatrixWorld(true);
  const directions = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const ray = new THREE.Raycaster();
  for (const [dx, dz] of directions) {
    ray.set(new THREE.Vector3(dx * 15.95, 1, dz * 15.95), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(gltf.scene, true)[0];
    expect(hit).toBeDefined();
    expect(hit.point.y).toBeCloseTo(0, 3);
    for (let turn = 0; turn < 4; turn++) {
      const boxes = [...template.colliders, ...template.colliders.map((box) => transformCollider(box, turn, dx * 32, dz * 32))];
      const moved = movePlayer({ x: dx * 15.6, z: dz * 15.6 }, dx * 0.8, dz * 0.8, boxes);
      expect(moved.x).toBeCloseTo(dx * 16.4, 4);
      expect(moved.z).toBeCloseTo(dz * 16.4, 4);
    }
  }
  const [x, , z] = template.spawn.position;
  expect(movePlayer({ x, z }, 0, 0, template.colliders)).toEqual({ x, z });
});
