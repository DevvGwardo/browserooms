import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/**
 * Single-flight loader for the OpenClawWorld sillyNubCat rig. The Entity and
 * the third-person avatar both need it; before this module each issued its own
 * fetch + parse + GPU upload (double cost on every boot). Callers get an
 * independent clone (shared geometry/materials, private nodes) and must
 * mutate only their own clone — the cached source is never handed out.
 *
 * The default URL is the Blender-baked walk-cycle variant; pass
 * NUBCAT_IDLE_URL for the original unanimated rig.
 */
const pending = new Map<string, Promise<{ scene: THREE.Object3D; clips: THREE.AnimationClip[] }>>();

export const NUBCAT_WALK_URL = "models/sillyNubCat-walk.glb";
export const NUBCAT_IDLE_URL = "models/sillyNubCat.glb";

export type NubCatModel = {
  /** Independent clone; safe to re-material, re-pose, or attach a mixer to. */
  model: THREE.Object3D;
  /** Fresh clips for this clone (AnimationClip.findByName + mixer.clipAction). */
  clips: THREE.AnimationClip[];
};

export function loadNubCat(url: string = NUBCAT_WALK_URL): Promise<NubCatModel> {
  let flight = pending.get(url);
  if (!flight) {
    flight = new GLTFLoader().loadAsync(url).then(
      (gltf) => ({ scene: gltf.scene as THREE.Object3D, clips: gltf.animations ?? [] }),
      () => {
        pending.delete(url);
        throw new Error("sillyNubCat model unavailable.");
      },
    );
    pending.set(url, flight);
  }
  return flight.then(({ scene, clips }) => ({
    model: scene.clone(true),
    clips: clips.map((clip) => clip.clone()),
  }));
}
