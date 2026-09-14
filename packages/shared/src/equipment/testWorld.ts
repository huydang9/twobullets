import type { Vec3 } from "../movement/types";
import type { RayHit, RaycastFn } from "../weapons/types";

// Analytic collision world for equipment tests: one-sided planes (optionally bounded in XZ) and solid boxes.
// Like Havok, rays starting inside a box don't hit it.

export interface TestPlane {
  readonly kind: "plane";
  /** Unit normal. */
  readonly normal: Vec3;
  /** Any point on the plane. */
  readonly point: Vec3;
  readonly bounds?: { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number };
}

export interface TestBox {
  readonly kind: "box";
  readonly min: Vec3;
  readonly max: Vec3;
}

export type TestShape = TestPlane | TestBox;

export const GROUND: TestPlane = { kind: "plane", normal: { x: 0, y: 1, z: 0 }, point: { x: 0, y: 0, z: 0 } };

export function box(min: [number, number, number], max: [number, number, number]): TestBox {
  return { kind: "box", min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } };
}

export function createTestRaycast(shapes: readonly TestShape[], stats?: { calls: number }): RaycastFn {
  return (from, to) => {
    if (stats) stats.calls++;
    const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    let best: RayHit | null = null;
    for (const shape of shapes) {
      const hit = shape.kind === "plane" ? rayPlane(from, d, shape) : rayBox(from, d, shape);
      if (hit && (!best || hit.fraction < best.fraction)) best = hit;
    }
    return best;
  };
}

function rayPlane(from: Vec3, d: Vec3, plane: TestPlane): RayHit | null {
  const n = plane.normal;
  const denom = d.x * n.x + d.y * n.y + d.z * n.z;
  if (denom >= 0) return null;
  const t = ((plane.point.x - from.x) * n.x + (plane.point.y - from.y) * n.y + (plane.point.z - from.z) * n.z) / denom;
  if (t < 0 || t > 1) return null;
  const point = { x: from.x + d.x * t, y: from.y + d.y * t, z: from.z + d.z * t };
  const b = plane.bounds;
  if (b && (point.x < b.minX || point.x > b.maxX || point.z < b.minZ || point.z > b.maxZ)) return null;
  return { point, normal: n, fraction: t, colliderId: null };
}

function rayBox(from: Vec3, d: Vec3, shape: TestBox): RayHit | null {
  let tMin = -Infinity;
  let tMax = Infinity;
  let axis = -1;
  let sign = 0;
  const o = [from.x, from.y, from.z];
  const dir = [d.x, d.y, d.z];
  const lo = [shape.min.x, shape.min.y, shape.min.z];
  const hi = [shape.max.x, shape.max.y, shape.max.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dir[a]!) < 1e-12) {
      if (o[a]! < lo[a]! || o[a]! > hi[a]!) return null;
      continue;
    }
    let t1 = (lo[a]! - o[a]!) / dir[a]!;
    let t2 = (hi[a]! - o[a]!) / dir[a]!;
    let s = -1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      s = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      axis = a;
      sign = s;
    }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (axis < 0 || tMin < 0 || tMin > 1) return null;
  const normal = { x: axis === 0 ? sign : 0, y: axis === 1 ? sign : 0, z: axis === 2 ? sign : 0 };
  return { point: { x: from.x + d.x * tMin, y: from.y + d.y * tMin, z: from.z + d.z * tMin }, normal, fraction: tMin, colliderId: null };
}
