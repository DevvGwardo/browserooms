import { expect, test } from "bun:test";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { ReferenceKit } from "../src/reference-assets";

const root = new URL("../public/reference/", import.meta.url);
const kit = await Bun.file(new URL("modules.json", root)).json() as ReferenceKit;
const loader = new GLTFLoader();

test("ceiling panels are flat and powered lights use crisp geometry rather than atlas masks", async () => {
  expect(kit.materials.ceiling.kind).toBe("pbr");
  expect(kit.materials["ceiling-lights"].kind).toBe("emission");
  const { scene } = await loader.parseAsync(await Bun.file(new URL(kit.templates[0].geometry, root)).arrayBuffer(), "");
  scene.updateMatrixWorld(true);
  let mainMin = Infinity, mainMax = -Infinity, emitterTriangles = 0;
  const point = new THREE.Vector3();
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.userData.surface === "ceiling-lights") {
      emitterTriangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
    }
    if (object.userData.surface !== "ceiling") return;
    const positions = object.geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
      if (point.y < 2.8) continue;
      mainMin = Math.min(mainMin, point.y);
      mainMax = Math.max(mainMax, point.y);
    }
  });
  expect(mainMin).toBeGreaterThanOrEqual(2.997);
  expect(mainMax - mainMin).toBeLessThan(0.006);
  expect(emitterTriangles).toBeGreaterThanOrEqual(kit.templates[0].lights.length * 2);
});

test("approved wall and floor geometry and texture placement are unchanged", async () => {
  const original = await loader.parseAsync(await Bun.file(new URL("reference.glb", root)).arrayBuffer(), "");
  const refined = await loader.parseAsync(await Bun.file(new URL(kit.templates[0].geometry, root)).arrayBuffer(), "");
  const describe = (scene: THREE.Object3D, family: string) => {
    scene.updateMatrixWorld(true);
    const rows: string[] = [];
    const p = new THREE.Vector3();
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || object.userData.surface !== family) return;
      const position = object.geometry.getAttribute("position");
      const uv = object.geometry.getAttribute("uv");
      const light = object.geometry.getAttribute("uv1");
      for (let i = 0; i < position.count; i++) {
        p.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
        rows.push([p.x, p.y, p.z, uv.getX(i), uv.getY(i), light.getX(i), light.getY(i)].map((v) => v.toFixed(5)).join(","));
      }
    });
    return rows.sort();
  };
  for (const family of ["walls", "floor"]) {
    const before = describe(original.scene, family);
    expect(before.length).toBeGreaterThan(0);
    expect(describe(refined.scene, family)).toEqual(before);
  }
});
