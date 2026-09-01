import * as THREE from "three";
import type { StreamedWorld } from "./streamed-world";

const CELL = 0.25;
const RANGE = 18;
const MAX_CHUNKS = 64;
const FLOOR = 1;
const WALL = 2;
const TRAIL = 4;
type Patch = { cells: Uint8Array; touched: number; floor: number; wall: number; trail: number };
type Position = { x: number; z: number; cx: number; cz: number };

export class ExplorationMap {
  private context: CanvasRenderingContext2D | null;
  private patches = new Map<string, Patch>();
  private boxes: THREE.Box3[] = [];
  private source: StreamedWorld["colliders"] | null = null;
  private ray = new THREE.Ray();
  private point = new THREE.Vector3();
  private projected = new THREE.Vector3();
  private hit = new THREE.Vector3();
  private closest = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private previous: Position | null = null;
  private nextUpdate = 0;
  private updates = 0;
  private lastMs = 0;
  private maxMs = 0;
  private breaks = 0;
  private side: number;

  constructor(private canvas: HTMLCanvasElement, private world: StreamedWorld) {
    this.context = canvas.getContext("2d");
    this.side = world.kit.cellSize / CELL;
  }

  resetTrail() {
    this.previous = null;
    this.nextUpdate = 0;
    this.breaks++;
  }

  private mark(x: number, z: number, flag: number) {
    const size = this.world.kit.cellSize;
    const dx = Math.floor((x + size / 2) / size);
    const dz = Math.floor((z + size / 2) / size);
    // Keep sub-meter positions separate from chunk integers, even at distant origins.
    const key = `${this.world.origin.x + dx},${this.world.origin.z + dz}`;
    let patch = this.patches.get(key);
    if (!patch) {
      if (this.patches.size >= MAX_CHUNKS) {
        let oldest = "";
        let age = Infinity;
        for (const [id, candidate] of this.patches) {
          if (candidate.touched < age) { oldest = id; age = candidate.touched; }
        }
        this.patches.delete(oldest);
      }
      patch = { cells: new Uint8Array(this.side ** 2), touched: 0, floor: 0, wall: 0, trail: 0 };
      this.patches.set(key, patch);
    }
    patch.touched = this.updates;
    const ix = Math.floor((x - dx * size + size / 2) / CELL);
    const iz = Math.floor((z - dz * size + size / 2) / CELL);
    const index = iz * this.side + ix;
    if (!(patch.cells[index] & flag)) {
      patch.cells[index] |= flag;
      if (flag === FLOOR) patch.floor++;
      if (flag === WALL) patch.wall++;
      if (flag === TRAIL) patch.trail++;
    }
  }

