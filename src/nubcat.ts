import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/**
 * Single-flight loader for the OpenClawWorld sillyNubCat rig. The Entity and
 * the third-person avatar both need it; before this module each issued its own
 * fetch + parse + GPU upload (double cost on every boot). Callers get an
 * independent clone (shared geometry/materials, private nodes) and must
 * mutate only their own clone — the cached source is never handed out.
 */
let pending: Promise<THREE.Object3D> | null = null;

export function loadNubCat(): Promise<THREE.Object3D> {
  if (!pending) {
    pending = new GLTFLoader().loadAsync("models/sillyNubCat.glb").then(
      (gltf) => gltf.scene as THREE.Object3D,
      () => {
        pending = null;
        throw new Error("sillyNubCat model unavailable.");
      },
    );
  }
  return pending.then((scene) => scene.clone(true));
}
