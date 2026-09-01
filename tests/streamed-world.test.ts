import { expect, test } from "bun:test";
import * as THREE from "three";
import { StreamedWorld } from "../src/streamed-world";
import type { Kit, WorldTemplate } from "../src/world-layout";

function setup(version: 1 | 2 = 1) {
  const geometry = version === 1 ? new THREE.BoxGeometry(1, 1, 1) : new THREE.BoxGeometry(36, 0.2, 36);
  const material = new THREE.MeshBasicMaterial();
  const templates: WorldTemplate[] = ["gallery", "offset", "pillars"].map((id) => ({
    id, geometry: `${id}.glb`, radiance: [],
    colliders: [{ min: [-4, 0, -4], max: [-3, 3, 4] }],
    lights: [{ id: "panel", position: [2, 3, 2] }],
    rooms: [{ id: "main", bounds: { min: [-12, 0, -12], max: [12, 3, 12] } }],
    anchors: [{ id: "floor-a", roomId: "main", kind: "floor", position: [5, 0, 5], yaw: 0, clearance: [1, 2, 1] }],
    spawn: { position: [0, 1.65, 0], yaw: 0, pitch: 0 },
  }));
  const kit: Kit = version === 1 ? { version: 1, cellSize: 32, templates, bake: {} }
    : { version: 2, layout: "continuous", cellSize: 36, templates, bake: {},
      boundaryPassages: [{ min: -18, max: -9.12 }, { min: -8.88, max: 8.88 }, { min: 9.12, max: 18 }] };
  const prototypes = new Map(templates.map((template) => {
    const group = new THREE.Group();
    const floor = new THREE.Mesh(geometry, material);
    group.add(floor);
    if (version === 2) {
      floor.position.y = -0.1;
      const ceiling = new THREE.Mesh(geometry, material);
      ceiling.position.y = 3.1;
      group.add(ceiling);
    }
    return [template.id, group] as const;
  }));
  return { world: new StreamedWorld(kit, "endless-test", prototypes), geometry, material, kit, prototypes };
}

test("loaded scene, colliders, and anchors stay bounded after 1000 chunk visits", () => {
  const { world, geometry, material } = setup();
  const firstFingerprint = world.stats.fingerprint;
  const firstAnchors = JSON.stringify(world.current.anchors);
  for (let i = 0; i < 1000; i++) {
    world.setOrigin(i * 11 - 5000, i % 31 - 15);
    expect(world.loaded.size).toBe(25);
    expect(world.root.children.length).toBe(25);
    expect(world.colliders.length).toBe(9);
    expect(world.lights.length).toBe(9);
    expect(world.stats.loadedAnchors).toBe(25);
  }
  world.root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    expect(object.geometry).toBe(geometry);
    expect(object.material).toBe(material);
  });
  world.setOrigin(0, 0);
  expect(world.stats.fingerprint).toBe(firstFingerprint);
  expect(JSON.stringify(world.current.anchors)).toBe(firstAnchors);
});

test("crossing a boundary rebases without a camera-relative geometry jump", () => {
  const { world } = setup();
  const camera = new THREE.Vector3(16.15, 1.65, -2);
  const neighbour = world.loaded.get("1,0")!.object;
  const distanceBefore = neighbour.position.clone().sub(camera);
  expect(world.update(camera)).toEqual({ x: -32, z: 0 });
  expect(world.origin).toEqual({ x: 1, z: 0 });
  expect(world.loaded.get("1,0")!.object).toBe(neighbour);
  expect(neighbour.position.clone().sub(camera).distanceTo(distanceBefore)).toBeLessThan(1e-10);
  expect(camera.x).toBeCloseTo(-15.85);
});

test("negative and large chunk coordinates retain small rendering coordinates", () => {
  const { world } = setup();
  world.setOrigin(-1_000_000_000, 1_000_000_000);
  const camera = new THREE.Vector3(-16.1, 1.65, 16.2);
  world.update(camera);
  expect(world.origin).toEqual({ x: -1_000_000_001, z: 1_000_000_001 });
  expect(camera.x).toBeCloseTo(15.9);
  expect(camera.z).toBeCloseTo(-15.8);
  expect(world.root.children.every((object) => Math.abs(object.position.x) <= 64 && Math.abs(object.position.z) <= 64)).toBe(true);
});