  update(time: number, camera: THREE.PerspectiveCamera, enabled: boolean) {
    const visible = enabled && !document.hidden && document.hasFocus() && !!this.context;
    this.canvas.hidden = !visible;
    if (!visible) { this.previous = null; this.nextUpdate = 0; return; }
    if (time < this.nextUpdate) return;
    this.nextUpdate = time + 125;
    const started = performance.now();
    this.updates++;
    const size = this.world.kit.cellSize;
    const position = camera.position;
    camera.updateMatrixWorld();
    if (this.source !== this.world.colliders) {
      this.source = this.world.colliders;
      this.boxes = this.source.map(box => new THREE.Box3(
        new THREE.Vector3().fromArray(box.min), new THREE.Vector3().fromArray(box.max)));
    }
    const nearby = this.boxes.filter(box => box.max.x >= position.x - RANGE && box.min.x <= position.x + RANGE
      && box.max.z >= position.z - RANGE && box.min.z <= position.z + RANGE);
    nearby.sort((a, b) => a.distanceToPoint(position) - b.distanceToPoint(position));
    this.ray.origin.copy(position);
    const cast = (limit: number) => {
      let nearest: THREE.Box3 | null = null;
      let distance = limit;
      for (const box of nearby) {
        if (!this.ray.intersectBox(box, this.hit)) continue;
        const hitDistance = this.hit.distanceToSquared(position);
        if (hitDistance >= distance * distance) continue;
        distance = Math.sqrt(hitDistance);
        this.closest.copy(this.hit);
        nearest = box;
      }
      // A seen lintel is not a wall at floor level. Never fill its doorway.
      if (nearest && nearest.min.y < 0.1 && nearest.max.y > 0.15) {
        this.mark(this.closest.x + this.ray.direction.x * 0.015,
          this.closest.z + this.ray.direction.z * 0.015, WALL);
      }
      return nearest;
    };

    // Test floor-cell centers against the rendered frustum and full-height 3D boxes.
    // Unlike a radial reveal, this leaves the unseen floor behind half-walls dark.
    const minX = Math.floor((position.x - RANGE) / CELL);
    const maxX = Math.ceil((position.x + RANGE) / CELL);
    const minZ = Math.floor((position.z - RANGE) / CELL);
    const maxZ = Math.ceil((position.z + RANGE) / CELL);
    for (let iz = minZ; iz <= maxZ; iz++) {
      for (let ix = minX; ix <= maxX; ix++) {
        this.point.set((ix + 0.5) * CELL, 0.025, (iz + 0.5) * CELL);
        const distance = this.point.distanceTo(position);
        if (distance > RANGE) continue;
        this.projected.copy(this.point).project(camera);
        if (Math.abs(this.projected.x) > 0.99 || Math.abs(this.projected.y) > 0.99
          || this.projected.z < -1 || this.projected.z > 1) continue;
        this.ray.direction.copy(this.point).sub(position).normalize();
        if (!cast(distance)) this.mark(this.point.x, this.point.z, FLOOR);
      }
    }
    // Additional camera-plane samples trace wall faces when their feet are offscreen.
    // Upward rays are deliberately omitted rather than seeing through unboxed ceilings.
    for (let y = -0.98; y <= 0.99; y += 0.245) {
      for (let x = -0.98; x <= 0.99; x += 0.0245) {
        this.point.set(x, y, 0.5).unproject(camera);
        this.ray.direction.copy(this.point).sub(position).normalize();
        if (this.ray.direction.y > 0) continue;
        const floorDistance = this.ray.direction.y < 0 ? (0.025 - position.y) / this.ray.direction.y : Infinity;
        cast(Math.min(RANGE, floorDistance));
      }
    }

    const previous = this.previous;
    let distance = Infinity;
    if (previous) {
      const dx = (this.world.origin.x - previous.cx) * size + position.x - previous.x;
      const dz = (this.world.origin.z - previous.cz) * size + position.z - previous.z;
      distance = Math.hypot(dx, dz);
      if (distance >= CELL / 2 && distance < 2) {
        const steps = Math.ceil(distance / (CELL / 2));
        for (let i = 0; i <= steps; i++) this.mark(position.x - dx * i / steps, position.z - dz * i / steps, TRAIL);
      }
    }
    if (distance >= CELL / 2) {
      this.previous = { x: position.x, z: position.z, cx: this.world.origin.x, cz: this.world.origin.z };
    }
    this.draw(camera);
    this.lastMs = performance.now() - started;
    this.maxMs = Math.max(this.maxMs, this.lastMs);
  }

  private draw(camera: THREE.PerspectiveCamera) {
    const context = this.context!;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const ratio = Math.min(devicePixelRatio, 2);
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const scale = 6;
    const size = this.world.kit.cellSize;
    const px = camera.position.x;
    const pz = camera.position.z;
    // Only visit tiles intersecting this fixed-size local viewport, never all history.
    for (const [flag, color] of [[FLOOR, "#e9e9c72e"], [TRAIL, "#e9e3a67a"], [WALL, "#f0f0e7c7"]] as const) {
      context.fillStyle = color;
      context.beginPath();
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const patch = this.patches.get(`${this.world.origin.x + dx},${this.world.origin.z + dz}`);
          if (!patch) continue;
          const left = dx * size - size / 2;
          const top = dz * size - size / 2;
          const x0 = Math.max(0, Math.floor((px - width / scale / 2 - left) / CELL));
          const x1 = Math.min(this.side, Math.ceil((px + width / scale / 2 - left) / CELL));
          const z0 = Math.max(0, Math.floor((pz - height / scale / 2 - top) / CELL));
          const z1 = Math.min(this.side, Math.ceil((pz + height / scale / 2 - top) / CELL));
          for (let z = z0; z < z1; z++) {
            for (let x = x0; x < x1; x++) {
              if (!(patch.cells[z * this.side + x] & flag)) continue;
              context.rect(width / 2 + (left + x * CELL - px) * scale,
                height / 2 + (top + z * CELL - pz) * scale, CELL * scale, CELL * scale);
            }
          }
        }
      }
      context.fill();
    }
    camera.getWorldDirection(this.forward);
    context.translate(width / 2, height / 2);
    context.rotate(Math.atan2(this.forward.x, -this.forward.z));
    context.beginPath();
    context.moveTo(0, -5);
    context.lineTo(3.5, 4);
    context.lineTo(0, 2);
    context.lineTo(-3.5, 4);
    context.closePath();
    context.fillStyle = "#eee9a6";
    context.strokeStyle = "#191a14";
    context.lineWidth = 1.5;
    context.stroke();
    context.fill();
  }

  get diagnostics() {
    return {
      visible: !this.canvas.hidden, chunks: this.patches.size, maxChunks: MAX_CHUNKS,
      cellMeters: CELL, rangeMeters: RANGE, updates: this.updates, lastMs: this.lastMs, maxMs: this.maxMs,
      trailBreaks: this.breaks,
      patches: [...this.patches].map(([chunk, patch]) => ({ chunk, floor: patch.floor, wall: patch.wall, trail: patch.trail })),
    };
  }
}
