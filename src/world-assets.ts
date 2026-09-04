import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { applySurfaceDetail } from "./surface-detail";
import type { Kit } from "./world-layout";

/** Load the finite asset kit once. Streamed chunks only borrow these GPU resources. */
export async function loadWorldAssets(kit: Kit, manager: THREE.LoadingManager, renderer: THREE.WebGLRenderer,
  wallpaper: THREE.Texture, carpet: THREE.Texture) {
  const atlases = new Map<string, Kit["templates"][number]["radiance"][number]>();
  for (const template of kit.templates) for (const atlas of template.radiance) {
    const existing = atlases.get(atlas.file);
    if (existing && (existing.family !== atlas.family || existing.flipY !== atlas.flipY)) {
      throw new Error(`Conflicting lighting atlas declaration: ${atlas.file}`);
    }
    atlases.set(atlas.file, atlas);
  }
  const textures = new Map<string, THREE.DataTexture>();
  const [models] = await Promise.all([
    Promise.all(kit.templates.map(async (template) => ({
      template, gltf: await new GLTFLoader(manager).loadAsync(`/modules/${template.geometry}`),
    }))),
    ...[...atlases.values()].map(async (atlas) => {
      const texture = await new HDRLoader(manager).loadAsync(`/modules/${atlas.file}`);
      texture.flipY = atlas.flipY;
      texture.colorSpace = THREE.LinearSRGBColorSpace;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      texture.needsUpdate = true;
      textures.set(atlas.file, texture);
    }),
  ]);
  const materials = new Map<string, THREE.MeshBasicMaterial>();
  const prototypes = new Map<string, THREE.Object3D>();
  let meshCount = 0;
  for (const { template, gltf } of models) {
    const previousCount = meshCount;
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      let node: THREE.Object3D | null = object;
      let file: string | undefined;
      while (node && !file) { file = node.userData.radiance as string | undefined; node = node.parent; }
      if (!file || !textures.has(file) || !object.geometry.attributes.uv) {
        throw new Error(`Invalid baked mesh in ${template.id}: ${object.name}`);
      }
      const detailPosition = object.geometry.attributes.position.clone();
      detailPosition.applyMatrix4(object.matrixWorld);
      object.geometry.setAttribute("detailPosition", detailPosition);
      let material = materials.get(file);
      if (!material) {
        material = new THREE.MeshBasicMaterial({ map: textures.get(file), color: 0xffffff });
        const family = atlases.get(file)!.family;
        material.name = `Baked module radiance: ${file}`;
        if (family !== "details") applySurfaceDetail(material, family, family === "walls" ? wallpaper : carpet);
        else material.color.setRGB(1.05, 1.05, 0.9);
        materials.set(file, material);
      }
      for (const previous of Array.isArray(object.material) ? object.material : [object.material]) previous.dispose();
      object.material = material;
      object.geometry.computeBoundingSphere();
      meshCount++;
    });
    if (meshCount === previousCount) throw new Error(`Room module ${template.id} contains no geometry.`);
    prototypes.set(template.id, gltf.scene);
  }
  return { prototypes, meshCount, atlasCount: atlases.size };
}
