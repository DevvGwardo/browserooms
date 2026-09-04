import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import type { Kit } from "./world-layout";

type Surface = {
  kind: "pbr";
  family: string;
  albedo: string;
  normal: string;
  roughness: string;
  lightmap: string;
  normalScale?: number;
  roughnessFactor?: number;
  vertexColors?: boolean;
  uvScale?: [number, number];
} | {
  kind: "radiance";
  family: string;
  radiance: string;
} | {
  kind: "emission";
  family: string;
  color: [number, number, number];
  vertexColors?: boolean;
};

type EdgeProfile = { file: string; width: number; height: number };
export type ReferenceKit = Kit & {
  materials: Record<string, Surface>;
  environment?: string;
  edgeProfiles?: Record<string, EdgeProfile>;
  palette?: Record<string, [number, number, number]>;
};

/** Keep baked diffuse illumination separate from crisp material maps and view-dependent specular. */
export async function loadReferenceAssets(kit: ReferenceKit, manager: THREE.LoadingManager, renderer: THREE.WebGLRenderer, basePath = "/reference/") {
  if (!kit.materials || !Object.keys(kit.materials).length) throw new Error("Reference material definitions are missing.");
  const images = new Map<string, Promise<THREE.Texture>>();
  const hdrs = new Map<string, Promise<THREE.DataTexture>>();
  const image = (file: string, color = false, scale: [number, number] = [1, 1]) => {
    const key = `${file}:${color}:${scale.join(",")}`;
    if (!images.has(key)) images.set(key, new THREE.TextureLoader(manager).loadAsync(`${basePath}${file}`).then((texture) => {
      texture.flipY = false;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(...scale);
      texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      // 4x is visually lossless under VHS grain; max (up to 16x) burns bandwidth.
      texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      texture.needsUpdate = true;
      return texture;
    }));
    return images.get(key)!;
  };
  const hdr = (file: string) => {
    if (!hdrs.has(file)) hdrs.set(file, new HDRLoader(manager).loadAsync(`${basePath}${file}`).then((texture) => {
      texture.flipY = false;
      texture.colorSpace = THREE.LinearSRGBColorSpace;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      texture.needsUpdate = true;
      return texture;
    }));
    return hdrs.get(file)!;
  };
  const modelsPromise = Promise.all(kit.templates.map(async (template) => ({
    id: template.id, gltf: await new GLTFLoader(manager).loadAsync(`${basePath}${template.geometry}`),
  })));
  const edgeTextures = new Map<string, Promise<THREE.DataTexture>>();
  const profileFor = (family: string): EdgeProfile => {
    if (kit.version === 1) return { file: "seam-lighting.bin", width: 64, height: 2 };
    const profile = kit.edgeProfiles?.[family];
    if (!profile || !Number.isInteger(profile.width) || profile.width < 2 || profile.width > 1024 || profile.height !== 2) {
      throw new Error(`Invalid continuous lighting profile: ${family}`);
    }
    return profile;
  };
  const edgeTexture = (profile: EdgeProfile) => {
    if (!edgeTextures.has(profile.file)) edgeTextures.set(profile.file, fetch(`${basePath}${profile.file}`).then(async (response) => {
      if (!response.ok) throw new Error("Boundary lighting profile could not be loaded.");
      const data = await response.arrayBuffer();
      if (data.byteLength !== profile.width * profile.height * 8) throw new Error("Invalid boundary lighting profile.");
      const texture = new THREE.DataTexture(new Uint16Array(data), profile.width, profile.height, THREE.RGBAFormat, THREE.HalfFloatType);
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      return texture;
    }));
    return edgeTextures.get(profile.file)!;
  };
  const environmentPromise = kit.environment ? hdr(kit.environment).then((texture) => {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.flipY = true;
    const generator = new THREE.PMREMGenerator(renderer);
    const filtered = generator.fromEquirectangular(texture);
    generator.dispose();
    texture.dispose();
    return filtered.texture;
  }) : Promise.resolve(null);
  const materials = new Map<string, THREE.Material>();
  const materialsPromise = Promise.all(Object.entries(kit.materials).map(async ([key, surface]) => {
    if (surface.kind === "emission") {
      materials.set(key, new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(...surface.color), vertexColors: surface.vertexColors ?? false }));
      return;
    }
    if (surface.kind === "radiance") {
      materials.set(key, new THREE.MeshBasicMaterial({ map: await hdr(surface.radiance), color: 0xffffff }));
      return;
    }
    const profile = profileFor(surface.family);
    const uvScale: [number, number] = surface.uvScale ?? [1, 1];
    const [albedo, normal, roughness, lightmap, environment, seam] = await Promise.all([
      image(surface.albedo, true, uvScale), image(surface.normal, false, uvScale), image(surface.roughness, false, uvScale), hdr(surface.lightmap), environmentPromise, edgeTexture(profile),
    ]);
    lightmap.channel = 1;
    const material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color().setRGB(...(kit.palette?.[surface.family] ?? [1, 1, 1])),
      map: albedo, normalMap: normal, roughnessMap: roughness, lightMap: lightmap,
      normalScale: new THREE.Vector2(surface.normalScale ?? 1, surface.normalScale ?? 1),
      lightMapIntensity: Math.PI,
      roughness: surface.roughnessFactor ?? 1,
      vertexColors: surface.vertexColors ?? false,
      metalness: 0, ior: 1.45, specularIntensity: surface.family === "floor" ? 0.36 : 0.5,
      envMap: environment, envMapIntensity: 1,
    });
    material.name = `Reference PBR: ${surface.family}`;
    material.customProgramCacheKey = () => `pbr-edge-v3-${kit.version}-${surface.family}`;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.corridorLighting = { value: seam };
      // The lightmap already contains all diffuse bounce. The probe supplies specular only.
      let lighting = THREE.ShaderChunk.lights_fragment_maps.replace("iblIrradiance += getIBLIrradiance( geometryNormal );", "");
      if (kit.version === 2) {
        const half = kit.cellSize / 2;
        const coordinate = (value: string) => `(clamp(${value}, 0.0, 1.0) * ${profile.width - 1}.0 + 0.5) / ${profile.width}.0`;
        const blend = surface.family === "walls" ? `
          float heightCoordinate = ${coordinate("(vTilePosition.y - 0.12) / 2.76")};
          vec3 edge = texture2D(corridorLighting, vec2(heightCoordinate, 0.5)).rgb * lightMapIntensity;
          irradiance += mix(lightMapIrradiance, edge, max(axisBlend.x, axisBlend.y));` : `
          float alongX = ${coordinate(`vTilePosition.x / ${kit.cellSize}.0 + 0.5`)};
          float alongZ = ${coordinate(`vTilePosition.z / ${kit.cellSize}.0 + 0.5`)};
          vec3 edgeX = texture2D(corridorLighting, vec2(alongZ, 0.25)).rgb * lightMapIntensity;
          vec3 edgeZ = texture2D(corridorLighting, vec2(alongX, 0.75)).rgb * lightMapIntensity;
          irradiance += mix(mix(lightMapIrradiance, edgeX, axisBlend.x), edgeZ, axisBlend.y);`;
        lighting = lighting.replace("irradiance += lightMapIrradiance;", `
          vec2 axisBlend = smoothstep(vec2(${half - 2.4}), vec2(${half}.0), abs(vTilePosition.xz));
          ${blend}`);
      } else if (surface.family === "walls" || surface.family === "floor") {
        lighting = lighting.replace("irradiance += lightMapIrradiance;", `
            float edgeDistance = max(abs(vTilePosition.x), abs(vTilePosition.z));
            float joinBlend = smoothstep(14.3, 16.0, edgeDistance);
            float profile = ${surface.family === "floor"
              ? "clamp(min(abs(vTilePosition.x), abs(vTilePosition.z)) / 1.1, 0.0, 1.0)"
              : "clamp((vTilePosition.y - 0.12) / 2.2, 0.0, 1.0)"};
            vec3 joinIrradiance = texture2D(corridorLighting, vec2((profile * 63.0 + 0.5) / 64.0, ${surface.family === "floor" ? "0.75" : "0.25"})).rgb * lightMapIntensity;
            irradiance += mix(lightMapIrradiance, joinIrradiance, joinBlend);`);
      }
      shader.fragmentShader = shader.fragmentShader.replace("#include <lights_fragment_maps>", lighting);
      // Probe directions stay attached to a room when the streaming system rotates it.
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying mat3 vRoomRotation;\nattribute vec3 tilePosition;\nvarying vec3 vTilePosition;")
        .replace("#include <project_vertex>", `#include <project_vertex>
          vTilePosition = tilePosition;
          vRoomRotation = mat3(normalize(modelMatrix[0].xyz), normalize(modelMatrix[1].xyz), normalize(modelMatrix[2].xyz));`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying mat3 vRoomRotation;\nvarying vec3 vTilePosition;\nuniform sampler2D corridorLighting;")
        .replace("#include <envmap_physical_pars_fragment>", THREE.ShaderChunk.envmap_physical_pars_fragment
          .replace("envMapRotation * reflectVec", "envMapRotation * transpose(vRoomRotation) * reflectVec"));
    };
    materials.set(key, material);
  }));
  const [models] = await Promise.all([modelsPromise, materialsPromise, environmentPromise]);
  const prototypes = new Map<string, THREE.Object3D>();
  let meshCount = 0;
  for (const { id, gltf } of models) {
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      let node: THREE.Object3D | null = object;
      let surfaceKey: string | undefined;
      while (node && !surfaceKey) { surfaceKey = node.userData.surface as string | undefined; node = node.parent; }
      const material = surfaceKey ? materials.get(surfaceKey) : undefined;
      if (!material) throw new Error(`Reference mesh has no material assignment: ${object.name}`);
      if (!object.geometry.attributes.uv || (material instanceof THREE.MeshStandardMaterial && !object.geometry.attributes.uv1)) {
        throw new Error(`Reference mesh is missing surface or lighting UVs: ${object.name}`);
      }
      const tilePosition = object.geometry.attributes.position.clone();
      tilePosition.applyMatrix4(object.matrixWorld);
      object.geometry.setAttribute("tilePosition", tilePosition);
      for (const old of Array.isArray(object.material) ? object.material : [object.material]) old.dispose();
      object.material = material;
      object.geometry.computeBoundingSphere();
      meshCount++;
    });
    prototypes.set(id, gltf.scene);
  }
  return { prototypes, meshCount, atlasCount: kit.templates.reduce((sum, template) => sum + template.radiance.length, 0) };
}
