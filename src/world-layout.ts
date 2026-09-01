export type Vec3 = [number, number, number];
export type LightEmitter = { id: string; position: Vec3 };

export type WorldTemplate = {
  id: string;
  region?: "large" | "medium" | "small";
  geometry: string;
  radiance: { file: string; family: string; flipY: boolean }[];
  colliders: { min: number[]; max: number[] }[];
  lights: LightEmitter[];
  rooms: { id: string; bounds: { min: number[]; max: number[] } }[];
  anchors: {
    id: string;
    roomId: string;
    kind: "floor" | "wall" | "ceiling";
    position: Vec3;
    yaw: number;
    clearance: Vec3;
  }[];
  spawn: { position: Vec3; yaw: number; pitch: number };
};

export type Kit = {
  templates: WorldTemplate[];
  bake: {
    camera?: { verticalFovDegrees: number; exposureStops: number; viewTransform: string; look: string };
    [key: string]: unknown;
  };
} & ({
  version: 1;
  cellSize: 32;
} | {
  version: 2;
  layout: "continuous";
  cellSize: 36;
  boundaryPassages: { min: number; max: number }[];
});

export type Chunk = {
  id: string;
  x: number;
  z: number;
  templateId: string;
  region: "large" | "medium" | "small";
  quarterTurns: number;
  rooms: WorldTemplate["rooms"];
  anchors: WorldTemplate["anchors"];
  lights: LightEmitter[];
  portals: {
    direction: "north" | "east" | "south" | "west";
    center: Vec3;
    neighborChunkId: string;
    width: number;
    height: number;
  }[];
};

function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  }
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return (value ^ (value >>> 16)) >>> 0;
}

function chunkId(version: Kit["version"], seed: string, x: number | bigint, z: number | bigint): string {
  // JSON escaping also preserves lone UTF-16 surrogates before URI encoding.
  return `world-v${version}:${encodeURIComponent(JSON.stringify(seed))}:${x},${z}`;
}

function rotate(position: number[], quarterTurns: number): Vec3 {
  if (!Number.isSafeInteger(quarterTurns)) throw new RangeError("quarterTurns must be a safe integer");
  const [x, y, z] = position;
  switch (((quarterTurns % 4) + 4) % 4) {
    case 1: return [z || 0, y, -x || 0];
    case 2: return [-x || 0, y, -z || 0];
    case 3: return [-z || 0, y, x || 0];
    default: return [x || 0, y, z || 0];
  }
}

export function transformCollider(
  box: { min: number[]; max: number[] },
  quarterTurns: number,
  offsetX = 0,
  offsetZ = 0,
): { min: Vec3; max: Vec3 } {
  const a = rotate(box.min, quarterTurns);
  const b = rotate(box.max, quarterTurns);
  return {
    min: [Math.min(a[0], b[0]) + offsetX, box.min[1], Math.min(a[2], b[2]) + offsetZ],
    max: [Math.max(a[0], b[0]) + offsetX, box.max[1], Math.max(a[2], b[2]) + offsetZ],
  };
}

export function describeChunk(seed: string, x: number, z: number, kit: Kit): Chunk {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) {
    throw new RangeError("Chunk coordinates must be finite safe integers");
  }
  if (!kit.templates.length) throw new RangeError("Kit must contain at least one template");
  x = x || 0;
  z = z || 0;
  const id = chunkId(kit.version, seed, x, z);
  const home = x === 0 && z === 0;
  const catalog = [...kit.templates].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  let choices = catalog;
  if (kit.version === 2 && ["large", "medium", "small"].every(region => catalog.some(template => template.region === region))) {
    const distance = Math.max(Math.abs(x), Math.abs(z));
    // The introduction tightens gradually; farther out, districts span several floor patches.
    const district = hash(`${seed}:district:${Math.floor(x / 3)},${Math.floor(z / 3)}`) / 2 ** 32;
    const region = distance === 1 ? "medium" : distance === 2 ? "small"
      : district < 0.28 ? "large" : district < 0.64 ? "medium" : "small";
    choices = catalog.filter(template => template.region === region);
  }
  const template = home ? kit.templates[0] : choices[hash(`${id}:template`) % choices.length];
  // Continuous templates share a world-aligned ceiling grid and light lattice.
  const quarterTurns = home || kit.version === 2 ? 0 : hash(`${id}:rotation`) % 4;
  const passages = kit.version === 2 ? kit.boundaryPassages : [{ min: -1.2, max: 1.2 }];
  const portalHeight = kit.version === 2 ? 3 : 2.4;
  const roomId = (relativeId: string) => `${id}/room/${relativeId}`;
  const directions = [
    ["north", 0, -1],
    ["east", 1, 0],
    ["south", 0, 1],
    ["west", -1, 0],
  ] as const;
  return {
    id, x, z, templateId: template.id, region: template.region ?? "large", quarterTurns,
    rooms: template.rooms.map(room => ({
      id: roomId(room.id),
      bounds: transformCollider(room.bounds, quarterTurns),
    })),
    anchors: template.anchors.map(anchor => ({
      ...anchor,
      id: `${id}/anchor/${anchor.id}`,
      roomId: roomId(anchor.roomId),
      position: rotate(anchor.position, quarterTurns),
      yaw: anchor.yaw + quarterTurns * Math.PI / 2,
      clearance: quarterTurns % 2
        ? [anchor.clearance[2], anchor.clearance[1], anchor.clearance[0]]
        : [...anchor.clearance],
    })),
    lights: template.lights.map(light => ({
      id: `${id}/light/${light.id}`,
      position: rotate(light.position, quarterTurns),
    })),
    portals: directions.flatMap(([direction, dx, dz]) => passages.map(({ min, max }) => ({
      direction,
      // Crossing metadata only: opposite faces use the same tangent-axis sign.
      center: [dx === 0 ? (min + max) / 2 : dx * kit.cellSize / 2,
        portalHeight / 2, dz === 0 ? (min + max) / 2 : dz * kit.cellSize / 2] as Vec3,
      // BigInt preserves the exact neighbor ID even at the safe-integer boundary.
      neighborChunkId: chunkId(kit.version, seed, BigInt(x) + BigInt(dx), BigInt(z) + BigInt(dz)),
      width: max - min,
      height: portalHeight,
    }))),
  };
}

export function chunkAt(position: { x: number; z: number }, cellSize = 32): { x: number; z: number } {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.z)
    || !Number.isFinite(cellSize) || cellSize <= 0) {
    throw new RangeError("Position must be finite and cellSize must be finite and positive");
  }
  const x = Math.floor((position.x + cellSize / 2) / cellSize);
  const z = Math.floor((position.z + cellSize / 2) / cellSize);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) {
    throw new RangeError("Position is outside the safe chunk-coordinate range");
  }
  return { x: x || 0, z: z || 0 };
}

export function chunkFingerprint(chunk: Chunk): string {
  return hash(JSON.stringify(chunk)).toString(16).padStart(8, "0");
}
