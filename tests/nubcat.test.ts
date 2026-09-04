import { expect, test } from "bun:test";
import * as THREE from "three";
import {
  CHARACTERS,
  DEFAULT_CHARACTER,
  characterDef,
  getCharacter,
  setCharacter,
} from "../src/nubcat";

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

test("character table covers male + female with distinct rigs and colors", () => {
  expect(CHARACTERS.map((c) => c.id).sort()).toEqual(["female", "male"]);
  const [female, male] = [characterDef("female"), characterDef("male")];
  expect(female.walkUrl).toBe("models/pinkNUB-walk.v2.glb");
  expect(male.walkUrl).toBe("models/blueNUB-walk.v2.glb");
  expect(female.walkUrl === male.walkUrl).toBe(false);
  expect(female.idleUrl === male.idleUrl).toBe(false);
  expect(female.bodyColor).toBe(0xffcadc);
  expect(male.bodyColor).toBe(0x64a6ff);
});

test("unknown ids fall back to the default character", () => {
  expect(characterDef("???").id).toBe(DEFAULT_CHARACTER);
  expect(characterDef("").id).toBe(DEFAULT_CHARACTER);
});

test("getCharacter is safe without storage and setCharacter round-trips the def", () => {
  expect(["female", "male"]).toContain(getCharacter());
  expect(setCharacter("male").id).toBe("male");
  expect(setCharacter("bogus").id).toBe(DEFAULT_CHARACTER);
});
