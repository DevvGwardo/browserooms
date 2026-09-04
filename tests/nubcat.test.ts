import { expect, test } from "bun:test";
import * as THREE from "three";
import { NUBCAT_WALK_URL, NUBCAT_IDLE_URL } from "../src/nubcat";

// The loader's clone contract: each clone must own its skeleton so a mixer
// driving one clone's bones cannot move (or freeze) another clone's skin.
// Plain Object3D.clone() shares Skeleton objects — SkeletonUtils.clone()
// re-binds. These tests pin the three.js semantics the loader relies on.
test("plain clone shares the skeleton (why the loader must not use it)", () => {
  const bone = new THREE.Bone();
  bone.name = "leg";
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.SkinnedMesh(geometry);
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  const copy = mesh.clone(true) as THREE.SkinnedMesh;
  expect(copy.skeleton).toBe(mesh.skeleton);
});

test("loader exposes distinct walk/idle URLs", () => {
  expect(NUBCAT_WALK_URL).toBe("models/sillyNubCat-walk.glb");
  expect(NUBCAT_IDLE_URL).toBe("models/sillyNubCat.glb");
  expect(NUBCAT_WALK_URL === NUBCAT_IDLE_URL).toBe(false);
});
