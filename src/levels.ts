// Level progression — pure config and math, no three.js. The ExitDoor
// presentation/audio wrapper lives in exit-door.ts and consumes this.

export type LevelDef = {
  name: string;
  hint: string;
  /** scene.background + fog color */
  fog: number;
  entitySpeed: number;
  seedPrefix: string;
};

export const LEVELS: LevelDef[] = [
  {
    name: "Level 0 — The Lobby",
    hint: "Find the glowing exit door. Something walks here.",
    fog: 0x302a15,
    entitySpeed: 3.0,
    seedPrefix: "L0",
  },
  {
    name: "Level 1 — Concrete Garage",
    hint: "Colder light. It is faster here. Keep moving.",
    fog: 0x23282a,
    entitySpeed: 3.2,
    seedPrefix: "L1",
  },
  {
    name: "Level 2 — Pipe Dreams",
    hint: "It knows the sound of your camcorder. Break line of sight.",
    fog: 0x141a14,
    entitySpeed: 3.35,
    seedPrefix: "L2",
  },
];

/** Fixed far chunk holding the exit — same relative address every run, new maze every level. */
export const EXIT_CHUNK = { x: 5, z: -3 };

export function levelSeed(baseSeed: string, level: number): string {
  return `${LEVELS[level % LEVELS.length].seedPrefix}:${baseSeed}`;
}

/** Origin-relative world position of a chunk's center under the floating origin. */
export function exitChunkCenter(
  origin: { x: number; z: number },
  cellSize: number,
  chunk: { x: number; z: number } = EXIT_CHUNK,
): { x: number; z: number } {
  return { x: (chunk.x - origin.x) * cellSize, z: (chunk.z - origin.z) * cellSize };
}

export type Box = { min: number[]; max: number[] };

function blockedAt(x: number, z: number, boxes: Box[], radius: number): boolean {
  for (const box of boxes) {
    if (box.min[1] >= 1.8 || box.max[1] <= 0.1) continue;
    const cx = Math.max(box.min[0], Math.min(x, box.max[0]));
    const cz = Math.max(box.min[2], Math.min(z, box.max[2]));
    if (Math.hypot(x - cx, z - cz) < radius) return true;
  }
  return false;
}

/** Spiral out from the chunk center until a standable, reachable-feeling spot. */
export function resolveExitSpot(
  center: { x: number; z: number },
  boxes: Box[],
  radius = 0.6,
): { x: number; z: number } {
  if (!blockedAt(center.x, center.z, boxes, radius)) return { ...center };
  for (let ring = 1; ring <= 24; ring++) {
    const steps = ring * 8;
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const x = center.x + Math.cos(angle) * ring * 0.75;
      const z = center.z + Math.sin(angle) * ring * 0.75;
      if (!blockedAt(x, z, boxes, radius)) return { x, z };
    }
  }
  return { ...center };
}
