import * as THREE from "three";

/** Detail lives in metres, independently of the lower-density baked lighting atlas. */
export function applySurfaceDetail(material: THREE.MeshBasicMaterial, family: string, texture: THREE.Texture) {
  const wall = family === "walls";
  const floor = family === "floor";
  const tint = wall ? "vec3(1.13, 1.08, 0.67)" : floor ? "vec3(1.12, 1.04, 0.72)" : "vec3(1.02, 1.02, 0.90)";
  const coordinates = wall ? "vec2(vDetailPosition.x - vDetailPosition.z, vDetailPosition.y) / vec2(0.368, 0.448)" : "vDetailPosition.xz / 2.0";
  material.customProgramCacheKey = () => `surface-detail-${family}-1`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.surfaceDetail = { value: texture };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 detailPosition;\nvarying vec3 vDetailPosition;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvDetailPosition = detailPosition;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vDetailPosition;\nuniform sampler2D surfaceDetail;")
      .replace("#include <map_fragment>", `#include <map_fragment>
        float detail = texture2D(surfaceDetail, ${coordinates}).r * 2.0;
        float detailStrength = ${wall || floor ? "1.0" : "0.2"};
        ${!wall && !floor ? "detailStrength *= 1.0 - smoothstep(0.8, 2.0, max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b));" : ""}
        diffuseColor.rgb *= mix(1.0, detail, detailStrength) * ${tint};`);
  };
}
