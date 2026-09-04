// Pure Entity AI core — zero three.js, fully unit-tested.
// The three.js presentation/audio wrapper lives in entity.ts and delegates here.

export type Vec2 = { x: number; z: number };
export type Box = { min: number[]; max: number[] };
export type Mode = "stalk" | "chase" | "stunned";

export const SIGHT_CLOSE = 4.5; // always seen this close with line of sight
export const SIGHT_BASE = 7; // dark, quiet, unzoomed
export const SIGHT_ZOOMED = 17; // camcorder zoom pointed elsewhere still reveals you
export const HEAR_SPRINT = 13; // player speed above SPRINT_SPEED is loud
export const SPRINT_SPEED = 2.6;
export const STUN_RANGE = 9;
export const STUN_TIME = 2.2; // seconds of held gaze to stun
export const STUN_DURATION = 4;
export const CATCH_RANGE = 1.2;
export const LOSE_AFTER = 7; // seconds without sense contact before giving up

/** 2D segment vs AABB slab test. Only boxes spanning eye height block sight. */
export function segmentBlocked(ax: number, az: number, bx: number, bz: number, boxes: Box[]): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  for (const box of boxes) {
    if (box.min[1] >= 1.8 || box.max[1] <= 0.1) continue;
    const minX = box.min[0];
    const maxX = box.max[0];
    const minZ = box.min[2];
    const maxZ = box.max[2];
    let tmin = 0;
    let tmax = 1;
    if (Math.abs(dx) < 1e-9) {
      if (ax < minX || ax > maxX) continue;
    } else {
      let t1 = (minX - ax) / dx;
      let t2 = (maxX - ax) / dx;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    if (Math.abs(dz) < 1e-9) {
      if (az < minZ || az > maxZ) continue;
    } else {
      let t1 = (minZ - az) / dz;
      let t2 = (maxZ - az) / dz;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    // Ignore intersections flush with the endpoints (sharing the entity/player cell).
    if (tmax > 0.02 && tmin < 0.98) return true;
  }
  return false;
}

export function pointBlocked(x: number, z: number, boxes: Box[], radius: number): boolean {
  for (const box of boxes) {
    if (box.min[1] >= 1.8 || box.max[1] <= 0.1) continue;
    const cx = Math.max(box.min[0], Math.min(x, box.max[0]));
    const cz = Math.max(box.min[2], Math.min(z, box.max[2]));
    if (Math.hypot(x - cx, z - cz) < radius) return true;
  }
  return false;
}

export interface SenseInput {
  entity: Vec2;
  player: Vec2;
  playerSpeed: number;
  zoom: number; // camcorder magnification, 1 = none
  gazeDot: number; // camera-forward · direction-to-entity, -1..1
  boxes: Box[];
}

export interface SenseResult {
  seen: boolean;
  heard: boolean;
  blocked: boolean;
  dist: number;
}

export function sense(input: SenseInput): SenseResult {
  const dist = Math.hypot(input.player.x - input.entity.x, input.player.z - input.entity.z);
  const blocked = segmentBlocked(input.entity.x, input.entity.z, input.player.x, input.player.z, input.boxes);
  const range = dist < SIGHT_CLOSE ? Infinity : input.zoom > 1.5 ? SIGHT_ZOOMED : SIGHT_BASE;
  return {
    seen: !blocked && dist < range,
    heard: input.playerSpeed > SPRINT_SPEED && dist < HEAR_SPRINT,
    blocked,
    dist,
  };
}

export type BrainEvent = "spotted" | "lost" | "stunned" | "recovered" | "caught";

export class EntityBrain {
  mode: Mode = "stalk";
  pos: Vec2;
  wanderTarget: Vec2 | null = null;
  stunMeter = 0;
  private loseTimer = 0;
  private stunTimer = 0;
  private wanderTimer = 0;

  constructor(start: Vec2) {
    this.pos = { ...start };
  }

  reset(start: Vec2) {
    this.mode = "stalk";
    this.pos = { ...start };
    this.wanderTarget = null;
    this.stunMeter = 0;
    this.loseTimer = 0;
    this.stunTimer = 0;
    this.wanderTimer = 0;
  }

  /**
   * Advance the state machine. Returns events for the presentation layer
   * (audio stings, overlays) and the current steering target, if any.
   * Movement integration stays with the caller so bun tests never need three.js.
   */
  update(
    dt: number,
    sensed: SenseResult,
    gazeHeld: boolean, // facing + zoomed + in range + unblocked
    player: Vec2,
  ): { events: BrainEvent[]; steer: Vec2 | null } {
    const events: BrainEvent[] = [];
    const dist = sensed.dist;

    if (this.mode === "stunned") {
      this.stunTimer -= dt;
      if (this.stunTimer <= 0) {
        this.mode = "stalk";
        this.wanderTarget = null;
        events.push("recovered");
      }
      return { events, steer: null };
    }

    if (gazeHeld && this.mode === "chase") {
      this.stunMeter += dt;
      if (this.stunMeter >= STUN_TIME) {
        this.stunMeter = 0;
        this.mode = "stunned";
        this.stunTimer = STUN_DURATION;
        events.push("stunned");
        return { events, steer: null };
      }
    } else {
      this.stunMeter = Math.max(0, this.stunMeter - dt);
    }

    if (this.mode === "stalk") {
      if (sensed.seen || sensed.heard) {
        this.mode = "chase";
        this.loseTimer = 0;
        events.push("spotted");
        return { events, steer: { ...player } };
      }
      this.wanderTimer -= dt;
      if (!this.wanderTarget || this.wanderTimer <= 0) return { events, steer: null };
      return { events, steer: { ...this.wanderTarget } };
    }

    // chase
    if (dist < CATCH_RANGE) {
      events.push("caught");
      return { events, steer: { ...player } };
    }
    if (sensed.seen || sensed.heard) {
      this.loseTimer = 0;
    } else {
      this.loseTimer += dt;
      if (this.loseTimer >= LOSE_AFTER) {
        this.loseTimer = 0;
        this.mode = "stalk";
        this.wanderTarget = null;
        events.push("lost");
        return { events, steer: null };
      }
    }
    return { events, steer: { ...player } };
  }

  requestWander(target: Vec2, inSeconds: number) {
    this.wanderTarget = { ...target };
    this.wanderTimer = inSeconds;
  }

  get threat(): number {
    return this.mode === "chase" ? 1 : this.mode === "stunned" ? 0.1 : 0;
  }
}
