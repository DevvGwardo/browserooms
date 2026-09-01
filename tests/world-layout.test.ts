import { describe, expect, test } from "bun:test";
import { chunkAt, chunkFingerprint, describeChunk, transformCollider, type Chunk, type Kit, type Vec3, type WorldTemplate } from "../src/world-layout";

const gallery: WorldTemplate = {
  id: "gallery",
  geometry: "gallery.glb",
  radiance: [{ file: "gallery.hdr", family: "warm", flipY: true }],
  colliders: [{ min: [-7, 0, -2], max: [-5, 3, 4] }],
  lights: [{ id: "panel", position: [2, 3, -4] }],
  rooms: [
    { id: "main", bounds: { min: [-12, 0, -8], max: [10, 3, 14] } },
    { id: "alcove", bounds: { min: [-4, 0, -14], max: [3, 3, -8] } },
  ],
  anchors: [
    { id: "chair", roomId: "main", kind: "floor", position: [3, 0, -5], yaw: 0.3, clearance: [2, 1, 4] },
    { id: "picture", roomId: "alcove", kind: "wall", position: [-2, 1.5, -13], yaw: -0.7, clearance: [3, 2, 0.5] },
    { id: "lamp", roomId: "main", kind: "ceiling", position: [0, 3, 0], yaw: 0, clearance: [1, 0.5, 2] },
  ],
  spawn: { position: [0, 1.65, 0], yaw: 0, pitch: 0 },
};
const offset: WorldTemplate = { ...structuredClone(gallery), id: "offset", geometry: "offset.glb" };
const kit: Kit = { version: 1, cellSize: 32, templates: [gallery, offset], bake: {} };
const seeds = ["", "home", "elsewhere", "a:b,1", "a/b", "%2F", "\u2603", "\ud800"];
const coords = [[0, 0], [1, -1], [-3, 7], [200, -500], [2 ** 32, 19], [-(2 ** 32), -19], [2 ** 48, -(2 ** 48)], [Number.MAX_SAFE_INTEGER - 1, Number.MIN_SAFE_INTEGER + 1]];

// Independent trigonometric oracle follows Three's positive Y rotation.
function rotated(point: number[], turns: number): Vec3 {
  const angle = turns * Math.PI / 2;
  return [point[0] * Math.cos(angle) + point[2] * Math.sin(angle), point[1], -point[0] * Math.sin(angle) + point[2] * Math.cos(angle)];
}

