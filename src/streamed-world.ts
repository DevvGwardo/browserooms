import * as THREE from "three";
import { chunkAt, chunkFingerprint, describeChunk, transformCollider, type Kit, type LightEmitter } from "./world-layout";
import type { Collider } from "./collision";

type LoadedChunk = {
  definition: ReturnType<typeof describeChunk>;
  object: THREE.Object3D;
};

export class StreamedWorld extends THREE.EventDispatcher<{ chunkload: LoadedChunk; chunkunload: LoadedChunk }> {
  readonly root = new THREE.Group();
  readonly radius = 2;
  readonly loaded = new Map<string, LoadedChunk>();
  readonly origin = { x: 0, z: 0 };
  colliders: Collider[] = [];
  lights: LightEmitter[] = [];
  transitions = 0;
  private initialized = false;

  constructor(readonly kit: Kit, readonly seed: string, private prototypes: Map<string, THREE.Object3D>) {
    super();
    const validLayout = kit.version === 1 ? kit.cellSize === 32
      : kit.version === 2 && kit.layout === "continuous" && kit.cellSize === 36
        && Array.isArray(kit.boundaryPassages) && kit.boundaryPassages.length === 3
        && kit.boundaryPassages.every((passage, index, passages) => passage
          && Number.isFinite(passage.min) && Number.isFinite(passage.max)
          && passage.min < passage.max && passage.min >= -kit.cellSize / 2
          && passage.max <= kit.cellSize / 2
          && (index === 0 || passage.min >= passages[index - 1].max));
    if (!validLayout || !kit.templates.length
      || new Set(kit.templates.map((template) => template.id)).size !== kit.templates.length) {
      throw new Error("Invalid architecture kit");
    }
    for (const template of kit.templates) {
      if (!prototypes.has(template.id)) throw new Error(`Missing room module: ${template.id}`);
    }
    this.prototypes = new Map(prototypes);
    this.root.name = "Streamed architecture";
    this.setOrigin(0, 0);
  }

  /**
   * Restart the endless world under a new seed without replacing this object,
   * so every live system holding this world (flicker, alarm, entity, props)
   * keeps reading fresh colliders, lights, and chunk events.
   */
  reseed(seed: string) {
    describeChunk(seed, 0, 0, this.kit);
    (this as { seed: string }).seed = seed;
    for (const [, chunk] of this.loaded) {
      this.root.remove(chunk.object);
      chunk.object.clear();
    }
    this.loaded.clear();
    this.colliders = [];
    this.lights = [];
    this.initialized = false;
    this.setOrigin(0, 0);
  }

  setOrigin(x: number, z: number) {    // Validate before changing the current scene so a bad destination cannot strand the player.
    describeChunk(this.seed, x, z, this.kit);
    describeChunk(this.seed, x - this.radius, z - this.radius, this.kit);
    describeChunk(this.seed, x + this.radius, z + this.radius, this.kit);
    if (this.initialized && x === this.origin.x && z === this.origin.z) return;
    const wanted = new Set<string>();
    for (let dz = -this.radius; dz <= this.radius; dz++) {
      for (let dx = -this.radius; dx <= this.radius; dx++) wanted.add(`${x + dx},${z + dz}`);
    }
    const outgoing = [...this.loaded.entries()].filter(([key]) => !wanted.has(key));
    for (const [, chunk] of outgoing) this.dispatchEvent({ type: "chunkunload", ...chunk });
    for (const [key, chunk] of outgoing) {
      this.root.remove(chunk.object);
      // Geometry/materials belong to the finite prototype kit, not to individual chunks.
      chunk.object.clear();
      this.loaded.delete(key);
    }
    if (this.initialized) this.transitions++;
    this.initialized = true;
    this.origin.x = x;
    this.origin.z = z;
    const incoming: LoadedChunk[] = [];
    for (const key of wanted) {
      const [cx, cz] = key.split(",").map(Number);
      let chunk = this.loaded.get(key);
      if (!chunk) {
        const definition = describeChunk(this.seed, cx, cz, this.kit);
        const prototype = this.prototypes.get(definition.templateId);
        const object = new THREE.Group();
        const architecture = prototype!.clone(true);
        architecture.rotation.y = definition.quarterTurns * Math.PI / 2;
        object.add(architecture);
        object.name = definition.id;
        object.userData.chunkId = definition.id;
        chunk = { definition, object };
        this.loaded.set(key, chunk);
        this.root.add(object);
        object.position.set((cx - x) * this.kit.cellSize, 0, (cz - z) * this.kit.cellSize);
        incoming.push(chunk);
      }
      chunk.object.position.set((cx - x) * this.kit.cellSize, 0, (cz - z) * this.kit.cellSize);
    }
    this.colliders = [];
    this.lights = [];
    for (const chunk of this.loaded.values()) {
      const definition = chunk.definition;
      if (Math.abs(definition.x - x) > 1 || Math.abs(definition.z - z) > 1) continue;
      const template = this.kit.templates.find((candidate) => candidate.id === definition.templateId)!;
      for (const box of template.colliders) {
        this.colliders.push(transformCollider(box, definition.quarterTurns,
          (definition.x - x) * this.kit.cellSize, (definition.z - z) * this.kit.cellSize));
      }
      for (const light of definition.lights) {
        this.lights.push({ id: light.id, position: [
          light.position[0] + (definition.x - x) * this.kit.cellSize,
          light.position[1],
          light.position[2] + (definition.z - z) * this.kit.cellSize,
        ] });
      }
    }
    for (const chunk of incoming) this.dispatchEvent({ type: "chunkload", ...chunk });
  }

  update(position: THREE.Vector3) {
    const crossed = chunkAt(position, this.kit.cellSize);
    if (crossed.x === 0 && crossed.z === 0) return null;
    this.setOrigin(this.origin.x + crossed.x, this.origin.z + crossed.z);
    position.x -= crossed.x * this.kit.cellSize;
    position.z -= crossed.z * this.kit.cellSize;
    // Apply this same shift to any future simulation state not parented to a chunk.
    return { x: -crossed.x * this.kit.cellSize || 0, z: -crossed.z * this.kit.cellSize || 0 };
  }

  spawnAt(x: number, z: number) {
    this.setOrigin(x, z);
    const chunk = this.loaded.get(`${x},${z}`)!.definition;
    const template = this.kit.templates.find((candidate) => candidate.id === chunk.templateId)!;
    const position = new THREE.Vector3(...template.spawn.position);
    position.applyAxisAngle(new THREE.Vector3(0, 1, 0), chunk.quarterTurns * Math.PI / 2);
    return { position: position.toArray() as [number, number, number],
      yaw: template.spawn.yaw + chunk.quarterTurns * Math.PI / 2, pitch: template.spawn.pitch };
  }

  get current() { return this.loaded.get(`${this.origin.x},${this.origin.z}`)!.definition; }

  get stats() {
    return {
      seed: this.seed,
      chunk: { ...this.origin },
      chunkId: this.current.id,
      template: this.current.templateId,
      region: this.current.region,
      quarterTurns: this.current.quarterTurns,
      fingerprint: chunkFingerprint(this.current),
      loadedChunks: this.loaded.size,
      maxLoadedChunks: (this.radius * 2 + 1) ** 2,
      collisionBoxes: this.colliders.length,
      loadedAnchors: [...this.loaded.values()].reduce((sum, chunk) => sum + chunk.definition.anchors.length, 0),
      transitions: this.transitions,
    };
  }
}
