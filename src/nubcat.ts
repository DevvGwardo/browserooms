import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

export type CharacterId = "female" | "male";

export type CharacterDef = {
  id: CharacterId;
  /** Settings label, e.g. "Female (pink)". */
  label: string;
  walkUrl: string;
  idleUrl: string;
  /** Artist body color as a hex number (blue male, pink female). */
  bodyColor: number;
};

/** The two .blend rigs differ by color only: identical meshes, rig, face. */
export const CHARACTERS: CharacterDef[] = [
  {
    id: "female",
    label: "Female (pink)",
    walkUrl: "models/pinkNUB-walk.v2.glb",
    idleUrl: "models/pinkNUB.v2.glb",
    bodyColor: 0xffcadc,
  },
  {
    id: "male",
    label: "Male (blue)",
    walkUrl: "models/blueNUB-walk.v2.glb",
    idleUrl: "models/blueNUB.v2.glb",
    bodyColor: 0x64a6ff,
  },
];

export const DEFAULT_CHARACTER: CharacterId = "female";
const STORAGE_KEY = "backrooms.character.v1";

export function characterDef(id: string): CharacterDef {
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
}

/** Saved choice, validated; storage may be unavailable (private mode, tests). */
export function getCharacter(): CharacterId {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_CHARACTER;
    return characterDef(localStorage.getItem(STORAGE_KEY) ?? "").id;
  } catch {
    return DEFAULT_CHARACTER;
  }
}

export function setCharacter(id: string): CharacterDef {
  const def = characterDef(id);
  try {
    localStorage.setItem(STORAGE_KEY, def.id);
  } catch {
    /* Storage is optional. */
  }
  return def;
}

/**
 * Single-flight loader for the nub rigs. The Entity and
 * the third-person avatar both need it; before this module each issued its own
 * fetch + parse + GPU upload (double cost on every boot). Callers get an
 * independent clone (shared geometry/materials, private nodes) and must
 * mutate only their own clone — the cached source is never handed out.
 *
 * Pass a walk URL for the Blender-baked walk-cycle variant (default: the
 * current character's), or an idle URL for the unanimated rig.
 */
const pending = new Map<string, Promise<{ scene: THREE.Object3D; clips: THREE.AnimationClip[] }>>();

export type NubCatModel = {
  /** Independent clone; safe to re-material, re-pose, or attach a mixer to. */
  model: THREE.Object3D;
  /** Fresh clips for this clone (AnimationClip.findByName + mixer.clipAction). */
  clips: THREE.AnimationClip[];
};

export function loadNubCat(url?: string): Promise<NubCatModel> {
  const resolved = url ?? characterDef(getCharacter()).walkUrl;
  let flight = pending.get(resolved);
  if (!flight) {
    flight = new GLTFLoader().loadAsync(resolved).then(
      (gltf) => ({ scene: gltf.scene as THREE.Object3D, clips: gltf.animations ?? [] }),
      () => {
        pending.delete(resolved);
        throw new Error("nub model unavailable.");
      },
    );
    pending.set(resolved, flight);
  }
  return flight.then(({ scene, clips }) => ({
    // Plain Object3D.clone() shares the Skeleton object, so a mixer driving
    // the clone's bones would never move its skin. SkeletonUtils.clone()
    // re-binds each clone to its own skeleton (bones + inverse bind matrices).
    model: cloneSkinned(scene),
    clips: clips.map((clip) => clip.clone()),
  }));
}

/** One shared face texture for every consumer (same file for both rigs). */
let faceTexture: THREE.Texture | null = null;

export function nubFaceTexture(): THREE.Texture {
  if (!faceTexture) {
    faceTexture = new THREE.TextureLoader().load("models/nubtex/test_face_neutral.png");
    faceTexture.colorSpace = THREE.SRGBColorSpace;
  }
  return faceTexture;
}