describe("deterministic world layout", () => {
  test("revisiting in reverse order produces identical serializable layouts", () => {
    const requests = seeds.flatMap(seed => coords.map(([x, z]) => ({ seed, x, z })));
    const before = JSON.stringify(kit);
    const first = requests.map(({ seed, x, z }) => describeChunk(seed, x, z, kit));
    const revisited = [...requests].reverse().map(({ seed, x, z }) => describeChunk(seed, x, z, kit)).reverse();
    expect(revisited).toEqual(first);
    for (const chunk of first) expect(JSON.parse(JSON.stringify(chunk))).toEqual(chunk);
    expect(JSON.stringify(kit)).toBe(before);
    expect(new Set(first.map(chunk => chunk.id)).size).toBe(first.length);
    expect(new Set(first.flatMap(chunk => chunk.rooms.map(room => room.id))).size).toBe(first.length * 2);
    expect(new Set(first.flatMap(chunk => chunk.anchors.map(anchor => anchor.id))).size).toBe(first.length * 3);
  });

  test("origin always uses the first gallery template without rotation", () => {
    for (const seed of seeds) {
      const chunk = describeChunk(seed, 0, 0, kit);
      expect(chunk.templateId).toBe("gallery");
      expect(chunk.quarterTurns).toBe(0);
      expect(chunk.rooms[0].bounds).toEqual(gallery.rooms[0].bounds);
      expect(chunk.anchors[0].position).toEqual(gallery.anchors[0].position);
      expect(chunk.anchors[0].yaw).toBe(gallery.anchors[0].yaw);
    }
    expect(describeChunk("home", -0, -0, kit)).toEqual(describeChunk("home", 0, 0, kit));
  });

  test("template selection is invariant to catalog ordering outside the origin", () => {
    const reversed = { ...kit, templates: [...kit.templates].reverse() };
    for (const seed of seeds) for (const [x, z] of coords.slice(1)) {
      expect(describeChunk(seed, x, z, reversed)).toEqual(describeChunk(seed, x, z, kit));
    }
  });

  test("seed and full coordinate strings influence both template and rotation", () => {
    const choices = new Set<string>();
    let seedChanges = 0;
    let farXChanges = 0;
    let farZChanges = 0;
    const choice = (chunk: Chunk) => `${chunk.templateId}/${chunk.quarterTurns}`;
    for (let i = 1; i <= 128; i++) {
      const base = choice(describeChunk("home", i, -i, kit));
      choices.add(base);
      if (base !== choice(describeChunk("elsewhere", i, -i, kit))) seedChanges++;
      if (base !== choice(describeChunk("home", i + 2 ** 32, -i, kit))) farXChanges++;
      if (base !== choice(describeChunk("home", i, -i - 2 ** 32, kit))) farZChanges++;
    }
    expect(choices.size).toBe(8);
    expect(seedChanges).toBeGreaterThan(64);
    expect(farXChanges).toBeGreaterThan(64);
    expect(farZChanges).toBeGreaterThan(64);
  });

  test("IDs preserve the full encoded seed and exact coordinates, including extreme safe integers", () => {
    for (const seed of seeds) {
      const chunk = describeChunk(seed, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, kit);
      expect(chunk.id).toBe(`world-v1:${encodeURIComponent(JSON.stringify(seed))}:9007199254740991,-9007199254740991`);
      expect(chunk.portals.find(p => p.direction === "east")!.neighborChunkId).toEndWith(":9007199254740992,-9007199254740991");
      expect(chunk.portals.find(p => p.direction === "north")!.neighborChunkId).toEndWith(":9007199254740991,-9007199254740992");
    }
  });

  test("anchors and room bounds rotate locally and maintain room relationships", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 64; i++) {
      const chunk = describeChunk("rotation", 2 ** 40 + i, -(2 ** 40), kit);
      seen.add(chunk.quarterTurns);
      expect(chunk.quarterTurns).toBeInteger();
      expect(chunk.quarterTurns).toBeGreaterThanOrEqual(0);
      expect(chunk.quarterTurns).toBeLessThan(4);
      chunk.anchors.forEach((anchor, index) => {
        const source = gallery.anchors[index];
        const position = rotated(source.position, chunk.quarterTurns);
        anchor.position.forEach((value, axis) => expect(value).toBeCloseTo(position[axis], 10));
        expect(anchor.id).toBe(`${chunk.id}/anchor/${source.id}`);
        expect(anchor.roomId).toBe(`${chunk.id}/room/${source.roomId}`);
        expect(chunk.rooms.some(room => room.id === anchor.roomId)).toBe(true);
        expect(anchor.kind).toBe(source.kind);
        expect(anchor.yaw).toBeCloseTo(source.yaw + chunk.quarterTurns * Math.PI / 2);
        expect(anchor.clearance).toEqual(chunk.quarterTurns % 2 ? [source.clearance[2], source.clearance[1], source.clearance[0]] : source.clearance);
      });
      chunk.rooms.forEach((room, index) => {
        expect(room.id).toBe(`${chunk.id}/room/${gallery.rooms[index].id}`);
        expect(room.bounds).toEqual(transformCollider(gallery.rooms[index].bounds, chunk.quarterTurns));
        expect(Math.max(...room.bounds.min.map(Math.abs), ...room.bounds.max.map(Math.abs))).toBeLessThanOrEqual(16);
      });
    }
    expect(seen.size).toBe(4);
  });

  test("four canonical portals pair reciprocally across every neighbor", () => {
    const directions = [["north", "south", 0, -1], ["east", "west", 1, 0], ["south", "north", 0, 1], ["west", "east", -1, 0]] as const;
    for (const seed of seeds) for (const [x, z] of coords) {
      const chunk = describeChunk(seed, x, z, kit);
      expect(chunk.portals.map(p => p.direction)).toEqual(directions.map(d => d[0]));
      for (const [direction, opposite, dx, dz] of directions) {
        const portal = chunk.portals.find(p => p.direction === direction)!;
        const neighbor = describeChunk(seed, x + dx, z + dz, kit);
        const reverse = neighbor.portals.find(p => p.direction === opposite)!;
        expect(portal.neighborChunkId).toBe(neighbor.id);
        expect(reverse.neighborChunkId).toBe(chunk.id);
        expect(portal.center).toEqual([dx * 16, 1.2, dz * 16]);
        expect(portal.center[0]).toBe(reverse.center[0] + dx * 32);
        expect(portal.center[2]).toBe(reverse.center[2] + dz * 32);
        expect(portal.width).toBe(2.4);
        expect(portal.height).toBe(2.4);
      }
    }
  });

  test("returned layouts do not share mutable metadata with the kit or subsequent visits", () => {
    const pristine = describeChunk("home", 0, 0, kit);
    const changed = describeChunk("home", 0, 0, kit);
    changed.anchors[0].position[0] = 999;
    changed.anchors[0].clearance[0] = 999;
    changed.rooms[0].bounds.min[0] = 999;
    changed.portals[0].center[0] = 999;
    expect(describeChunk("home", 0, 0, kit)).toEqual(pristine);
    expect(gallery.anchors[0].position[0]).toBe(3);
    expect(gallery.anchors[0].clearance[0]).toBe(2);
    expect(gallery.rooms[0].bounds.min[0]).toBe(-12);
  });

  test("fingerprints cover every generated metadata field", () => {
    const chunk = describeChunk("audit", 4, -8, kit);
    const original = chunkFingerprint(chunk);
    expect(original).toMatch(/^[0-9a-f]{8}$/);
    expect(chunkFingerprint(JSON.parse(JSON.stringify(chunk)))).toBe(original);
    const mutateLeaves = (value: unknown, path: (string | number)[] = []): void => {
      if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) mutateLeaves(child, [...path, key]);
      } else {
        const modified = structuredClone(chunk);
        let target: any = modified;
        for (const key of path.slice(0, -1)) target = target[key];
        target[path[path.length - 1]] = typeof value === "number" ? value + 0.125 : `${value}!`;
        expect(chunkFingerprint(modified)).not.toBe(original);
      }
    };
    mutateLeaves(chunk);
  });

  test("invalid coordinates and empty catalogs reject", () => {
    for (const bad of [NaN, Infinity, -Infinity, 0.5, -0.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
      expect(() => describeChunk("home", bad, 0, kit)).toThrow(RangeError);
      expect(() => describeChunk("home", 0, bad, kit)).toThrow(RangeError);
    }
    expect(() => describeChunk("home", 0, 0, { ...kit, templates: [] })).toThrow(RangeError);
  });
});

