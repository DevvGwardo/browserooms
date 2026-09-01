export type Point = { x: number; z: number };
export type Collider = { min: number[]; max: number[] };

/** Small bounded steps prevent tunneling; closest-point resolution keeps doorways rounded. */
export function movePlayer(position: Point, dx: number, dz: number, colliders: Collider[], radius = 0.24): Point {
  const next = { ...position };
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (radius * 0.4)));
  for (let step = 0; step < steps; step++) {
    next.x += dx / steps;
    next.z += dz / steps;
    for (let iteration = 0; iteration < 5; iteration++) {
      let hit = false;
      for (const box of colliders) {
        if (box.min[1] >= 1.8 || box.max[1] <= 0.1) continue;
        const x = Math.max(box.min[0], Math.min(next.x, box.max[0]));
        const z = Math.max(box.min[2], Math.min(next.z, box.max[2]));
        const ox = next.x - x;
        const oz = next.z - z;
        const distance = Math.hypot(ox, oz);
        if (distance >= radius) continue;
        hit = true;
        if (distance > 1e-8) {
          const push = (radius - distance) / distance;
          next.x += ox * push;
          next.z += oz * push;
        } else {
          const sides = [next.x - box.min[0], box.max[0] - next.x, next.z - box.min[2], box.max[2] - next.z];
          const side = sides.indexOf(Math.min(...sides));
          if (side === 0) next.x = box.min[0] - radius;
          if (side === 1) next.x = box.max[0] + radius;
          if (side === 2) next.z = box.min[2] - radius;
          if (side === 3) next.z = box.max[2] + radius;
        }
      }
      if (!hit) break;
    }
  }
  return next;
}