test("chunk lifecycle exposes stable placement metadata and an unrotated content parent", () => {
  const { world } = setup();
  const loaded: string[] = [];
  const unloaded: string[] = [];
  world.addEventListener("chunkload", ({ definition, object }) => {
    loaded.push(definition.id);
    expect(object.parent).toBe(world.root);
    expect(object.rotation.y).toBe(0);
    expect(object.userData.chunkId).toBe(definition.id);
    expect(definition.anchors.length).toBe(1);
    expect(world.loaded.size).toBe(25);
    expect(world.colliders.length).toBe(9);
    for (const chunk of world.loaded.values()) {
      expect(chunk.object.position.x).toBe((chunk.definition.x - world.origin.x) * 32);
      expect(chunk.object.position.z).toBe((chunk.definition.z - world.origin.z) * 32);
    }
  });
  world.addEventListener("chunkunload", ({ definition, object }) => {
    unloaded.push(definition.id);
    expect(object.parent).toBe(world.root);
    expect(object.children.length).toBe(1);
  });
  world.setOrigin(1, 0);
  expect(loaded.length).toBe(5);
  expect(unloaded.length).toBe(5);
  expect(world.root.children.length).toBe(25);
});

test("invalid destinations leave the loaded world and collision frame untouched", () => {
  const { world } = setup();
  const before = JSON.stringify(world.stats);
  const colliders = world.colliders;
  expect(() => world.setOrigin(NaN, 0)).toThrow();
  expect(() => world.setOrigin(Number.MAX_SAFE_INTEGER, 0)).toThrow();
  expect(JSON.stringify(world.stats)).toBe(before);
  expect(world.colliders).toBe(colliders);
});

test("collider faces translate by the same rebase delta as rendered chunks", () => {
  const { world } = setup();
  const before = world.colliders.find((box) => box.min[0] === -4 && box.min[2] === -4)!;
  const camera = new THREE.Vector3(16.1, 1.65, 0);
  const shift = world.update(camera)!;
  const after = world.colliders.find((box) => box.min[0] === before.min[0] + shift.x && box.min[2] === before.min[2] + shift.z)!;
  expect(after).toBeDefined();
  expect(after.max[0]).toBe(before.max[0] + shift.x);
  expect(after.max[2]).toBe(before.max[2] + shift.z);
});

test("continuous floor and ceiling seams, colliders and lights survive 36m rebases without a jump", () => {
  const { world } = setup(2);
  for (const [x, z] of [[0, 0], [-(2 ** 40), 2 ** 40]]) {
    for (const [px, pz, dx, dz] of [[18.15, 2, 1, 0], [-18.15, 2, -1, 0], [2, 18.15, 0, 1], [2, -18.15, 0, -1], [-18.15, 18.15, -1, 1]]) {
      world.setOrigin(x, z);
      const camera = new THREE.Vector3(px, 1.65, pz);
      const home = world.loaded.get(`${x},${z}`)!.object;
      const neighbor = world.loaded.get(`${x + dx},${z + dz}`)!.object;
      const distance = neighbor.position.clone().sub(camera);
      const seamBefore = new THREE.Box3().setFromObject(home);
      const neighborBefore = new THREE.Box3().setFromObject(neighbor);
      if (dx > 0) expect(seamBefore.max.x).toBe(neighborBefore.min.x);
      if (dx < 0) expect(seamBefore.min.x).toBe(neighborBefore.max.x);
      if (dz > 0) expect(seamBefore.max.z).toBe(neighborBefore.min.z);
      if (dz < 0) expect(seamBefore.min.z).toBe(neighborBefore.max.z);
      const lightId = world.current.lights[0].id;
      const lightBefore = world.lights.find(light => light.id === lightId)!;
      const colliderBefore = world.colliders.find(box => box.min[0] === -4 && box.min[2] === -4)!;
      const shift = world.update(camera)!;
      expect(shift).toEqual({ x: -dx * 36 || 0, z: -dz * 36 || 0 });
      expect(world.origin).toEqual({ x: x + dx, z: z + dz });
      expect(world.loaded.get(`${x + dx},${z + dz}`)!.object).toBe(neighbor);
      expect(neighbor.position.clone().sub(camera).distanceTo(distance)).toBeLessThan(1e-10);
      const seamAfter = new THREE.Box3().setFromObject(home);
      expect(seamAfter.min.x).toBe(seamBefore.min.x + shift.x);
      expect(seamAfter.max.z).toBe(seamBefore.max.z + shift.z);
      const lightAfter = world.lights.find(light => light.id === lightId)!;
      expect(lightAfter.position).toEqual([lightBefore.position[0] + shift.x, lightBefore.position[1], lightBefore.position[2] + shift.z]);
      const colliderAfter = world.colliders.find(box => box.min[0] === colliderBefore.min[0] + shift.x && box.min[2] === colliderBefore.min[2] + shift.z)!;
      expect(colliderAfter.max).toEqual([colliderBefore.max[0] + shift.x, colliderBefore.max[1], colliderBefore.max[2] + shift.z]);
      expect(world.root.children.every(object => Math.abs(object.position.x) <= 72 && Math.abs(object.position.z) <= 72)).toBe(true);
      expect(world.update(camera)).toBeNull();
    }
  }
});