describe("continuous v2 layout", () => {
  const continuous: Kit = {
    version: 2, layout: "continuous", cellSize: 36, templates: [gallery, offset], bake: {},
    boundaryPassages: [{ min: -18, max: -9.12 }, { min: -8.88, max: 8.88 }, { min: 9.12, max: 18 }],
  };

  test("all seeds and coordinates keep templates, lights and anchors world-aligned", () => {
    const before = JSON.stringify(continuous);
    const reordered = { ...continuous, templates: [...continuous.templates].reverse() };
    for (const seed of seeds) for (const [x, z] of coords) {
      const chunk = describeChunk(seed, x, z, continuous);
      expect(chunk.quarterTurns).toBe(0);
      expect(chunk.rooms.map(room => room.bounds)).toEqual(gallery.rooms.map(room => room.bounds));
      expect(chunk.lights.map(light => light.position)).toEqual(gallery.lights.map(light => light.position));
      chunk.anchors.forEach((anchor, index) => {
        expect(anchor.position).toEqual(gallery.anchors[index].position);
        expect(anchor.yaw).toBe(gallery.anchors[index].yaw);
        expect(anchor.clearance).toEqual(gallery.anchors[index].clearance);
        expect(anchor.roomId).toBe(`${chunk.id}/room/${gallery.anchors[index].roomId}`);
      });
      expect(describeChunk(seed, x, z, continuous)).toEqual(chunk);
      if (x === 0 && z === 0) {
        expect(chunk.templateId).toBe("gallery");
        expect(describeChunk(seed, x, z, reordered).templateId).toBe("offset");
      } else expect(describeChunk(seed, x, z, reordered)).toEqual(chunk);
    }
    expect(JSON.stringify(continuous)).toBe(before);
    expect(describeChunk("home", -0, -0, continuous)).toEqual(describeChunk("home", 0, 0, continuous));
  });

  test("template variation uses the seed and full coordinates without rotation", () => {
    const choices = new Set<string>();
    const changed = [0, 0, 0];
    for (let i = 1; i <= 128; i++) {
      const base = describeChunk("home", i, -i, continuous);
      choices.add(base.templateId);
      const alternatives = [describeChunk("elsewhere", i, -i, continuous),
        describeChunk("home", i + 2 ** 32, -i, continuous),
        describeChunk("home", i, -i - 2 ** 32, continuous)];
      alternatives.forEach((chunk, index) => {
        expect(chunk.quarterTurns).toBe(0);
        if (chunk.templateId !== base.templateId) changed[index]++;
      });
    }
    expect(choices.size).toBe(2);
    for (const count of changed) expect(count).toBeGreaterThan(32);
  });

  test("twelve reciprocal crossings cover each face except the two trimmed wall stubs", () => {
    const directions = [["north", "south", 0, -1], ["east", "west", 1, 0], ["south", "north", 0, 1], ["west", "east", -1, 0]] as const;
    for (const seed of seeds) for (const [x, z] of coords) {
      const chunk = describeChunk(seed, x, z, continuous);
      expect(chunk.portals).toHaveLength(12);
      for (const [direction, opposite, dx, dz] of directions) {
        const portals = chunk.portals.filter(portal => portal.direction === direction);
        const neighbor = describeChunk(seed, x + dx, z + dz, continuous);
        const reverse = neighbor.portals.filter(portal => portal.direction === opposite);
        expect(portals).toHaveLength(3);
        expect(portals.reduce((sum, portal) => sum + portal.width, 0)).toBeCloseTo(35.52);
        portals.forEach((portal, index) => {
          const { min, max } = continuous.boundaryPassages[index];
          const tangentAxis = dx === 0 ? 0 : 2;
          expect(portal.center[tangentAxis]).toBe((min + max) / 2);
          expect(portal.center[tangentAxis] - portal.width / 2).toBeCloseTo(min);
          expect(portal.center[tangentAxis] + portal.width / 2).toBeCloseTo(max);
          expect(portal.center[dx === 0 ? 2 : 0]).toBe((dx || dz) * 18);
          expect(portal.center[1]).toBe(1.5);
          expect(portal.height).toBe(3);
          expect(portal.width).toBe(reverse[index].width);
          expect(portal.neighborChunkId).toBe(neighbor.id);
          expect(reverse[index].neighborChunkId).toBe(chunk.id);
          expect(portal.center[0]).toBeCloseTo(reverse[index].center[0] + dx * 36);
          expect(portal.center[2]).toBeCloseTo(reverse[index].center[2] + dz * 36);
        });
      }
    }
  });

  test("v2 IDs isolate persisted placement state and preserve exact seed and integer encoding", () => {
    for (const seed of seeds) {
      const chunk = describeChunk(seed, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, continuous);
      const legacy = describeChunk(seed, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, kit);
      expect(chunk.id).toBe(`world-v2:${encodeURIComponent(JSON.stringify(seed))}:9007199254740991,-9007199254740991`);
      expect(chunk.id).not.toBe(legacy.id);
      expect(chunk.anchors[0].id).not.toBe(legacy.anchors[0].id);
      expect(chunk.rooms[0].id).not.toBe(legacy.rooms[0].id);
      expect(chunk.lights[0].id).not.toBe(legacy.lights[0].id);
      for (const portal of chunk.portals.filter(p => p.direction === "east")) {
        expect(portal.neighborChunkId).toBe(`world-v2:${encodeURIComponent(JSON.stringify(seed))}:9007199254740992,-9007199254740991`);
      }
      for (const portal of chunk.portals.filter(p => p.direction === "north")) {
        expect(portal.neighborChunkId).toEndWith(":9007199254740991,-9007199254740992");
      }
    }
  });

  test("36m cells retain centered negative and large coordinate boundaries", () => {
    for (const [position, expected] of [[-54.001, -2], [-54, -1], [-18.001, -1], [-18, 0], [17.999, 0], [18, 1], [54, 2]]) {
      expect(chunkAt({ x: position, z: position }, 36)).toEqual({ x: expected, z: expected });
    }
    expect(chunkAt({ x: 2 ** 40 * 36, z: -(2 ** 40) * 36 }, 36)).toEqual({ x: 2 ** 40, z: -(2 ** 40) });
  });
});

