import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import type { ReferenceKit } from "../src/reference-assets";

const folder = new URL("../public/reference/", import.meta.url);
const kit = await Bun.file(new URL("modules.json", folder)).json() as ReferenceKit;
const { scene } = await new GLTFLoader().parseAsync(await Bun.file(new URL(kit.templates[0].geometry, folder)).arrayBuffer(), "");
scene.updateMatrixWorld(true);
const maps = new Map<string, ReturnType<HDRLoader["parse"]>>();
for (const surface of Object.values(kit.materials)) {
  if (surface.kind === "pbr") maps.set(surface.family, new HDRLoader().parse(await Bun.file(new URL(surface.lightmap, folder)).arrayBuffer()));
}
const meshes = new Map<string, THREE.Mesh>();
scene.traverse((object) => { if (object instanceof THREE.Mesh) meshes.set(object.userData.surface, object); });
const ray = new THREE.Raycaster();
const sides = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const width = 64;
const data = new Uint16Array(width * 2 * 4);
const ranges: Record<string, { min: number; max: number }> = {};

for (const [row, family] of ["walls", "floor"].entries()) {
  const map = maps.get(family)!;
  const mesh = meshes.get(family)!;
  const samples: number[][] = [];
  for (let i = 0; i < width; i++) {
    const accumulated = [0, 0, 0];
    let count = 0;
    for (const [dx, dz] of sides) for (const sign of [-1, 1]) {
      const height = 0.12 + i / (width - 1) * 2.2;
      const lateral = family === "floor" ? sign * i / (width - 1) * 1.1 : 0;
      const origin = new THREE.Vector3(dx * 15.85 + dz * lateral, family === "floor" ? 1 : height, dz * 15.85 + dx * lateral);
      const direction = family === "floor" ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(dz * sign, 0, dx * sign);
      ray.set(origin, direction);
      const hit = ray.intersectObject(mesh)[0];
      if (!hit?.uv1) throw new Error(`No ${family} lighting UV at portal sample ${i}`);
      const x = Math.max(0, Math.min(map.width - 1, Math.floor(hit.uv1.x * map.width)));
      const y = Math.max(0, Math.min(map.height - 1, Math.floor(hit.uv1.y * map.height)));
      for (let channel = 0; channel < 3; channel++) {
        const value = map.data[(y * map.width + x) * 4 + channel];
        accumulated[channel] += map.data instanceof Uint16Array ? THREE.DataUtils.fromHalfFloat(value) : value;
      }
      count++;
    }
    samples.push(accumulated.map((value) => value / count));
  }
  for (let i = 0; i < width; i++) {
    for (let channel = 0; channel < 3; channel++) {
      const smoothed = [Math.max(0, i - 1), i, Math.min(width - 1, i + 1)]
        .reduce((sum, j) => sum + samples[j][channel], 0) / 3;
      data[(row * width + i) * 4 + channel] = THREE.DataUtils.toHalfFloat(smoothed);
    }
    data[(row * width + i) * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  ranges[family] = { min: Math.min(...samples.flat()), max: Math.max(...samples.flat()) };
}
await Bun.write(new URL("seam-lighting.bin", folder), data);
console.log(JSON.stringify({ width, rows: 2, format: "half-float RGBA, averaged portal diffuse E/pi", ranges }, null, 2));
