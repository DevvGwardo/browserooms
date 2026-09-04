import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { StreamedWorld } from "./streamed-world";
import type { Chunk } from "./world-layout";

export type PropDef = {
  file: string;
  footprint: [number, number]; // width, depth in meters
  height: number;
  yOffset: number;
  scale: [number, number, number];
};

// Every mesh is an OpenClawWorld GLB (public/models/items/). Footprints are
// conservative hand measurements so props never pretend to fit where they cannot.
export const PROP_DEFS: PropDef[] = [
  { file: "chair", footprint: [0.6, 0.6], height: 1.0, yOffset: 0, scale: [1, 1, 1] },
  { file: "table", footprint: [1.7, 1.0], height: 0.8, yOffset: 0, scale: [1, 1, 1] },
  { file: "plant", footprint: [0.5, 0.5], height: 1.2, yOffset: 0, scale: [1, 1, 1] },
  { file: "rugRectangle", footprint: [2.4, 1.7], height: 0.06, yOffset: 0.02, scale: [1, 1, 1] },
  { file: "radio", footprint: [0.5, 0.35], height: 0.3, yOffset: 0, scale: [1, 1, 1] },
  { file: "cardboardBoxClosed", footprint: [0.65, 0.65], height: 0.65, yOffset: 0, scale: [1, 1, 1] },
  { file: "sideTable", footprint: [0.55, 0.55], height: 0.7, yOffset: 0, scale: [1, 1, 1] },
  { file: "books", footprint: [0.45, 0.35], height: 0.25, yOffset: 0, scale: [1, 1, 1] },
  { file: "lampSquareFloor", footprint: [0.45, 0.45], height: 1.7, yOffset: 0, scale: [1, 1, 1] },
  { file: "bench", footprint: [1.3, 0.55], height: 0.6, yOffset: 0, scale: [1, 1, 1] },
];

export const MAX_PROPS_PER_CHUNK = 3;

export type Placement = {
  anchorIndex: number;
  def: PropDef;
  position: [number, number, number];
  yaw: number;
};

function hashSeed(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}

function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pure placement solver: deterministic per chunk, floor anchors only, every
 * prop's footprint must fit the anchor clearance. No three.js — unit-tested.
 */
export function placementsForChunk(
  chunkId: string,
  anchors: Chunk["anchors"],
  defs: PropDef[] = PROP_DEFS,
  max = MAX_PROPS_PER_CHUNK,
): Placement[] {
  const rand = mulberry(hashSeed(`props:${chunkId}`));
  const floors = anchors
    .map((anchor, index) => ({ anchor, index }))
    .filter(({ anchor }) => anchor.kind === "floor");
  // Deterministic shuffle so sparse anchors still vary which slots fill.
  for (let i = floors.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [floors[i], floors[j]] = [floors[j], floors[i]];
  }
  const out: Placement[] = [];
  for (const { anchor, index } of floors) {
    if (out.length >= max) break;
    if (rand() > 0.42) continue; // most rooms stay empty — the horror is emptiness
    const [cx, cy, cz] = anchor.clearance;
    const fitting = defs.filter(
      (def) => def.footprint[0] <= cx && def.footprint[1] <= cz && def.height <= cy,
    );
    if (!fitting.length) continue;
    const def = fitting[Math.floor(rand() * fitting.length)];
    out.push({
      anchorIndex: index,
      def,
      position: [anchor.position[0], anchor.position[1] + def.yOffset, anchor.position[2]],
      yaw: anchor.yaw + (rand() - 0.5) * 0.6,
    });
  }
  return out;
}

/** Streams OpenClawWorld clutter into loaded chunks; unloads with the chunk. */
export class Props {
  private cache = new Map<string, Promise<THREE.Object3D>>();
  private loader = new GLTFLoader();
  private placedCount = 0;
  private chunkCount = 0;

  constructor(private getWorld: () => StreamedWorld) {}

  attach() {
    const world = this.getWorld();
    world.addEventListener("chunkload", (event) => {
      void this.fill(event as { definition: Chunk; object: THREE.Object3D });
    });
  }

  private model(file: string): Promise<THREE.Object3D> {
    let pending = this.cache.get(file);
    if (!pending) {
      pending = this.loader
        .loadAsync(`models/items/${file}.glb`)
        .then((gltf) => {
          gltf.scene.traverse((node) => {
            if (node instanceof THREE.Mesh) node.castShadow = false;
          });
          return gltf.scene as THREE.Object3D;
        })
        .catch(() => new THREE.Group()); // a missing prop is invisible, never fatal
      this.cache.set(file, pending);
    }
    return pending;
  }

  private async fill(chunk: { definition: Chunk; object: THREE.Object3D }) {
    const placements = placementsForChunk(chunk.definition.id, chunk.definition.anchors);
    if (!placements.length) return;
    this.chunkCount++;
    for (const placement of placements) {
      const source = await this.model(placement.def.file);
      if (!source || source.children.length === 0) continue;
      const node = source.clone(true);
      node.position.fromArray(placement.position);
      node.rotation.y = placement.yaw;
      node.scale.fromArray(placement.def.scale);
      chunk.object.add(node);
      this.placedCount++;
    }
  }

  get diagnostics() {
    return { chunksDecorated: this.chunkCount, propsPlaced: this.placedCount, modelsCached: this.cache.size };
  }
}