test("continuous streaming keeps only 25 clones, nine collision/light cells and prototype-owned resources", () => {
  const { world, geometry, material, prototypes } = setup(2);
  let disposed = 0;
  geometry.addEventListener("dispose", () => disposed++);
  material.addEventListener("dispose", () => disposed++);
  const fingerprint = world.stats.fingerprint;
  const anchors = structuredClone(world.current.anchors);
  const outgoing = world.loaded.get("0,0")!.object;
  for (let i = 0; i < 100; i++) {
    world.setOrigin(-(2 ** 40) + i * 11, 2 ** 40 - i * 7);
    expect(world.loaded.size).toBe(25);
    expect(world.root.children).toHaveLength(25);
    expect(world.colliders).toHaveLength(9);
    expect(world.lights).toHaveLength(9);
    expect(world.stats.loadedAnchors).toBe(25);
    const instances = new Set<THREE.Object3D>();
    for (const { definition, object } of world.loaded.values()) {
      expect(definition.quarterTurns).toBe(0);
      expect(object.rotation.y).toBe(0);
      expect(object.children[0].rotation.y).toBe(0);
      expect(object.children[0]).not.toBe(prototypes.get(definition.templateId)!);
      object.traverse(child => {
        if (!(child instanceof THREE.Mesh)) return;
        expect(child.geometry).toBe(geometry);
        expect(child.material).toBe(material);
        instances.add(child);
      });
    }
    expect(instances.size).toBe(50);
    expect(world.colliders.every(box => Math.abs(box.min[0]) <= 40 && Math.abs(box.min[2]) <= 40)).toBe(true);
  }
  expect(outgoing.parent).toBeNull();
  expect(outgoing.children).toHaveLength(0);
  expect(disposed).toBe(0);
  for (const prototype of prototypes.values()) expect(prototype.children).toHaveLength(2);
  world.setOrigin(0, 0);
  expect(world.stats.fingerprint).toBe(fingerprint);
  expect(world.current.anchors).toEqual(anchors);
});

test("continuous lifecycle retains the content parent, stable anchors and unrotated spawn", () => {
  const { world, kit } = setup(2);
  const parent = world.loaded.get("0,0")!.object;
  const prop = new THREE.Object3D();
  prop.position.fromArray(world.current.anchors[0].position);
  parent.add(prop);
  let loads = 0;
  let unloads = 0;
  world.addEventListener("chunkload", ({ definition, object }) => {
    loads++;
    expect(world.loaded.size).toBe(25);
    expect(world.colliders).toHaveLength(9);
    expect(object.parent).toBe(world.root);
    expect(object.userData.chunkId).toBe(definition.id);
    expect(object.rotation.y).toBe(0);
    expect(object.position.x).toBe((definition.x - world.origin.x) * 36);
    expect(object.position.z).toBe((definition.z - world.origin.z) * 36);
  });
  world.addEventListener("chunkunload", ({ object }) => {
    unloads++;
    expect(object.parent).toBe(world.root);
    expect(object.children).toHaveLength(1);
  });
  const camera = new THREE.Vector3(18.1, 1.65, 0);
  const before = prop.getWorldPosition(new THREE.Vector3()).sub(camera);
  world.update(camera);
  expect(loads).toBe(5);
  expect(unloads).toBe(5);
  expect(prop.parent).toBe(parent);
  expect(prop.getWorldPosition(new THREE.Vector3()).sub(camera).distanceTo(before)).toBeLessThan(1e-10);
  expect(world.spawnAt(1, 0)).toEqual(kit.templates.find(template => template.id === world.current.templateId)!.spawn);
});

test("constructor rejects unsupported versions, sizes and malformed continuous boundary intervals", () => {
  const { kit, prototypes } = setup(2);
  const invalid = [
    { version: 3 }, { version: 1 }, { cellSize: 32 }, { cellSize: 72 }, { layout: "rooms" },
    { boundaryPassages: undefined }, { boundaryPassages: null }, { boundaryPassages: [] },
    { boundaryPassages: [{ min: -18, max: 18 }] },
    ...[null, { min: NaN, max: -9.12 }, { min: -18, max: Infinity },
      { min: -19, max: -9.12 }, { min: -18, max: 19 }, { min: -9, max: -9 },
      { min: -8, max: -9 }, { min: -18, max: -8 }, { min: 10, max: 11 }]
      .map(passage => ({ boundaryPassages: [passage, { min: -8.88, max: 8.88 }, { min: 9.12, max: 18 }] })),
  ];
  for (const fields of invalid) {
    expect(() => new StreamedWorld({ ...kit, ...fields } as unknown as Kit, "invalid", prototypes)).toThrow("Invalid architecture kit");
  }
  expect(() => new StreamedWorld({ ...kit, templates: [] }, "invalid", prototypes)).toThrow("Invalid architecture kit");
  expect(() => new StreamedWorld({ ...kit, templates: [kit.templates[0], kit.templates[0]] }, "invalid", prototypes)).toThrow("Invalid architecture kit");
  expect(() => new StreamedWorld(kit, "invalid", new Map())).toThrow("Missing room module");
});