describe("local transforms and centered grid", () => {
  test("rotated translated AABBs enclose all eight independently rotated corners", () => {
    const box = { min: [-7, 0.25, -2], max: [-5, 3, 4] };
    for (const turns of [-5, -4, -1, 0, 1, 2, 3, 4, 5]) {
      const result = transformCollider(box, turns, 48, -96);
      const corners = [box.min[0], box.max[0]].flatMap(x => [box.min[1], box.max[1]].flatMap(y => [box.min[2], box.max[2]].map(z => rotated([x, y, z], turns))));
      for (let axis = 0; axis < 3; axis++) {
        const translation = axis === 0 ? 48 : axis === 2 ? -96 : 0;
        expect(result.min[axis]).toBeCloseTo(Math.min(...corners.map(c => c[axis])) + translation, 10);
        expect(result.max[axis]).toBeCloseTo(Math.max(...corners.map(c => c[axis])) + translation, 10);
      }
    }
    expect(transformCollider(box, 1)).toEqual({ min: [-2, 0.25, 5], max: [4, 3, 7] });
    expect(box).toEqual({ min: [-7, 0.25, -2], max: [-5, 3, 4] });
  });

  test("centered cells have inclusive lower and exclusive upper boundaries", () => {
    const examples = [[-48.001, -2], [-48, -1], [-16.001, -1], [-16, 0], [-0, 0], [0, 0], [15.999, 0], [16, 1], [47.999, 1], [48, 2]];
    for (const [position, expected] of examples) {
      expect(chunkAt({ x: position, z: position })).toEqual({ x: expected, z: expected });
    }
    expect(chunkAt({ x: -5, z: 5 }, 10)).toEqual({ x: 0, z: 1 });
    expect(chunkAt({ x: 2 ** 40 * 32, z: -(2 ** 40) * 32 })).toEqual({ x: 2 ** 40, z: -(2 ** 40) });
  });

  test("nonfinite positions, invalid cell sizes and unsafe grid coordinates reject", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => chunkAt({ x: bad, z: 0 })).toThrow(RangeError);
      expect(() => chunkAt({ x: 0, z: bad })).toThrow(RangeError);
    }
    for (const size of [0, -1, NaN, Infinity, -Infinity]) {
      expect(() => chunkAt({ x: 0, z: 0 }, size)).toThrow(RangeError);
    }
    expect(() => chunkAt({ x: Number.MAX_VALUE, z: 0 })).toThrow(RangeError);
    expect(() => transformCollider(gallery.colliders[0], 0.5)).toThrow(RangeError);
  });
});
