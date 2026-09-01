import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import type { ReferenceKit } from "../src/reference-assets";

const root = new URL("../public/continuous/", import.meta.url);
const kit = await Bun.file(new URL("modules.json", root)).json() as ReferenceKit;
if (kit.version !== 2) throw new Error("Continuous edge profiles require a version-2 kit.");
const sources = await Promise.all(kit.templates.map(async (template) => {
  const { scene } = await new GLTFLoader().parseAsync(await Bun.file(new URL(template.geometry, root)).arrayBuffer(), "");
  scene.updateMatrixWorld(true);
  const meshes: { mesh: THREE.Mesh; surfaceKey: string }[] = [];
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    let parent: THREE.Object3D | null = object;
    let surfaceKey: string | undefined;
    while (parent && !surfaceKey) { surfaceKey = parent.userData.surface; parent = parent.parent; }
    if (surfaceKey && kit.materials[surfaceKey]?.kind === "pbr") meshes.push({ mesh: object, surfaceKey });
  });
  return meshes;
}));
const half = kit.cellSize / 2;
const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const profiles: Record<string, { file: string; width: number; height: number }> = {};
const summary: Record<string, unknown> = {};
const ray = new THREE.Raycaster();

for (const family of ["walls", "floor", "ceiling"]) {
  const variants = await Promise.all(sources.map(async (meshes) => {
    const selected = meshes.filter(({ surfaceKey }) => kit.materials[surfaceKey].family === family);
    if (!selected.length) throw new Error(`Floor patch has no ${family} mesh.`);
    const atlases = new Map<THREE.Object3D, ReturnType<HDRLoader["parse"]>>();
    for (const { mesh, surfaceKey } of selected) {
      const material = kit.materials[surfaceKey];
      if (material.kind !== "pbr") throw new Error("Expected PBR surface.");
      atlases.set(mesh, new HDRLoader().parse(await Bun.file(new URL(material.lightmap, root)).arrayBuffer()));
    }
    return { meshes: selected.map(({ mesh }) => mesh), atlases };
  }));
  const width = family === "walls" ? 64 : 256;
  const rows: (number[] | null)[][] = [[], []];
  const sample = (origin: THREE.Vector3, direction: THREE.Vector3) => {
    ray.set(origin, direction);
    const values: number[][] = [];
    for (const variant of variants) {
      const hit = ray.intersectObjects(variant.meshes)[0];
      if (!hit?.uv1) continue;
      const atlas = variant.atlases.get(hit.object)!;
      const x = Math.max(0, Math.min(atlas.width - 1, Math.floor(hit.uv1.x * atlas.width)));
      const y = Math.max(0, Math.min(atlas.height - 1, Math.floor(hit.uv1.y * atlas.height)));
      values.push([0, 1, 2].map((channel) => {
        const value = atlas.data[(y * atlas.width + x) * 4 + channel];
        return atlas.data instanceof Uint16Array ? THREE.DataUtils.fromHalfFloat(value) : value;
      }));
    }
    return values.length ? [0, 1, 2].map((c) => values.reduce((sum, value) => sum + value[c], 0) / values.length) : null;
  };
  for (let row = 0; row < 2; row++) for (let i = 0; i < width; i++) {
    const values: number[][] = [];
    if (family === "walls") {
      const y = 0.12 + i / (width - 1) * 2.76;
      for (const [dx, dz] of directions) for (const offset of [-9, 9]) for (const side of [-1, 1]) {
        const origin = new THREE.Vector3(dx * (half - 0.16) + dz * (offset + side * 0.65), y,
          dz * (half - 0.16) + dx * (offset + side * 0.65));
        const value = sample(origin, new THREE.Vector3(-dz * side, 0, -dx * side));
        if (value) values.push(value);
      }
    } else {
      const along = -half + 0.05 + i / (width - 1) * (kit.cellSize - 0.1);
      for (const sign of [-1, 1]) {
        const origin = row === 0
          ? new THREE.Vector3(sign * (half - 0.12), family === "floor" ? 1 : 2.5, along)
          : new THREE.Vector3(along, family === "floor" ? 1 : 2.5, sign * (half - 0.12));
        const value = sample(origin, new THREE.Vector3(0, family === "floor" ? -1 : 1, 0));
        if (value) values.push(value);
      }
    }
    rows[row].push(values.length ? [0, 1, 2].map((c) => values.reduce((sum, v) => sum + v[c], 0) / values.length) : null);
  }
  // Lamp apertures have no diffuse ceiling surface; fill their unused profile samples.
  for (const row of rows) {
    if (!row.some(Boolean)) throw new Error(`No valid ${family} edge samples.`);
    for (let i = 0; i < width; i++) {
      if (row[i]) continue;
      for (let distance = 1; distance < width; distance++) {
        const found = row[Math.max(0, i - distance)] ?? row[Math.min(width - 1, i + distance)];
        if (found) { row[i] = [...found]; break; }
      }
    }
  }
  if (family !== "walls") {
    const corner = [0, 1, 2].map((c) => (rows[0][0]![c] + rows[0][width - 1]![c] + rows[1][0]![c] + rows[1][width - 1]![c]) / 4);
    for (const row of rows) for (let i = 0; i < width; i++) {
      const distance = Math.min(i, width - 1 - i) / (width - 1) * kit.cellSize;
      const t = Math.min(1, distance / 2.4);
      const blend = t * t * (3 - 2 * t);
      row[i] = row[i]!.map((v, c) => corner[c] * (1 - blend) + v * blend);
    }
  }
  const data = new Uint16Array(width * 2 * 4);
  const all: number[] = [];
  for (let row = 0; row < 2; row++) for (let i = 0; i < width; i++) {
    for (let c = 0; c < 3; c++) {
      const value = rows[row][i]![c];
      if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${family} illumination.`);
      data[(row * width + i) * 4 + c] = THREE.DataUtils.toHalfFloat(value);
      all.push(value);
    }
    data[(row * width + i) * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const file = `edge-${family}.bin`;
  await Bun.write(new URL(file, root), data);
  profiles[family] = { file, width, height: 2 };
  summary[family] = { width, min: Math.min(...all), max: Math.max(...all) };
}
kit.edgeProfiles = profiles;
await Bun.write(new URL("modules.json", root), JSON.stringify(kit, null, 2) + "\n");
await Bun.write(new URL("../assets/continuous/edge-profiles.json", import.meta.url), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
